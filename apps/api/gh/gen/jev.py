"""Bộ chuyển đổi (adapter) DUY NHẤT nói chuyện với Jev — TypeSafe System One, mô hình quyết định nhanh.

Mọi giả định về định dạng yêu cầu/trả lời nằm ở file này; phần còn lại của Gen chỉ thấy `JevClient.choose()` →
`Choice(label, confidence)`. Đổi schema thật = sửa file này + test `tests/test_gen_jev.py`.

Hai đường gọi, chọn theo base URL của nguồn (`agent.providers.endpoint`, kind `system_one`):

1. OpenRouter (mặc định, `https://openrouter.ai/api/v1`, model `typesafe/jev-1.13`) — API chat tương thích OpenAI:
   `POST {base}/chat/completions`, yêu cầu JSON `{"choice": <một lựa chọn>, "confidence": 0..1}`.
2. TypeSafe API trực tiếp (`https://api.typesafe.ai`) — endpoint `/v1/systemone`.
   TODO(jev-schema): CHƯA có tài liệu chính thức trong repo; schema dưới đây là GIẢ ĐỊNH (ghi trong
   docs/reports/HANDOFF-v0.1.1.md mục v0.1.21), cần đối chiếu khi có khoá thật:
     request  `{"model": str, "task": "choice", "input": str, "context": str, "options": [str, …]}`
     response `{"choice": str, "confidence": float}` — chấp nhận thêm biến thể `label`/`score`/`probability`
              và bọc trong `output` hoặc `result`.
Mọi lỗi (mạng, HTTP ≥ 400, trả lời không phải một trong các lựa chọn) → `JevError`; bên gọi rơi về LLM.
"""

import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx
import orjson

from gh.chassis.masking import mask_error
from gh.chassis.mcp_client import McpBlockedNetwork, McpError, pinned_client, pinned_request

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
TYPESAFE_BASE_URL = "https://api.typesafe.ai"
DEFAULT_MODEL = "typesafe/jev-1.13"
BASE_URL_CHOICES = (DEFAULT_BASE_URL, TYPESAFE_BASE_URL)


class JevError(Exception):
    pass


@dataclass
class Choice:
    label: str
    confidence: float | None
    latency_ms: int
    raw: dict[str, Any] = field(default_factory=dict)


def mode_for(base_url: str) -> str:
    """`systemone` khi trỏ thẳng TypeSafe (hoặc đường dẫn đã chứa systemone); còn lại = API chat kiểu OpenAI."""
    u = urlparse(base_url)
    if "typesafe.ai" in (u.hostname or "") or "systemone" in u.path:
        return "systemone"
    return "chat"


def _systemone_url(base_url: str) -> str:
    b = base_url.rstrip("/")
    if b.endswith("/systemone"):
        return b
    return f"{b}/systemone" if b.endswith("/v1") else f"{b}/v1/systemone"


def _pick(d: dict[str, Any]) -> tuple[Any, Any]:
    for wrap in ("output", "result", "data"):
        if isinstance(d.get(wrap), dict):
            d = d[wrap]
            break
    label = next((d[k] for k in ("choice", "label", "answer") if k in d), None)
    conf = next((d[k] for k in ("confidence", "score", "probability") if k in d), None)
    return label, conf


def _conf(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, f))


class JevClient:
    def __init__(self, base_url: str | None, api_key: str, model: str | None = None, *,
                 transport: httpx.AsyncBaseTransport | None = None, timeout: float = 1.5):
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.api_key = api_key
        self.model = model or DEFAULT_MODEL
        self.transport = transport
        self.timeout = timeout
        self.mode = mode_for(self.base_url)

    def _headers(self) -> dict[str, str]:
        return {"authorization": f"Bearer {self.api_key}", "content-type": "application/json",
                "x-title": "Gen-Harness"}

    def build_request(self, question: str, options: list[str], context: str = "") -> tuple[str, dict[str, Any]]:
        if self.mode == "systemone":
            return _systemone_url(self.base_url), {"model": self.model, "task": "choice", "input": question,
                                                   "context": context, "options": options}
        system = ("Bạn là bộ quyết định nhanh. Chọn ĐÚNG MỘT lựa chọn trong `options` phù hợp nhất với `input`. "
                  'Chỉ trả JSON: {"choice": "<nguyên văn một lựa chọn>", "confidence": <0..1>}.')
        user = orjson.dumps({"input": question, "context": context, "options": options}).decode()
        return f"{self.base_url}/chat/completions", {
            "model": self.model, "temperature": 0, "max_tokens": 80,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}

    def parse_response(self, body: Any, options: list[str]) -> tuple[str, float | None]:
        if not isinstance(body, dict):
            raise JevError("trả lời không phải JSON object")
        if self.mode == "chat":
            try:
                content = body["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError) as e:
                raise JevError("thiếu choices[0].message.content") from e
            content = str(content).strip()
            try:
                parsed = orjson.loads(content)
            except orjson.JSONDecodeError:
                parsed = {"choice": content.strip('"')}
            if not isinstance(parsed, dict):
                parsed = {"choice": str(parsed)}
            label, conf = _pick(parsed)
        else:
            label, conf = _pick(body)
        if not isinstance(label, str):
            raise JevError("trả lời không có lựa chọn")
        match = next((o for o in options if o == label.strip()), None) or \
            next((o for o in options if o.lower() == label.strip().lower()), None)
        if match is None:
            raise JevError(f"lựa chọn ngoài danh sách: {label[:60]}")
        return match, _conf(conf)

    async def choose(self, question: str, options: list[str], context: str = "") -> Choice:
        if not options:
            raise JevError("không có lựa chọn")
        url, payload = self.build_request(question, options, context)
        started = time.monotonic()
        try:
            # v0.1.45 (F-49): ghim DNS như nhà cung cấp AI (gh.providers.clients.HttpClient) — cấm vùng mạng xấu.
            async with pinned_client(self.transport, self.timeout) as c:
                resp = await pinned_request(c, "POST", url, json=payload, headers=self._headers())
        except McpBlockedNetwork as e:
            raise JevError(f"Địa chỉ nhà cung cấp trỏ vào vùng mạng bị cấm: {e}") from e
        except McpError as e:
            raise JevError(str(e)) from e
        except httpx.HTTPError as e:
            raise JevError(f"mạng: {type(e).__name__}") from e
        if resp.status_code >= 400:
            raise JevError(f"HTTP {resp.status_code}: {mask_error(resp.text, secrets=(self.api_key,))}")
        try:
            body = resp.json()
        except ValueError as e:
            raise JevError("trả lời không phải JSON") from e
        label, conf = self.parse_response(body, options)
        return Choice(label, conf, int((time.monotonic() - started) * 1000), body if isinstance(body, dict) else {})

    async def ping(self) -> Choice:
        """Nút "Kiểm tra": một lượt quyết định nhỏ có đáp án rõ."""
        return await self.choose("Xin chào, bạn có hoạt động không? Hãy chọn 'có'.", ["có", "không"])
