"""共炉保温编排台 —— FastAPI 后端。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .solver import MAX_TEMP, Material, solve
from .store import (
    Store,
    StoreConflict,
    StoreNotFound,
    StoreUnprocessable,
)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="共炉保温编排台", version="1.1.0")
store = Store()


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


@app.exception_handler(StoreNotFound)
def _not_found_handler(request: Request, exc: StoreNotFound):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(StoreConflict)
def _conflict_handler(request: Request, exc: StoreConflict):
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(StoreUnprocessable)
def _unprocessable_handler(request: Request, exc: StoreUnprocessable):
    return JSONResponse(status_code=422, content={"detail": str(exc)})


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


def build_material(item: MaterialIn, index: int) -> Material:
    """共用的材料语义校验：保温上下限、耐受上限。非法时抛 ValueError（中文）。"""
    if item.hold_low > item.hold_high:
        raise ValueError(f"第 {index + 1} 种材料的保温下限不得高于保温上限。")
    if item.tolerance < item.hold_high or item.tolerance > MAX_TEMP:
        raise ValueError(
            f"材料「{item.name or index + 1}」的耐受上限必须不低于保温上限"
            f"（{item.hold_high}°C）且至多 {MAX_TEMP}°C。"
        )
    return Material(
        name=item.name or f"材料{index + 1}",
        hold_low=item.hold_low,
        hold_high=item.hold_high,
        duration=item.duration,
        tolerance=item.tolerance,
    )


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


@app.post("/api/schedule")
def schedule(payload: ScheduleIn):
    materials: list[Material] = []
    for i, item in enumerate(payload.materials):
        try:
            materials.append(build_material(item, i))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    executed = payload.executed_temperatures or None
    try:
        return solve(materials, executed=executed)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ============================================================ 材料配方

class RecipeIn(BaseModel):
    """配方 = 单种材料参数；字段与 /api/schedule 的材料完全一致。"""

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

    def to_params(self) -> dict:
        return {
            "name": self.name,
            "holdLow": self.hold_low,
            "holdHigh": self.hold_high,
            "duration": self.duration,
            "tolerance": self.tolerance,
        }

    model_config = {"populate_by_name": True}


def _validate_recipe(payload: RecipeIn) -> dict:
    try:
        build_material(payload, 0)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return payload.to_params()


@app.post("/api/recipes", status_code=201)
def create_recipe(payload: RecipeIn):
    return store.create_recipe(_validate_recipe(payload))


@app.get("/api/recipes")
def list_recipes():
    return store.list_recipes()


@app.get("/api/recipes/{recipe_id}")
def get_recipe(recipe_id: int):
    return store.get_recipe(recipe_id)


@app.put("/api/recipes/{recipe_id}")
def replace_recipe(recipe_id: int, payload: RecipeIn):
    """整份修改配方：所有引用它的未归档草稿在同一事务内一起重算。"""
    recipe, recalculated, skipped_archived = store.replace_recipe(
        recipe_id, _validate_recipe(payload)
    )
    return {
        "recipe": recipe,
        "recalculatedDrafts": recalculated,
        "skippedArchived": skipped_archived,
    }


# ============================================================ 炉次草稿

class DraftIn(BaseModel):
    # 按顺序引用 2～3 个不同的现有配方 ID；创建后不可改
    recipe_ids: list[int] = Field(
        alias="recipeIds", min_length=2, max_length=3
    )

    model_config = {"populate_by_name": True}


class ArchiveIn(BaseModel):
    # 归档时携带所查看的草稿版本，做乐观并发控制
    version: int = Field(ge=1)

    model_config = {"populate_by_name": True}


@app.post("/api/drafts", status_code=201)
def create_draft(payload: DraftIn):
    return store.create_draft(list(payload.recipe_ids))


@app.get("/api/drafts")
def list_drafts():
    return store.list_drafts()


@app.get("/api/drafts/{draft_id}")
def get_draft(draft_id: int):
    return store.get_draft(draft_id)


@app.post("/api/drafts/{draft_id}/archive")
def archive_draft(draft_id: int, payload: ArchiveIn):
    return store.archive_draft(draft_id, payload.version)


@app.get("/healthz")
def healthz():
    return {"ok": True}


# 静态页面（/）
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
