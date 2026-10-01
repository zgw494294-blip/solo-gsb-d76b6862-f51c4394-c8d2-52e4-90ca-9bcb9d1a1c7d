"""共炉保温编排台 —— FastAPI 后端。"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import store
from .db import init_db
from .solver import Material, solve
from .solver import validate_material as solver_validate_material

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="共炉保温编排台", version="2.0.0", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
def _validation_handler(request: Request, exc: RequestValidationError):
    # 统一把 422 的 detail 转成中文字符串，便于页面直接展示
    zh_types = {
        "list_type": "必须是数组。",
        "int_type": "必须是整数。",
        "int_parsing": "必须是整数。",
        "float_parsing": "必须是数值。",
        "missing": "缺少必填字段。",
        "too_short": "数量少于最小值。",
        "too_long": "数量超过最大值。",
        "greater_than_equal": "数值小于允许的最小值。",
        "less_than_equal": "数值超过允许的最大值。",
    }
    msgs: list[str] = []
    for err in exc.errors():
        etype = err.get("type", "")
        # 自定义校验器抛出的 ValueError 已是中文，直接使用
        if etype == "value_error":
            msgs.append(str(err.get("msg", "参数非法。")).removeprefix("Value error, "))
            continue
        loc = ".".join(str(x) for x in err.get("loc", []) if x != "body")
        msg = zh_types.get(etype.split(".", 1)[0], str(err.get("msg", "参数非法。")))
        msgs.append(f"{loc} {msg}".strip() if loc else msg)
    detail = "；".join(dict.fromkeys(msgs)) or "请求参数非法。"
    return JSONResponse(status_code=422, content=jsonable_encoder({"detail": detail}))


def _raise_store_error(exc: store.StoreError) -> None:
    text = getattr(exc, "detail", None) or str(exc)
    # 409 版本过期时附当前版本，方便调用方刷新后重试
    if isinstance(exc, store.Conflict) and exc.current_version is not None:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"detail": text, "currentVersion": exc.current_version},
        )
    raise HTTPException(status_code=exc.status_code, detail=text)


class MaterialIn(BaseModel):
    name: str = Field(default="", max_length=20)
    hold_low: int = Field(alias="holdLow", ge=40, le=180)
    hold_high: int = Field(alias="holdHigh", ge=40, le=180)
    duration: int
    tolerance: int

    @field_validator("name")
    @classmethod
    def _clean_name(cls, v: str) -> str:
        return (v or "").strip()

    @field_validator("hold_low", "hold_high", "tolerance")
    @classmethod
    def _tens(cls, v: int) -> int:
        if v % 10 != 0:
            raise ValueError("温度必须是 10 的整数倍。")
        return v

    @field_validator("duration")
    @classmethod
    def _duration(cls, v: int) -> int:
        if v not in (5, 10, 15):
            raise ValueError("连续保温时长必须为 5、10 或 15 分钟。")
        return v

    model_config = {"populate_by_name": True}


class ScheduleIn(BaseModel):
    materials: list[MaterialIn] = Field(min_length=2, max_length=3)
    # 可选：1～20 个已经执行的 5 分钟炉温档位（整十数）
    executed_temperatures: list[Any] | None = Field(
        default=None, alias="executedTemperatures"
    )

    @field_validator("executed_temperatures")
    @classmethod
    def _executed_basic(cls, v):
        if v is None:
            return None
        if not isinstance(v, list):
            raise ValueError("已执行温度必须是以数组形式给出的档位列表。")
        return v

    model_config = {"populate_by_name": True}


def _to_material(item: MaterialIn, index: int) -> Material:
    """构造求解用 Material，并复用求解器的材料字段校验。"""
    m = Material(
        name=item.name or f"材料{index + 1}",
        hold_low=item.hold_low,
        hold_high=item.hold_high,
        duration=item.duration,
        tolerance=item.tolerance,
    )
    try:
        solver_validate_material(m, index)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return m


@app.post("/api/schedule")
def schedule(payload: ScheduleIn):
    materials: list[Material] = [
        _to_material(item, i) for i, item in enumerate(payload.materials)
    ]

    executed = payload.executed_temperatures or None
    try:
        return solve(materials, executed=executed)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ---------------- 配方 ----------------


class RecipeIn(BaseModel):
    """配方沿用现有材料字段与校验（整份创建 / 整份修改同一结构）。"""

    name: str = Field(default="", max_length=20)
    hold_low: int = Field(alias="holdLow", ge=40, le=180)
    hold_high: int = Field(alias="holdHigh", ge=40, le=180)
    duration: int
    tolerance: int

    @field_validator("name")
    @classmethod
    def _clean_name(cls, v: str) -> str:
        return (v or "").strip()

    @field_validator("hold_low", "hold_high", "tolerance")
    @classmethod
    def _tens(cls, v: int) -> int:
        if v % 10 != 0:
            raise ValueError("温度必须是 10 的整数倍。")
        return v

    @field_validator("duration")
    @classmethod
    def _duration(cls, v: int) -> int:
        if v not in (5, 10, 15):
            raise ValueError("连续保温时长必须为 5、10 或 15 分钟。")
        return v

    model_config = {"populate_by_name": True}


def _validate_recipe_fields(payload: RecipeIn, fallback: str) -> Material:
    m = Material(
        name=payload.name or fallback,
        hold_low=payload.hold_low,
        hold_high=payload.hold_high,
        duration=payload.duration,
        tolerance=payload.tolerance,
    )
    try:
        solver_validate_material(m, 0)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return m


@app.get("/api/recipes")
def get_recipes():
    return store.list_recipes()


@app.post("/api/recipes", status_code=201)
def create_recipe(payload: RecipeIn):
    _validate_recipe_fields(payload, "配方")
    try:
        return store.create_recipe(
            payload.name,
            payload.hold_low,
            payload.hold_high,
            payload.duration,
            payload.tolerance,
        )
    except store.StoreError as exc:
        _raise_store_error(exc)


@app.get("/api/recipes/{recipe_id}")
def get_recipe(recipe_id: int):
    try:
        return store.get_recipe(recipe_id)
    except store.StoreError as exc:
        _raise_store_error(exc)


@app.put("/api/recipes/{recipe_id}")
def update_recipe(recipe_id: int, payload: RecipeIn):
    # 先校验，非法修改不得进入写事务、不得改变任何数据
    _validate_recipe_fields(payload, "配方")
    try:
        recipe, drafts = store.update_recipe(
            recipe_id,
            payload.name,
            payload.hold_low,
            payload.hold_high,
            payload.duration,
            payload.tolerance,
        )
    except store.StoreError as exc:
        _raise_store_error(exc)
    return {"recipe": recipe, "recomputedDrafts": drafts}


# ---------------- 炉次草稿 ----------------


class DraftIn(BaseModel):
    name: str = Field(default="", max_length=20)
    recipe_ids: list[int] = Field(alias="recipeIds")

    @field_validator("name")
    @classmethod
    def _clean_name(cls, v: str) -> str:
        return (v or "").strip()

    @field_validator("recipe_ids")
    @classmethod
    def _recipe_ids_shape(cls, v: list[int]) -> list[int]:
        if len(v) < 2 or len(v) > 3:
            raise ValueError("炉次必须按顺序引用 2～3 个配方。")
        if len(set(v)) != len(v):
            raise ValueError("同一炉次引用的配方 ID 必须互不相同。")
        return v

    model_config = {"populate_by_name": True}


class ArchiveIn(BaseModel):
    # 归档必须携带所查看的草稿版本
    version: int = Field(ge=1)


@app.get("/api/drafts")
def get_drafts():
    return store.list_drafts()


@app.post("/api/drafts", status_code=201)
def create_draft(payload: DraftIn):
    try:
        return store.create_draft(payload.name, payload.recipe_ids)
    except store.StoreError as exc:
        _raise_store_error(exc)


@app.get("/api/drafts/{draft_id}")
def get_draft(draft_id: int):
    try:
        return store.get_draft(draft_id)
    except store.StoreError as exc:
        _raise_store_error(exc)


@app.post("/api/drafts/{draft_id}/archive")
def archive_draft(draft_id: int, payload: ArchiveIn):
    try:
        return store.archive_draft(draft_id, payload.version)
    except store.StoreError as exc:
        _raise_store_error(exc)


@app.get("/healthz")
def healthz():
    return {"ok": True}


# 静态页面（/）
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
