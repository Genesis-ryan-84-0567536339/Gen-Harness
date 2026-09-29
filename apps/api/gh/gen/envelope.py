"""Envelope có kiểu mỗi vòng model trả về (docs/design/gen-v1.md §3.3) — khớp `packages/contracts/src/gen.ts`.

Model trả MỘT khối JSON `{"steps": [GenStep, …]}`. Sai schema (`extra="forbid"`) → hỏi lại model một lần, vẫn sai →
"Gen chưa hiểu" và không thực thi gì.
"""

from typing import Annotated, Any, Literal

import orjson
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

DATA_TOOL_NAMES = ("overview.summary", "queue.list", "draft.list", "draft.get", "profile.search", "profile.get",
                   "opportunity.list", "people.care", "audit.list", "system.health", "guide.list", "screens.list")
DataToolName = Literal["overview.summary", "queue.list", "draft.list", "draft.get", "profile.search", "profile.get",
                       "opportunity.list", "people.care", "audit.list", "system.health", "guide.list", "screens.list"]


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Navigate(_M):
    type: Literal["navigate"]
    screen: str = Field(min_length=1, max_length=40)
    params: dict[str, str] | None = None


class Highlight(_M):
    type: Literal["highlight"]
    target: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=400)
    waitFor: Literal["click", "none"] | None = None  # noqa: N815 — tên trường theo hợp đồng TS


class TourStep(_M):
    screen: str | None = Field(default=None, max_length=40)
    target: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=400)


class Tour(_M):
    type: Literal["tour"]
    steps: list[TourStep] = Field(min_length=1, max_length=8)


UiAction = Annotated[Navigate | Highlight | Tour, Field(discriminator="type")]


class Suggestion(_M):
    label: str = Field(min_length=1, max_length=60)
    action: UiAction


class Say(_M):
    kind: Literal["say"]
    text: str = Field(min_length=1, max_length=4000)


class ToolCall(_M):
    kind: Literal["tool"]
    name: DataToolName
    args: dict[str, Any] = Field(default_factory=dict)


class Ui(_M):
    kind: Literal["ui"]
    action: UiAction


class Suggest(_M):
    kind: Literal["suggest"]
    items: list[Suggestion] = Field(min_length=1, max_length=3)


class Done(_M):
    kind: Literal["done"]


GenStep = Annotated[Say | ToolCall | Ui | Suggest | Done, Field(discriminator="kind")]


class Envelope(_M):
    steps: list[GenStep] = Field(min_length=1, max_length=12)


_STEP: TypeAdapter[Any] = TypeAdapter(GenStep)


class EnvelopeError(ValueError):
    pass


def _strip_fence(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else ""
        t = t.rsplit("```", 1)[0]
    return t.strip()


def parse(text: str) -> Envelope:
    """Đọc envelope; chấp nhận `{"steps": […]}`, một bước lẻ `{"kind": …}` hoặc mảng bước."""
    try:
        data = orjson.loads(_strip_fence(text))
    except orjson.JSONDecodeError as e:
        raise EnvelopeError(f"không phải JSON: {e}") from e
    if isinstance(data, list):
        data = {"steps": data}
    elif isinstance(data, dict) and "kind" in data:
        data = {"steps": [data]}
    try:
        return Envelope.model_validate(data)
    except ValidationError as e:
        raise EnvelopeError(e.errors(include_url=False, include_input=False).__repr__()[:600]) from e


def dump_step(step: Any) -> dict[str, Any]:
    out: dict[str, Any] = _STEP.dump_python(step, mode="json", exclude_none=True)
    return out
