"""Công cụ dữ liệu CHỈ ĐỌC của Gen (docs/design/gen-v1.md §3.4; v2 thêm task.list, staff.list;
v0.1.25 thêm refinery.summary).

Mỗi tool là lớp bọc mỏng quanh một endpoint GET đã có, gọi NỘI BỘ (ASGI, không qua mạng) bằng chính cookie phiên
của người đang hỏi → tái dùng nguyên RBAC, phạm vi dữ liệu và lớp che của endpoint; Gen không có quyền riêng, không
có truy vấn SQL riêng. Kết quả được cắt gọn (≤ 4 KB, ≤ 20 dòng) trước khi đưa model; mọi id xuất hiện trong kết quả
được ghi lại để validator chỉ cho phép làm sáng dòng có thật (chống model bịa id).
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import orjson

from gh.auth import rbac, service
from gh.gen import registry

MAX_BYTES = 4000
MAX_ROWS = 20
ID_KEYS = ("id", "code", "n", "person_id", "draft_id", "item_id", "subject_id")


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    # Cần ít nhất một trong các quyền này (kiểm trước; endpoint còn tự kiểm lại phạm vi).
    permissions: tuple[str, ...]
    path: str | None = None
    # Tham số query cho phép: tên → danh sách giá trị hợp lệ (None = chuỗi tự do ≤ 120 ký tự).
    query: dict[str, tuple[str, ...] | None] = field(default_factory=dict)
    # Tham số nằm trong đường dẫn (vd {id}) — phải là UUID.
    path_args: tuple[str, ...] = ()
    default_query: dict[str, str] = field(default_factory=dict)


TOOLS: dict[str, Tool] = {t.name: t for t in (
    Tool("overview.summary", "Số liệu Tổng quan hôm nay + hàng đợi cần xử lý (cơ hội, cảnh báo, chờ duyệt, đến hạn)",
         ("overview.read",), "/overview"),
    Tool("queue.list", "Hộp thư ý nghĩa; args.tab ∈ all|opportunity|alert|approval|reply|candidate",
         ("queue.read",), "/inbox",
         {"tab": ("all", "opportunity", "alert", "approval", "reply", "candidate"), "intent": None},
         default_query={"limit": "20"}),
    Tool("draft.list", "Bản nháp; args.status ∈ pending|decided|all (pending = đang chờ duyệt, kèm lý do giữ)",
         ("action.draft", "action.approve"), "/drafts", {"status": ("pending", "decided", "all"), "kind": None},
         default_query={"limit": "20"}),
    Tool("draft.get", "Chi tiết một bản nháp theo args.id (lý do bị giữ, người soạn, nội dung)",
         ("action.draft", "action.approve"), "/drafts/{id}", path_args=("id",)),
    Tool("profile.search", "Tìm hội thoại/khách theo ngôn ngữ tự nhiên; args.q", ("opportunity.read",), "/search",
         {"q": None}, default_query={"limit": "20"}),
    Tool("profile.get", "Hồ sơ sống của một người theo args.id", ("profile.read",), "/profile/{id}",
         path_args=("id",)),
    Tool("opportunity.list", "Cơ hội; args.stage, args.confidence ∈ high|medium|low", ("opportunity.read",),
         "/opportunities", {"stage": None, "confidence": ("high", "medium", "low")}, default_query={"limit": "20"}),
    Tool("people.care", "Thời gian phản hồi khách theo từng nhân viên", ("care.read",), "/care/response-times"),
    Tool("audit.list", "Nhật ký hành động gần nhất; args.action (tiền tố, vd gen.)", ("audit.read",), "/audit",
         {"action": None}, default_query={"limit": "20"}),
    Tool("system.health", "Tình trạng CSDL, Redis, kho tệp, bridge kênh", ("system.read",), "/ready"),
    Tool("guide.list", "Các việc thiết lập tuỳ chọn 5–11: vì sao cần, các bước, đã xong chưa", ("system.manage",)),
    Tool("screens.list", "Các màn Sếp được xem (khoá + tên) — dùng khi cần mở màn", ()),
    Tool("task.list", "Việc & nhắc hẹn; args.status ∈ todo|doing|done|cancelled (id việc dùng cho đề xuất gán người)",
         ("queue.read",), "/tasks", {"status": ("todo", "doing", "done", "cancelled")}, default_query={"limit": "20"}),
    Tool("staff.list", "Người trong tổ chức có thể giao việc (id, tên, vai trò) — dùng trước khi đề xuất gán người",
         ("queue.act",), "/gen/assignees"),
    Tool("refinery.summary", "Lọc đầu Hộp thư (Jev/quy tắc): số mục đã lọc, trùng, rác, điểm thấp, chờ lọc, độ trễ và "
         "độ khớp của Jev; args.days ∈ 1|7|30", ("queue.read",), "/refinery/triage/summary",
         {"days": ("1", "7", "30")}),
)}


def allowed(user: service.CurrentUser, tool: Tool) -> bool:
    return not tool.permissions or any(user.permissions.get(p, rbac.NONE) != rbac.NONE for p in tool.permissions)


def tools_for(user: service.CurrentUser) -> list[Tool]:
    return [t for t in TOOLS.values() if allowed(user, t)]


class ToolError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class ToolResult:
    ok: bool
    data: Any
    text: str
    ids: set[str]
    error: str | None = None


def collect_ids(data: Any, out: set[str]) -> None:
    if isinstance(data, dict):
        for k, v in data.items():
            if k in ID_KEYS and isinstance(v, str | int) and not isinstance(v, bool):
                out.add(str(v))
            collect_ids(v, out)
    elif isinstance(data, list):
        for v in data:
            collect_ids(v, out)


def _shrink(data: Any, rows: int, text_len: int) -> Any:
    if isinstance(data, dict):
        return {k: _shrink(v, rows, text_len) for k, v in data.items()}
    if isinstance(data, list):
        return [_shrink(v, rows, text_len) for v in data[:rows]]
    if isinstance(data, str) and len(data) > text_len:
        return data[:text_len] + "…"
    return data


def compact(data: Any) -> tuple[Any, str]:
    """Cắt gọn ≤ MAX_BYTES / MAX_ROWS — giảm dần số dòng và độ dài chuỗi tới khi vừa."""
    for rows, text_len in ((MAX_ROWS, 300), (10, 200), (5, 120), (3, 80)):
        small = _shrink(data, rows, text_len)
        raw = orjson.dumps(small, default=str).decode()
        if len(raw.encode()) <= MAX_BYTES:
            return small, raw
    raw = orjson.dumps(_shrink(data, 2, 60), default=str).decode()
    cut = raw.encode()[:MAX_BYTES].decode(errors="ignore")
    return None, cut + "…(đã cắt)"


def _build_request(tool: Tool, args: dict[str, Any]) -> tuple[str, dict[str, str]]:
    assert tool.path is not None
    path = tool.path
    for a in tool.path_args:
        v = str(args.get(a) or "")
        try:
            uuid.UUID(v)
        except ValueError as e:
            raise ToolError("BAD_ARGS", f"{a} phải là UUID") from e
        path = path.replace("{" + a + "}", v)
    query = dict(tool.default_query)
    for k, allowed_values in tool.query.items():
        if k not in args or args[k] in (None, ""):
            continue
        v = str(args[k])[:120]
        if allowed_values is not None and v not in allowed_values:
            raise ToolError("BAD_ARGS", f"{k} phải thuộc {', '.join(allowed_values)}")
        query[k] = v
    return path, query


GetJson = Callable[[str, dict[str, str]], Any]


class ToolRunner:
    """Chạy tool cho MỘT người trong MỘT lượt; gom id đã thấy cho validator."""

    def __init__(self, app: Any, user: service.CurrentUser, session_token: str):
        self.app, self.user, self.token = app, user, session_token
        self.seen_ids: set[str] = set()

    async def _get(self, path: str, query: dict[str, str]) -> tuple[int, Any]:
        transport = httpx.ASGITransport(app=self.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://gen.internal",
                                     cookies={service.SESSION_COOKIE: self.token}, timeout=20.0) as c:
            r = await c.get(f"/api/v1{path}", params=query)
        try:
            body = r.json()
        except ValueError:
            body = None
        return r.status_code, body

    async def run(self, name: str, args: dict[str, Any]) -> ToolResult:
        tool = TOOLS.get(name)
        if tool is None:
            return self._fail("UNKNOWN_TOOL", f"Không có tool {name}")
        if not allowed(self.user, tool):
            return self._fail("FORBIDDEN", "Vai trò của người hỏi không có quyền dữ liệu này")
        try:
            if tool.name == "screens.list":
                data: Any = registry.visible_screens(self.user.permissions)
            elif tool.name == "guide.list":
                status, follow = await self._get("/setup/follow-up", {})
                done = {i.get("n"): i.get("done") for i in follow} if status == 200 and isinstance(follow, list) \
                    else {}
                # Gọn cho đủ 7 việc trong 4 KB: các bước nối thành một dòng, cắt 320 ký tự.
                data = [{"n": g["n"], "title": g["title"], "done": bool(done.get(g["n"])),
                         "steps": " / ".join(g["steps"])[:320]} for g in registry.load().guide]
            else:
                path, query = _build_request(tool, args)
                status, data = await self._get(path, query)
                if status == 403:
                    return self._fail("FORBIDDEN", "Vai trò của người hỏi không có quyền dữ liệu này")
                if status == 404:
                    return self._fail("NOT_FOUND", "Không tìm thấy")
                if status >= 400:
                    return self._fail("ERROR", f"Lỗi {status}")
        except ToolError as e:
            return self._fail(e.code, str(e))
        small, raw = compact(data)
        ids: set[str] = set()
        collect_ids(small if small is not None else data, ids)
        self.seen_ids |= ids
        return ToolResult(ok=True, data=small, text=raw, ids=ids)

    @staticmethod
    def _fail(code: str, message: str) -> ToolResult:
        return ToolResult(ok=False, data=None, text=orjson.dumps({"error": code, "message": message}).decode(),
                          ids=set(), error=code)
