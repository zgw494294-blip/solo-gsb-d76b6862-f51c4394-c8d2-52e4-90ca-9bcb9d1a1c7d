"""SQLite 持久化层：材料配方、炉次草稿与核准归档。

设计要点：
- 配方（recipe）沿用 /api/schedule 的“单种材料”字段与校验；一个炉次草稿
  按顺序引用 2～3 个不同的现有配方 ID，引用创建后不可修改。
- 草稿每次求解都把「当时的材料参数快照 + 求解结果/无解原因 + 版本」存在
  同一行，读取永远拿到同一版本的参数与结果，不会混用新参数与旧结果。
- 配方整份修改在一个 IMMEDIATE 事务内完成：先改配方，再把所有引用它的
  「未归档」草稿逐一重算、版本 +1；任何一步失败整体回滚，非法修改不改变
  任何数据。已归档炉次不参与重算，保持冻结。
- 所有写操作经同一把可重入锁串行化，配方修改与归档按某一先后顺序整体生效。
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from .solver import Material, solve

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS recipes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL DEFAULT '',
        hold_low   INTEGER NOT NULL,
        hold_high  INTEGER NOT NULL,
        duration   INTEGER NOT NULL,
        tolerance  INTEGER NOT NULL,
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS drafts (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        recipe_ids        TEXT    NOT NULL,  -- 顺序配方 ID 的 JSON 数组，不可改
        version           INTEGER NOT NULL,  -- 从 1 开始，每次联动重算 +1
        status            TEXT    NOT NULL DEFAULT 'draft',  -- draft / archived
        materials         TEXT    NOT NULL,  -- 当前版本求解所用材料参数快照(JSON)
        solvable          INTEGER NOT NULL,
        result            TEXT,              -- 有解时的完整求解结果(JSON)
        reason            TEXT,              -- 无解原因
        archived_version  INTEGER,           -- 归档时冻结的草稿版本
        created_at        TEXT    NOT NULL,
        updated_at        TEXT    NOT NULL,
        archived_at       TEXT
    )
    """,
]

STATUS_DRAFT = "draft"
STATUS_ARCHIVED = "archived"


class StoreNotFound(Exception):
    """资源不存在 → HTTP 404。"""


class StoreConflict(Exception):
    """状态/版本冲突 → HTTP 409。"""


class StoreUnprocessable(Exception):
    """语义不合法 → HTTP 422。"""


def _solve_from_empty(materials: list[Material]) -> dict:
    """从 20°C 空记录求解；求解入口对非法参数抛错时统一转 422。"""
    try:
        return solve(materials)
    except ValueError as exc:  # 理论上配方入库前已校验，此处兜底保证事务回滚
        raise StoreUnprocessable(str(exc)) from exc


def resolve_db_path() -> Path:
    env = os.environ.get("DB_PATH", "").strip()
    if env:
        return Path(env)
    # 容器内（Dockerfile 建好了 /data）；本机裸跑时落到仓库下的 data/
    if os.path.isdir("/data") and os.access("/data", os.W_OK):
        return Path("/data/furnace.db")
    return Path(__file__).resolve().parent.parent / "data" / "furnace.db"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Store:
    def __init__(self, path: str | Path | None = None) -> None:
        path = Path(path) if path else resolve_db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        # 单连接 + 显式事务（autocommit 模式下手动 BEGIN/COMMIT）
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        for ddl in SCHEMA:
            self._conn.execute(ddl)

    # ------------------------------------------------------------------ 工具

    @staticmethod
    def _snapshot(name: str, r: sqlite3.Row) -> dict:
        return {
            "name": name,
            "holdLow": r["hold_low"],
            "holdHigh": r["hold_high"],
            "duration": r["duration"],
            "tolerance": r["tolerance"],
        }

    def _materials_for(self, recipe_ids: list[int]) -> tuple[list[Material], list[dict]]:
        """按 draft 引用顺序取配方，组装 Material 与参数快照。"""
        placeholders = ",".join("?" for _ in recipe_ids)
        rows = {
            r["id"]: r
            for r in self._conn.execute(
                f"SELECT * FROM recipes WHERE id IN ({placeholders})", recipe_ids
            )
        }
        missing = [rid for rid in recipe_ids if rid not in rows]
        if missing:
            raise StoreUnprocessable(
                f"配方不存在：{', '.join(str(x) for x in missing)}。"
            )
        materials: list[Material] = []
        snapshot: list[dict] = []
        for i, rid in enumerate(recipe_ids):
            r = rows[rid]
            # 与 /api/schedule 一致的空名兜底
            name = (r["name"] or "").strip() or f"材料{i + 1}"
            materials.append(
                Material(
                    name=name,
                    hold_low=r["hold_low"],
                    hold_high=r["hold_high"],
                    duration=r["duration"],
                    tolerance=r["tolerance"],
                )
            )
            snapshot.append(self._snapshot(name, r))
        return materials, snapshot

    def _apply_solution(
        self,
        draft_id: int,
        version: int,
        snapshot: list[dict],
        result: dict,
    ) -> None:
        solvable = bool(result.get("solvable"))
        self._conn.execute(
            """
            UPDATE drafts
               SET version=?, materials=?, solvable=?, result=?, reason=?, updated_at=?
             WHERE id=?
            """,
            (
                version,
                json.dumps(snapshot, ensure_ascii=False),
                1 if solvable else 0,
                json.dumps(result, ensure_ascii=False) if solvable else None,
                None if solvable else result.get("reason"),
                _now(),
                draft_id,
            ),
        )

    def _get_recipe_row(self, recipe_id: int) -> sqlite3.Row:
        r = self._conn.execute(
            "SELECT * FROM recipes WHERE id=?", (recipe_id,)
        ).fetchone()
        if r is None:
            raise StoreNotFound(f"配方 {recipe_id} 不存在。")
        return r

    def _get_draft_row(self, draft_id: int) -> sqlite3.Row:
        r = self._conn.execute(
            "SELECT * FROM drafts WHERE id=?", (draft_id,)
        ).fetchone()
        if r is None:
            raise StoreNotFound(f"炉次 {draft_id} 不存在。")
        return r

    def _referenced_draft_ids(self, recipe_id: int) -> list[int]:
        out: list[int] = []
        for r in self._conn.execute("SELECT id, recipe_ids FROM drafts ORDER BY id"):
            if recipe_id in json.loads(r["recipe_ids"]):
                out.append(r["id"])
        return out

    @staticmethod
    def _recipe_out(r: sqlite3.Row, draft_ids: list[int]) -> dict:
        return {
            "id": r["id"],
            "name": r["name"],
            "holdLow": r["hold_low"],
            "holdHigh": r["hold_high"],
            "duration": r["duration"],
            "tolerance": r["tolerance"],
            "createdAt": r["created_at"],
            "updatedAt": r["updated_at"],
            "draftIds": draft_ids,
        }

    @staticmethod
    def _draft_out(r: sqlite3.Row, detail: bool = False) -> dict:
        out = {
            "id": r["id"],
            "status": r["status"],
            "version": r["version"],
            "recipeIds": json.loads(r["recipe_ids"]),
            "solvable": bool(r["solvable"]),
            "reason": r["reason"],
            "materials": json.loads(r["materials"]),
            "archivedVersion": r["archived_version"],
            "createdAt": r["created_at"],
            "updatedAt": r["updated_at"],
            "archivedAt": r["archived_at"],
        }
        if detail:
            out["result"] = json.loads(r["result"]) if r["result"] else None
        return out

    # ---------------------------------------------------------------- 配方

    def create_recipe(self, p: dict) -> dict:
        with self._lock:
            now = _now()
            cur = self._conn.execute(
                """
                INSERT INTO recipes
                    (name, hold_low, hold_high, duration, tolerance, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    p["name"], p["holdLow"], p["holdHigh"], p["duration"],
                    p["tolerance"], now, now,
                ),
            )
            return self._recipe_out(self._get_recipe_row(cur.lastrowid), [])

    def list_recipes(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM recipes ORDER BY id").fetchall()
            return [self._recipe_out(r, self._referenced_draft_ids(r["id"])) for r in rows]

    def get_recipe(self, recipe_id: int) -> dict:
        with self._lock:
            r = self._get_recipe_row(recipe_id)
            return self._recipe_out(r, self._referenced_draft_ids(recipe_id))

    def replace_recipe(self, recipe_id: int, p: dict) -> tuple[dict, list[dict], int]:
        """整份修改配方，并原子重算所有引用它的未归档草稿。

        返回 (新配方, 重算草稿摘要列表, 跳过的已归档炉次数)。
        """
        with self._lock:
            self._get_recipe_row(recipe_id)  # 不存在先抛 404，不动数据
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                now = _now()
                self._conn.execute(
                    """
                    UPDATE recipes
                       SET name=?, hold_low=?, hold_high=?, duration=?,
                           tolerance=?, updated_at=?
                     WHERE id=?
                    """,
                    (
                        p["name"], p["holdLow"], p["holdHigh"], p["duration"],
                        p["tolerance"], now, recipe_id,
                    ),
                )
                row = self._get_recipe_row(recipe_id)

                recalculated: list[dict] = []
                skipped_archived = 0
                drafts = self._conn.execute(
                    "SELECT * FROM drafts ORDER BY id"
                ).fetchall()
                for d in drafts:
                    ids: list[int] = json.loads(d["recipe_ids"])
                    if recipe_id not in ids:
                        continue
                    if d["status"] == STATUS_ARCHIVED:
                        # 已冻结：配方修改只影响未归档炉次
                        skipped_archived += 1
                        continue
                    materials, snapshot = self._materials_for(ids)
                    result = _solve_from_empty(materials)  # 从 20°C 空记录求解
                    new_version = d["version"] + 1
                    self._apply_solution(d["id"], new_version, snapshot, result)
                    recalculated.append(
                        {
                            "id": d["id"],
                            "version": new_version,
                            "solvable": bool(result.get("solvable")),
                            "reason": result.get("reason"),
                        }
                    )
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            return self._recipe_out(row, self._referenced_draft_ids(recipe_id)), \
                recalculated, skipped_archived

    # ---------------------------------------------------------------- 草稿

    def create_draft(self, recipe_ids: list[int]) -> dict:
        with self._lock:
            if not (2 <= len(recipe_ids) <= 3):
                raise StoreUnprocessable("每个炉次必须按顺序引用 2～3 个配方。")
            if len(set(recipe_ids)) != len(recipe_ids):
                raise StoreUnprocessable("同一炉次引用的配方 ID 必须互不相同。")

            self._conn.execute("BEGIN IMMEDIATE")
            try:
                # 不存在的配方在此抛 422，事务回滚，不留任何数据
                materials, snapshot = self._materials_for(recipe_ids)
                result = _solve_from_empty(materials)  # 从 20°C 空记录求解
                solvable = bool(result.get("solvable"))
                now = _now()
                cur = self._conn.execute(
                    """
                    INSERT INTO drafts (
                        recipe_ids, version, status, materials,
                        solvable, result, reason,
                        archived_version, created_at, updated_at, archived_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
                    """,
                    (
                        json.dumps(recipe_ids),
                        1,
                        STATUS_DRAFT,
                        json.dumps(snapshot, ensure_ascii=False),
                        1 if solvable else 0,
                        json.dumps(result, ensure_ascii=False) if solvable else None,
                        None if solvable else result.get("reason"),
                        now,
                        now,
                    ),
                )
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            return self.get_draft(cur.lastrowid)

    def list_drafts(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM drafts ORDER BY id").fetchall()
            return [self._draft_out(r) for r in rows]

    def get_draft(self, draft_id: int) -> dict:
        with self._lock:
            return self._draft_out(self._get_draft_row(draft_id), detail=True)

    def archive_draft(self, draft_id: int, version: int) -> dict:
        """按查看时携带的版本核准归档。"""
        with self._lock:
            d = self._get_draft_row(draft_id)
            if d["status"] == STATUS_ARCHIVED:
                raise StoreConflict(f"炉次 {draft_id} 已归档，不能重复归档。")
            if d["version"] != version:
                raise StoreConflict(
                    f"所查看的版本 v{version} 已过期，炉次 {draft_id} 当前为 "
                    f"v{d['version']}，请刷新查看最新结果后再归档。"
                )
            if not d["solvable"]:
                # 失败不改状态：此处尚未开始任何写事务
                raise StoreUnprocessable(
                    d["reason"] or f"炉次 {draft_id} 当前版本无解，不能归档。"
                )

            self._conn.execute("BEGIN IMMEDIATE")
            try:
                now = _now()
                self._conn.execute(
                    """
                    UPDATE drafts
                       SET status=?, archived_version=?, archived_at=?, updated_at=?
                     WHERE id=?
                    """,
                    (STATUS_ARCHIVED, version, now, now, draft_id),
                )
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            return self.get_draft(draft_id)
