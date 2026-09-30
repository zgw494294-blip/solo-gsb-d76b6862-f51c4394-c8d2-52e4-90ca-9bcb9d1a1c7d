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

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="共炉保温编排台", version="1.0.0")


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


@app.post("/api/schedule")
def schedule(payload: ScheduleIn):
    materials: list[Material] = []
    for i, item in enumerate(payload.materials):
        if item.hold_low > item.hold_high:
            raise HTTPException(
                status_code=422,
                detail=f"第 {i + 1} 种材料的保温下限不得高于保温上限。",
            )
        if item.tolerance < item.hold_high or item.tolerance > MAX_TEMP:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"材料「{item.name or i + 1}」的耐受上限必须不低于保温上限"
                    f"（{item.hold_high}°C）且至多 {MAX_TEMP}°C。"
                ),
            )
        materials.append(
            Material(
                name=item.name or f"材料{i + 1}",
                hold_low=item.hold_low,
                hold_high=item.hold_high,
                duration=item.duration,
                tolerance=item.tolerance,
            )
        )

    executed = payload.executed_temperatures or None
    try:
        return solve(materials, executed=executed)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/healthz")
def healthz():
    return {"ok": True}


# 静态页面（/）
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
