"""配方 / 炉次草稿 / 归档 的持久化操作。

所有公开函数都在进程内全局锁（见 db.lock）与单条 SQLite 事务中完成，
保证「修改配方并重算草稿」「归档」整体原子且按某一先后顺序生效。
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

from .db import connect, lock
from .solver import Material, solve


# ---------------- 异常（路由层映射为 HTTP 状态码） ----------------


class StoreError(Exception):
    status_code = 400


class NotFound(StoreError):
    status_code = 404


class Conflict(StoreError):
    """状态冲突：草稿已归档，或携带的版本已过期（HTTP 409）。"""

    status_code = 409

    def __init__(self, detail: str, current_version: int | None = None):
        super().__init__(detail)
        self.detail = detail
        self.current_version = current_version


class Unprocessable(StoreError):
    """语义上无法处理：引用非法，或待归档草稿当前无解（HTTP 422）。"""

    status_code = 422


# ---------------- 小工具 ----------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)


@contextmanager
def _tx(conn):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def _recipe_dict(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "holdLow": row["hold_low"],
        "holdHigh": row["hold_high"],
        "duration": row["duration"],
        "tolerance": row["tolerance"],
        "version": row["version"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _material_snapshot(row) -> dict:
    """一份配方在某个时刻对应的材料参数（含默认名称）。"""
    return {
        "name": (row["name"] or "").strip() or f"配方{row['id']}",
        "holdLow": row["hold_low"],
        "holdHigh": row["hold_high"],
        "duration": row["duration"],
        "tolerance": row["tolerance"],
    }


def _to_material(row) -> Material:
    snap = _material_snapshot(row)
    return Material(
        name=snap["name"],
        hold_low=snap["holdLow"],
        hold_high=snap["holdHigh"],
        duration=snap["duration"],
        tolerance=snap["tolerance"],
    )


def _draft_dict(row) -> dict:
    """组装炉次草稿读取结构：状态、参数、版本、结果或无解原因。

    活动草稿的 materials 与 result/reason 是同一次求解一起写入的快照；
    已归档草稿则读取归档时冻结的快照，二者绝不会混用。
    """
    recipe_ids = json.loads(row["recipe_ids"])
    archived = row["archive_id"] is not None

    if archived:
        materials = json.loads(row["archived_materials_json"])
        result = json.loads(row["archived_result_json"])
        solvable = True
        reason = None
        recipe_versions = json.loads(row["recipe_versions_json"])
    else:
        materials = json.loads(row["materials_json"])
        solvable = bool(row["solvable"])
        result = json.loads(row["result_json"]) if row["result_json"] else None
        reason = row["reason"]
        recipe_versions = json.loads(row["recipe_versions_json"])

    return {
        "id": row["id"],
        "name": row["name"],
        "status": "archived" if archived else "active",
        "recipeIds": recipe_ids,
        "recipeVersions": recipe_versions,
        "version": row["archived_draft_version"] if archived else row["version"],
        "materials": materials,
        "solvable": solvable,
        "result": result,
        "reason": reason,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "archivedAt": row["archived_at"],
    }


_DRAFT_SELECT = """
SELECT d.*, a.id AS archive_id, a.draft_version AS archived_draft_version,
       a.materials_json AS archived_materials_json,
       a.result_json AS archived_result_json, a.archived_at
FROM drafts d
LEFT JOIN archives a ON a.draft_id = d.id
"""


# ---------------- 配方 ----------------


def list_recipes() -> list[dict]:
    with lock(), connect() as conn:
        rows = conn.execute("SELECT * FROM recipes ORDER BY id").fetchall()
        return [_recipe_dict(r) for r in rows]


def get_recipe(recipe_id: int) -> dict:
    with lock(), connect() as conn:
        row = conn.execute("SELECT * FROM recipes WHERE id=?", (recipe_id,)).fetchone()
        if row is None:
            raise NotFound(f"配方 {recipe_id} 不存在。")
        return _recipe_dict(row)


def create_recipe(
    name: str, hold_low: int, hold_high: int, duration: int, tolerance: int
) -> dict:
    now = _now()
    with lock(), connect() as conn:
        with _tx(conn):
            cur = conn.execute(
                """INSERT INTO recipes
                   (name, hold_low, hold_high, duration, tolerance,
                    version, created_at, updated_at)
                   VALUES (?,?,?,?,?,1,?,?)""",
                (name, hold_low, hold_high, duration, tolerance, now, now),
            )
            rid = cur.lastrowid
        return get_recipe(rid)


def update_recipe(
    recipe_id: int,
    name: str,
    hold_low: int,
    hold_high: int,
    duration: int,
    tolerance: int,
) -> tuple[dict, list[dict]]:
    """整份修改配方（版本 +1），并原子地重算所有引用它的活动草稿。

    已归档炉次不受影响。引用草稿（无论新结果是否有解）版本一律 +1；
    无解草稿清除旧曲线并记录原因。
    """
    now = _now()
    with lock(), connect() as conn:
        with _tx(conn):
            row = conn.execute(
                "SELECT * FROM recipes WHERE id=?", (recipe_id,)
            ).fetchone()
            if row is None:
                raise NotFound(f"配方 {recipe_id} 不存在。")

            conn.execute(
                """UPDATE recipes SET name=?, hold_low=?, hold_high=?, duration=?,
                       tolerance=?, version=version+1, updated_at=?
                   WHERE id=?""",
                (name, hold_low, hold_high, duration, tolerance, now, recipe_id),
            )

            affected = _recompute_referencing(conn, {recipe_id})

        recipe = get_recipe(recipe_id)
        drafts = [get_draft(did) for did in affected]
        return recipe, drafts


def _recompute_referencing(conn, recipe_ids: set[int]) -> list[int]:
    """重算引用了给定配方集合的所有**活动**草稿，返回受影响草稿 ID。"""
    rows = conn.execute(
        """SELECT d.* FROM drafts d
           LEFT JOIN archives a ON a.draft_id = d.id
           WHERE a.id IS NULL ORDER BY d.id"""
    ).fetchall()

    affected: list[int] = []
    for d in rows:
        refs = json.loads(d["recipe_ids"])
        if not any(r in recipe_ids for r in refs):
            continue
        _recompute_draft(conn, d["id"], refs)
        affected.append(d["id"])
    return affected


def _recompute_draft(conn, draft_id: int, refs: list[int]) -> None:
    """按当前配方表重新求解某活动草稿并整体写入（参数与结果严格同版）。"""
    placeholders = ",".join("?" * len(refs))
    rows = conn.execute(
        f"SELECT * FROM recipes WHERE id IN ({placeholders})", refs
    ).fetchall()
    by_id = {r["id"]: r for r in rows}
    ordered = [by_id[r] for r in refs]  # refs 在创建时已校验存在且互不相同

    materials = [_to_material(r) for r in ordered]
    snapshot = [_material_snapshot(r) for r in ordered]
    versions = {str(r["id"]): r["version"] for r in ordered}
    outcome = solve(materials)

    if outcome.get("solvable"):
        solvable, result_json, reason = 1, _dumps(outcome), None
    else:
        # 无解：仍保存，但清除旧曲线并记录原因
        solvable, result_json, reason = 0, None, outcome.get("reason")

    conn.execute(
        """UPDATE drafts SET materials_json=?, recipe_versions_json=?, solvable=?,
               result_json=?, reason=?, version=version+1, updated_at=?
           WHERE id=?""",
        (
            _dumps(snapshot),
            _dumps(versions),
            solvable,
            result_json,
            reason,
            _now(),
            draft_id,
        ),
    )


# ---------------- 炉次草稿 ----------------


def list_drafts() -> list[dict]:
    with lock(), connect() as conn:
        rows = conn.execute(_DRAFT_SELECT + " ORDER BY d.id").fetchall()
        return [_draft_dict(r) for r in rows]


def get_draft(draft_id: int) -> dict:
    with lock(), connect() as conn:
        row = conn.execute(_DRAFT_SELECT + " WHERE d.id=?", (draft_id,)).fetchone()
        if row is None:
            raise NotFound(f"炉次草稿 {draft_id} 不存在。")
        return _draft_dict(row)


def create_draft(name: str, recipe_ids: list[int]) -> dict:
    """按顺序引用 2~3 个不同的现有配方；引用不可改，从 20°C 空记录求解。"""
    now = _now()
    with lock(), connect() as conn:
        with _tx(conn):
            placeholders = ",".join("?" * len(recipe_ids))
            rows = conn.execute(
                f"SELECT * FROM recipes WHERE id IN ({placeholders})", recipe_ids
            ).fetchall()
            by_id = {r["id"]: r for r in rows}
            missing = [rid for rid in recipe_ids if rid not in by_id]
            if missing:
                raise Unprocessable(
                    f"配方 ID {', '.join(map(str, missing))} 不存在，无法引用。"
                )
            ordered = [by_id[r] for r in recipe_ids]

            materials = [_to_material(r) for r in ordered]
            snapshot = [_material_snapshot(r) for r in ordered]
            versions = {str(r["id"]): r["version"] for r in ordered}
            # 从 20°C 空记录求解（executed=None），复用原求解规则
            outcome = solve(materials)
            if outcome.get("solvable"):
                solvable, result_json, reason = 1, _dumps(outcome), None
            else:
                solvable, result_json, reason = 0, None, outcome.get("reason")

            cur = conn.execute(
                """INSERT INTO drafts
                   (name, recipe_ids, version, recipe_versions_json,
                    materials_json, solvable, result_json, reason,
                    created_at, updated_at)
                   VALUES (?,?,1,?,?,?,?,?,?,?)""",
                (
                    name,
                    _dumps(recipe_ids),
                    _dumps(versions),
                    _dumps(snapshot),
                    solvable,
                    result_json,
                    reason,
                    now,
                    now,
                ),
            )
            draft_id = cur.lastrowid
        return get_draft(draft_id)


def archive_draft(draft_id: int, expected_version: int) -> dict:
    """归档核准的炉次方案。

    - 携带所查看的草稿版本：与当前版本不一致 => 409（附当前版本）；
    - 草稿当前无解 => 422（不改变任何状态）；
    - 已归档 => 409；
    - 成功则冻结当时的材料参数、草稿版本与完整求解结果；此后配方修改
      不再影响该炉次。
    """
    now = _now()
    with lock(), connect() as conn:
        with _tx(conn):
            row = conn.execute(
                _DRAFT_SELECT + " WHERE d.id=?", (draft_id,)
            ).fetchone()
            if row is None:
                raise NotFound(f"炉次草稿 {draft_id} 不存在。")
            if row["archive_id"] is not None:
                raise Conflict("该炉次已归档，不能重复归档。", row["version"])
            if row["version"] != expected_version:
                raise Conflict(
                    f"炉次草稿已过期：你查看的是版本 {expected_version}，"
                    f"当前为版本 {row['version']}，请重新读取后再归档。",
                    row["version"],
                )
            if not row["solvable"]:
                raise Unprocessable(
                    row["reason"] or "该炉次当前无可行曲线，无法归档。"
                )

            conn.execute(
                """INSERT INTO archives
                   (draft_id, draft_version, materials_json, result_json, archived_at)
                   VALUES (?,?,?,?,?)""",
                (
                    draft_id,
                    row["version"],
                    row["materials_json"],
                    row["result_json"],
                    now,
                ),
            )
        return get_draft(draft_id)
