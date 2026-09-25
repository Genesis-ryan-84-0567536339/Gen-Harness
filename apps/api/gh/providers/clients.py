"""Client gọi model: Gemini API, API kiểu OpenAI (DeepSeek, tuỳ chọn), Antigravity CLI (`agy`, bản chính hãng).

Mọi client trả `Completion` hoặc ném một trong các lỗi phân loại dưới đây để bộ định tuyến quyết định
đổi khoá (429), bỏ qua nhà cung cấp (hết hạn mức, xác thực) hay tính lỗi cho ngắt mạch (tạm thời).
"""

import asyncio
import contextlib
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import orjson

EMBED_DIM = 768
DEFAULT_ENDPOINT = {
    "gemini": "https://generativelanguage.googleapis.com/v1beta",
    "deepseek": "https://api.deepseek.com/v1",
    "openai_compat": "",
}


class ProviderError(Exception):
    """Lỗi tạm thời (mạng, 5xx, hết giờ) — tính vào ngắt mạch."""


class RateLimited(ProviderError):  # noqa: N818
    def __init__(self, msg: str, retry_after: float | None = None):
        super().__init__(msg)
        self.retry_after = retry_after


class AuthFailed(ProviderError):  # noqa: N818
    """Khoá / phiên sai hoặc hết hạn."""


class QuotaExhausted(ProviderError):  # noqa: N818
    """Nhà cung cấp báo hết hạn mức (không phải giới hạn tốc độ)."""


class BadRequest(ProviderError):
    """Yêu cầu không hợp lệ — đổi khoá không giúp được."""


@dataclass
class Message:
    role: str      # system | user | assistant
    content: str


@dataclass
class Completion:
    text: str
    tokens_in: int | None = None
    tokens_out: int | None = None
    raw: dict[str, Any] = field(default_factory=dict)


def _retry_after(resp: httpx.Response) -> float | None:
    v = resp.headers.get("retry-after")
    try:
        return float(v) if v else None
    except ValueError:
        return None


def _raise_for(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    body = resp.text[:300]
    if resp.status_code == 429:
        if "quota" in body.lower() and "day" in body.lower():
            raise QuotaExhausted(f"429 hết hạn mức: {body}")
        raise RateLimited(f"429: {body}", _retry_after(resp))
    if resp.status_code in (401, 403):
        raise AuthFailed(f"{resp.status_code}: {body}")
    if resp.status_code == 402:
        raise QuotaExhausted(f"402: {body}")
    if resp.status_code in (400, 404, 422):
        raise BadRequest(f"{resp.status_code}: {body}")
    raise ProviderError(f"{resp.status_code}: {body}")


class HttpClient:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None, timeout: float = 60.0):
        self._transport = transport
        self._timeout = timeout

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self._transport, timeout=self._timeout)

    async def _post(self, url: str, json: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        try:
            async with self._client() as c:
                resp = await c.post(url, json=json, headers=headers)
        except httpx.HTTPError as e:
            raise ProviderError(f"mạng: {e}") from e
        _raise_for(resp)
        return resp.json()  # type: ignore[no-any-return]

    async def _get(self, url: str, headers: dict[str, str]) -> dict[str, Any]:
        try:
            async with self._client() as c:
                resp = await c.get(url, headers=headers)
        except httpx.HTTPError as e:
            raise ProviderError(f"mạng: {e}") from e
        _raise_for(resp)
        return resp.json()  # type: ignore[no-any-return]


class GeminiClient(HttpClient):
    kind = "gemini"

    def __init__(self, endpoint: str | None, key: str, **kw: Any):
        super().__init__(**kw)
        self.base = (endpoint or DEFAULT_ENDPOINT["gemini"]).rstrip("/")
        self.headers = {"x-goog-api-key": key, "content-type": "application/json"}

    async def generate(self, model: str, messages: list[Message], *, json_mode: bool, temperature: float) -> Completion:
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        contents = [{"role": "model" if m.role == "assistant" else "user", "parts": [{"text": m.content}]}
                    for m in messages if m.role != "system"]
        body: dict[str, Any] = {"contents": contents, "generationConfig": {"temperature": temperature}}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if json_mode:
            body["generationConfig"]["responseMimeType"] = "application/json"
        data = await self._post(f"{self.base}/models/{model}:generateContent", body, self.headers)
        cands = data.get("candidates") or []
        if not cands:
            raise ProviderError(f"không có kết quả: {str(data.get('promptFeedback'))[:200]}")
        text = "".join(p.get("text", "") for p in (cands[0].get("content") or {}).get("parts", []))
        usage = data.get("usageMetadata") or {}
        return Completion(text, usage.get("promptTokenCount"), usage.get("candidatesTokenCount"), data)

    async def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        reqs = [{"model": f"models/{model}", "content": {"parts": [{"text": t}]}, "outputDimensionality": EMBED_DIM}
                for t in texts]
        data = await self._post(f"{self.base}/models/{model}:batchEmbedContents", {"requests": reqs}, self.headers)
        return [e["values"] for e in data.get("embeddings", [])]

    async def list_models(self) -> list[str]:
        data = await self._get(f"{self.base}/models", self.headers)
        return [m["name"].removeprefix("models/") for m in data.get("models", [])]


class OpenAICompatClient(HttpClient):
    kind = "openai_compat"

    def __init__(self, endpoint: str | None, key: str, **kw: Any):
        super().__init__(**kw)
        if not endpoint:
            raise BadRequest("Thiếu endpoint")
        self.base = endpoint.rstrip("/").removesuffix("/chat/completions")
        self.headers = {"authorization": f"Bearer {key}", "content-type": "application/json"}

    async def generate(self, model: str, messages: list[Message], *, json_mode: bool, temperature: float) -> Completion:
        body: dict[str, Any] = {"model": model, "temperature": temperature,
                                "messages": [{"role": m.role, "content": m.content} for m in messages]}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        try:
            data = await self._post(f"{self.base}/chat/completions", body, self.headers)
        except BadRequest:
            if not json_mode:
                raise
            body.pop("response_format")   # model không hỗ trợ JSON mode → vẫn yêu cầu JSON trong prompt
            data = await self._post(f"{self.base}/chat/completions", body, self.headers)
        choice = (data.get("choices") or [{}])[0]
        usage = data.get("usage") or {}
        return Completion((choice.get("message") or {}).get("content") or "", usage.get("prompt_tokens"),
                          usage.get("completion_tokens"), data)

    async def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        data = await self._post(f"{self.base}/embeddings", {"model": model, "input": texts, "dimensions": EMBED_DIM},
                                self.headers)
        return [d["embedding"] for d in sorted(data.get("data", []), key=lambda d: d.get("index", 0))]

    async def list_models(self) -> list[str]:
        data = await self._get(f"{self.base}/models", self.headers)
        return [m["id"] for m in data.get("data", [])]


# ─── Antigravity CLI ─────────────────────────────────────────────────────────

TOKEN_FILE = "antigravity-oauth-token"


def cli_home_dir(cli_home: str) -> Path:
    """Thư mục cấu hình CLI (…/.gemini/antigravity-cli). HOME của tiến trình CLI = cha của `.gemini`."""
    return Path(os.path.expanduser(cli_home))


def cli_env(cli_home: str) -> dict[str, str]:
    home = cli_home_dir(cli_home)
    fake_home = home.parent.parent if home.parent.name == ".gemini" else home
    return {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": str(fake_home),
            "NO_COLOR": "1", "TERM": "dumb", "AGY_CLI_DISABLE_AUTO_UPDATE": "1",
            "GEMINI_FORCE_FILE_STORAGE": "true", "LANG": "C.UTF-8"}


class AgyClient:
    """Gọi `agy -p` (chế độ headless chính thức) với tệp phiên của hồ sơ đang hoạt động."""

    kind = "antigravity_cli"
    MAX_PROMPT = 120_000   # giới hạn một đối số dòng lệnh (MAX_ARG_STRLEN 128 KiB)

    def __init__(self, binary: str, cli_home: str, effort: str = "medium", timeout: float = 300.0):
        self.binary, self.cli_home, self.effort, self.timeout = binary, cli_home, effort, timeout

    async def _run(self, *args: str) -> tuple[int, bytes, bytes]:
        try:
            proc = await asyncio.create_subprocess_exec(
                self.binary, *args, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, env=cli_env(self.cli_home))
        except FileNotFoundError as e:
            raise AuthFailed("Chưa cài Antigravity CLI trong worker") from e
        try:
            out, err = await asyncio.wait_for(proc.communicate(), self.timeout)
        except (TimeoutError, asyncio.CancelledError):
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
            raise
        return proc.returncode or 0, out, err

    async def generate(self, model: str, messages: list[Message], *, json_mode: bool, temperature: float) -> Completion:
        prompt = "\n\n".join(f"[{m.role}]\n{m.content}" if m.role != "user" else m.content for m in messages)
        if len(prompt.encode()) > self.MAX_PROMPT:
            raise BadRequest("Prompt quá dài cho CLI")
        if not (cli_home_dir(self.cli_home) / TOKEN_FILE).exists():
            raise AuthFailed("CLI chưa đăng nhập")
        started = time.monotonic()
        try:
            code, out, err = await self._run("-p", prompt, "--model", model, "--effort", self.effort,
                                             "--output-format", "json")
        except TimeoutError as e:
            raise ProviderError(f"CLI quá {self.timeout:.0f}s") from e
        text = out.decode(errors="replace").strip()
        try:
            env = orjson.loads(text)
        except orjson.JSONDecodeError:
            env = None
        if code != 0 or not isinstance(env, dict) or env.get("error"):
            msg = (str(env.get("error")) if isinstance(env, dict) and env.get("error") else "") or \
                err.decode(errors="replace")[-300:] or text[-300:]
            low = msg.lower()
            if "auth" in low or "login" in low or "credential" in low:
                raise AuthFailed(msg)
            if "quota" in low or "resource_exhausted" in low or "429" in low:
                raise RateLimited(msg, 60)
            raise ProviderError(f"CLI thoát {code}: {msg}")
        usage = env.get("usage") or {}
        return Completion(str(env.get("response") or ""), usage.get("input_tokens") or usage.get("prompt_tokens"),
                          usage.get("output_tokens") or usage.get("completion_tokens"),
                          {"duration_seconds": env.get("duration_seconds"),
                           "ms": int((time.monotonic() - started) * 1000)})

    async def list_models(self) -> list[str]:
        code, out, err = await self._run("models")
        if code != 0:
            raise ProviderError(err.decode(errors="replace")[-300:])
        models = []
        for line in out.decode(errors="replace").splitlines():
            tok = line.strip().split()[0] if line.strip() else ""
            if tok and not tok.endswith(":") and "-" in tok:
                models.append(tok.strip("*•-"))
        return models

    async def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        raise BadRequest("CLI không hỗ trợ embedding")


def parse_json_block(text: str) -> Any:
    """Lấy JSON từ câu trả lời của model (chấp nhận khối ```json … ``` hoặc chữ thừa hai đầu)."""
    s = text.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        s = s.rsplit("```", 1)[0]
    try:
        return orjson.loads(s)
    except orjson.JSONDecodeError:
        pass
    for open_, close in (("{", "}"), ("[", "]")):
        i, j = s.find(open_), s.rfind(close)
        if i != -1 and j > i:
            try:
                return orjson.loads(s[i:j + 1])
            except orjson.JSONDecodeError:
                continue
    raise ValueError("Model không trả JSON hợp lệ")
