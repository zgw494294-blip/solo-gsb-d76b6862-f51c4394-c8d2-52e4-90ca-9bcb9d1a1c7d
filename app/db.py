"""SQLite 持久化层。

- 数据库文件路径：环境变量 PLANNER_DB > /data/planner.db（容器 Compose 卷）
  > 仓库内 data/planner.db（本地裸跑兜底）。
- 全部读写经由单把进程内 RLock 串行化，保证「配方修改」与「归档」按某一
  先后顺序整体生效；读操作拿到的一定是同一版本下自洽的参数与结果。
"""

from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

_LOCK = threading.RLock()


def db_path() -> Path:
    env = os.environ.get("PLANNER_DB")
    if env:
        return Path(env)
    preferred = Path("/data/planner.db")
    if os.access("/", os.W_OK) or preferred.parent.exists():
        try:
            preferred.parent.mkdir(parents=True, exist_ok=True)
            return preferred
        except OSError:
            pass
    local = Path(__file__).resolve().parent.parent / "data" / "planner.db"
    local.parent.mkdir(parents=True, exist_ok=True)
    return local


SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS recipes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL DEFAULT '',
    hold_low    INTEGER NOT NULL,
    hold_high   INTEGER NOT NULL,
    duration    INTEGER NOT NULL,
    tolerance   INTEGER NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL DEFAULT '',
    -- 按顺序引用 2~3 个不同的现有配方 ID，创建后不可改
    recipe_ids  TEXT    NOT NULL,
    -- 上次求解时各配方的版本（{recipeId: recipeVersion}）
    recipe_versions_json TEXT NOT NULL DEFAULT '{}',
    version     INTEGER NOT NULL DEFAULT 1,
    -- 本次求解所用材料参数快照（与 result_json 严格同版）
    materials_json TEXT NOT NULL,
    solvable    INTEGER NOT NULL,
    result_json TEXT,        -- solvable=0 时为 NULL（无旧曲线）
    reason      TEXT,        -- solvable=0 时的中文原因
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS archives (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id        INTEGER NOT NULL UNIQUE,
    draft_version   INTEGER NOT NULL,
    materials_json  TEXT    NOT NULL,  -- 冻结当时的材料参数
    result_json     TEXT    NOT NULL,  -- 冻结完整求解结果
    archived_at     TEXT    NOT NULL,
    FOREIGN KEY (draft_id) REFERENCES drafts(id)
);
"""


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)


@contextmanager
def connect():
    conn = sqlite3.connect(db_path(), timeout=30, isolation_level=None)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        yield conn
    finally:
        conn.close()


def lock():
    """全局串行锁。所有涉及配方/草稿/归档的操作都在该锁内完成。"""
    return _LOCK
