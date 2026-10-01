"""Client gọi model: Gemini API, API kiểu OpenAI (DeepSeek, tuỳ chọn), Antigravity CLI (`agy`, bản chính hãng).

Mọi client trả `Completion` hoặc ném một trong các lỗi phân loại dưới đây để bộ định tuyến quyết định
đổi khoá (429), bỏ qua nhà cung cấp (hết hạn mức, xác thực) hay tính lỗi cho ngắt mạch (tạm thời).
"""

import asyncio
import contextlib
import os
import re
import tempfile
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


class ModelRejected(BadRequest):
    """CLI không nhận model / mức suy nghĩ này (v0.1.31: gọi thử trước khi lưu model).

    v0.1.32: chỉ dùng cho lỗi "không biết model" THẬT (mẫu chính xác bên dưới); `what` = "model" | "effort";
    `available` = danh sách CLI tự nêu trong lỗi (agy: "Invalid model %q (available: %s)"); `raw` = lỗi gốc."""

    def __init__(self, msg: str, *, what: str = "model", available: list[str] | None = None, raw: str = ""):
        super().__init__(msg)
        self.what, self.available, self.raw = what, available or [], raw or msg


# Mẫu lỗi "không nhận model" — CHÍNH XÁC (v0.1.32). Nguồn: chuỗi trong agy 1.2.9 ("invalid model selection (--model %q
# --effort %q)", "Invalid model %q (available: %s)", "unknown model %q", "unknown model name %s", "invalid --effort %q
# (valid: %s)", "--effort is not supported for the current model", "--effort is not supported for model %q") và Claude
# Code ("There's an issue with the selected model", API 404 "not_found_error"). Trước đây mọi câu có "model" + "invalid"
# đều bị coi là từ chối model → báo nhầm "CLI không nhận model" cho lỗi khác.
# KHÔNG khớp (review v0.1.32): "unknown model tier: %q" / "unknown model key %s" (nội bộ agy), "The model is not
# available right now … (503)" (lỗi tạm thời — để bộ định tuyến thử lại / chuyển nguồn).
_MODEL_REJECT = re.compile(
    r"invalid model selection|invalid model\s+[\"'“]|unknown model(?: name)?\s+[\"'“]|unknown model name\b"
    r"|model not found|model_not_found|no such model|issue with the selected model|not_found_error|unsupported model"
    r"|not a valid model|model .{0,60} (?:does not exist|is not supported)", re.I)
_EFFORT_REJECT = re.compile(
    r"invalid (?:--)?effort|effort isn't adjustable|unsupported effort|--effort is not supported", re.I)


def model_rejected(msg: str) -> bool:
    return bool(_MODEL_REJECT.search(msg) or _EFFORT_REJECT.search(msg))


def rejection(msg: str) -> ModelRejected | None:
    """ModelRejected nếu `msg` đúng là lỗi CLI không nhận model/effort, kèm danh sách CLI tự nêu (nếu có)."""
    if not model_rejected(msg):
        return None
    from gh.providers.catalog import parse_available

    # "invalid model selection (--model … --effort …): invalid --effort …" = model đúng, MỨC sai.
    bad_model = re.search(r"invalid model\s+[\"'“]|unknown model(?: name)?\s+[\"'“]|unknown model name\b"
                          r"|model not found|issue with the selected model", msg, re.I)
    what = "effort" if _EFFORT_REJECT.search(msg) and not bad_model else "model"
    return ModelRejected(msg[:300], what=what, available=parse_available(msg), raw=msg[-2000:])


# ─── Chẩn đoán CLI (v0.1.32): đầu ra thô đã che bí mật để Boss gửi khi còn lỗi ────────────────────────────

_REDACT: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(https?://[^\s?\"']+)\?[^\s\"']*"), r"\1?…"),                          # link OAuth (code, state…)
    (re.compile(r'("(?:access_token|refresh_token|id_token|token|apiKey|api_key|accessToken|refreshToken|'
                r'secret|password)"\s*:\s*)"[^"]*"', re.I), r'\1"***"'),
    (re.compile(r"\bBearer\s+\S+", re.I), "Bearer ***"),
    (re.compile(r"\b(?:ya29\.|1//|sk-ant-|sk-|AIza)[\w.\-]{8,}"), "***"),
    (re.compile(r"\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*"), "***"),                                   # JWT
    (re.compile(r"\b[A-Za-z0-9_\-+/=]{48,}"), "***"),                                             # chuỗi dài kiểu token
    (re.compile(r"\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b"), r"\1***@\2"),
)


def redact(text: str, limit: int = 6000) -> str:
    """Che token, link OAuth, email (giữ chữ đầu + tên miền) trong đầu ra CLI trước khi hiện / cho chép."""
    for pat, sub in _REDACT:
        text = pat.sub(sub, text)
    return text if len(text) <= limit else text[:limit] + f"\n… (cắt bớt {len(text) - limit} ký tự)"


async def diag_step(label: str, argv_shown: list[str], run: Any, limit_s: float) -> dict[str, Any]:
    """Chạy một bước chẩn đoán: {label, command, exit_code, stdout, stderr, ms, note}. Không bao giờ ném."""
    started = time.monotonic()
    step: dict[str, Any] = {"label": label, "command": redact(" ".join(argv_shown)), "exit_code": None, "stdout": "",
                            "stderr": "", "ms": 0, "note": None}
    try:
        async with asyncio.timeout(limit_s):
            code, out, err = await run()
        step.update(exit_code=code, stdout=redact(out.decode(errors="replace")),
                    stderr=redact(err.decode(errors="replace")))
    except TimeoutError:
        step["note"] = f"quá {limit_s:.0f}s không xong"
    except Exception as e:  # noqa: BLE001 — chẩn đoán phải trả được mọi lỗi
        step["note"] = redact(f"{type(e).__name__}: {e}")[:500]
    step["ms"] = int((time.monotonic() - started) * 1000)
    return step


def _skipped(label: str, argv: list[str], note: str) -> dict[str, Any]:
    return {"label": label, "command": redact(" ".join(argv)), "exit_code": None, "stdout": "", "stderr": "",
            "ms": 0, "note": note}


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

    def __init__(self, binary: str, cli_home: str, effort: str | None = None, timeout: float = 300.0):
        # `effort` = mức mặc định khi model không có mức riêng; None = để CLI tự chọn (không gửi --effort).
        self.binary, self.cli_home, self.effort, self.timeout = binary, cli_home, effort, timeout
        self.last_models_raw: str | None = None

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

    def model_args(self, model: str, effort: str | None = None) -> list[str]:
        """`--model <model gốc> [--effort <mức>]` (v0.1.32). Tên biến thể cũ ("gemini-3.8-flash-high") được tách —
        không bao giờ gửi biến thể làm `--model` (agy 1.2.9 từ chối: "invalid model selection")."""
        from gh.providers.catalog import AGY_EFFORTS, split_variant

        base, var_effort = split_variant(self.kind, model)
        eff = effort or var_effort or self.effort
        return ["--model", base, *(["--effort", eff] if eff in AGY_EFFORTS else [])]

    async def generate(self, model: str, messages: list[Message], *, json_mode: bool, temperature: float,
                       effort: str | None = None) -> Completion:
        prompt = "\n\n".join(f"[{m.role}]\n{m.content}" if m.role != "user" else m.content for m in messages)
        if len(prompt.encode()) > self.MAX_PROMPT:
            raise BadRequest("Prompt quá dài cho CLI")
        token = cli_home_dir(self.cli_home) / TOKEN_FILE
        if not token.exists():
            if token.with_name(TOKEN_FILE + ".before-login").exists():
                # Console đang thêm tài khoản Google (tệp phiên gửi tạm, gh.providers.cli): tạm thời, không phải
                # "hết hạn" — chuyển nhà cung cấp kế tiếp mà không đánh dấu CLI hết hạn.
                raise ProviderError("CLI đang đăng nhập thêm tài khoản Google")
            raise AuthFailed("CLI chưa đăng nhập")
        started = time.monotonic()
        try:
            code, out, err = await self._run("-p", prompt, *self.model_args(model, effort), "--output-format", "json")
        except TimeoutError as e:
            raise ProviderError(f"CLI quá {self.timeout:.0f}s") from e
        text = out.decode(errors="replace").strip()
        try:
            env = orjson.loads(text)
        except orjson.JSONDecodeError:
            env = None
        if code != 0 or not isinstance(env, dict) or env.get("error"):
            stderr = err.decode(errors="replace")
            msg = (str(env.get("error")) if isinstance(env, dict) and env.get("error") else "") or \
                stderr[-300:] or text[-300:]
            low = msg.lower()
            # agy 1.2.9 (-p): lỗi model/agent → thoát 3 + dòng "AGY_ERROR: {...}" trên stderr; xét cả hai.
            rej = rejection(f"{msg}\n{stderr[-2000:]}")
            if rej is not None:
                raise rej
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
        return [m["id"] for m in await self.discover_models()]

    async def discover_models(self) -> list[dict[str, Any]]:
        """`agy models` (cần đã đăng nhập). Chưa đăng nhập / phiên hết hạn → AuthFailed, không coi là "OK"."""
        from gh.providers.catalog import parse_agy_models, strip_ansi

        try:
            code, out, err = await self._run("models")
        except TimeoutError as e:
            raise ProviderError(f"CLI quá {self.timeout:.0f}s") from e
        text = out.decode(errors="replace") + "\n" + err.decode(errors="replace")
        self.last_models_raw = redact(strip_ansi(text).strip(), 3000)   # cho "Chi tiết kỹ thuật" (v0.1.32)
        low = strip_ansi(text).lower()
        if "sign in" in low or "login" in low or "authenticat" in low or "credential" in low:
            raise AuthFailed(strip_ansi(text).strip()[-300:])
        if code != 0:
            raise ProviderError(f"CLI thoát {code}: {strip_ansi(text).strip()[-300:]}")
        return parse_agy_models(out.decode(errors="replace"))

    async def diagnose(self, model: str | None, effort: str | None, prompt: str) -> list[dict[str, Any]]:
        """Phiên bản, `agy models`, `agy -p /model`, `agy -p /effort`, một lượt gọi rất ngắn đúng cờ đang dùng — đầu ra
        thô đã che (v0.1.32).

        `-p "/model"` / `-p "/effort"`: changelog trong tệp chạy agy 1.2.9 (1.1.11) — ở chế độ in, `/model`, `/effort`…
        "emit one tab-separated record per line … without starting an agent turn, spending quota" → lấy được danh sách
        model / mức suy nghĩ THẬT của tài khoản đã đăng nhập mà không tốn lượt."""
        name = Path(self.binary).name
        steps = [await diag_step("Phiên bản", [name, "--version"], lambda: self._run("--version"), 20),
                 await diag_step("Danh sách model", [name, "models"], lambda: self._run("models"), 60)]
        argv = ["-p", prompt, *(self.model_args(model, effort) if model else []), "--output-format", "json"]
        model_argv = ["-p", "/model"]
        effort_argv = ["-p", "/effort", *(self.model_args(model) if model else [])]
        if not (cli_home_dir(self.cli_home) / TOKEN_FILE).exists():
            # CLI chưa đăng nhập mà chạy -p sẽ in link đăng nhập rồi chờ 60 giây — không chạy.
            for label, av in (("Model của tài khoản (/model)", model_argv),
                              ("Mức suy nghĩ (/effort)", effort_argv), ("Gọi thử 1 lượt", argv)):
                steps.append(_skipped(label, [name, *av], "bỏ qua — CLI chưa đăng nhập"))
            return steps
        steps.append(await diag_step("Model của tài khoản (/model)", [name, *model_argv],
                                     lambda: self._run(*model_argv), 60))
        steps.append(await diag_step("Mức suy nghĩ (/effort)", [name, *effort_argv],
                                     lambda: self._run(*effort_argv), 60))
        steps.append(await diag_step("Gọi thử 1 lượt", [name, *argv], lambda: self._run(*argv), 90))
        return steps

    async def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        raise BadRequest("CLI không hỗ trợ embedding")


# ─── Claude Code CLI (v0.1.31) ───────────────────────────────────────────────

CLAUDE_CRED_FILE = ".credentials.json"     # trong CLAUDE_CONFIG_DIR (chuỗi trong tệp chạy claude 2.1.285)
CLAUDE_STATE_FILE = ".claude.json"         # thông tin tài khoản (oauthAccount.emailAddress …), cùng thư mục


def claude_env(claude_home: str) -> dict[str, str]:
    """Môi trường SẠCH cho `claude`: chỉ phiên đăng nhập gói Claude trong CLAUDE_CONFIG_DIR — không truyền
    ANTHROPIC_API_KEY hay biến nào khác của api (token không bao giờ nằm trên dòng lệnh / log)."""
    home = cli_home_dir(claude_home)
    return {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": str(home.parent),
            "CLAUDE_CONFIG_DIR": str(home), "NO_COLOR": "1", "TERM": "dumb", "LANG": "C.UTF-8",
            "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}


class ClaudeCodeClient:
    """Gọi `claude -p` (Claude Code, chế độ không tương tác) bằng phiên đăng nhập gói Claude của Owner.

    Cờ đã kiểm trên `claude --help` 2.1.286: `-p/--print`, `--model <alias|tên>`, `--output-format json`, `--tools ""`
    (tắt MỌI công cụ — model chỉ trả lời chữ, không chạy lệnh trong container), `--system-prompt`,
    `--no-session-persistence`, `--strict-mcp-config`, `--disable-slash-commands`. Prompt đưa qua stdin (không giới
    hạn độ dài đối số dòng lệnh). JSON trả về: `result`, `is_error`, `usage.input_tokens/output_tokens`.

    Review v0.1.31 (đo thật trên 2.1.285): `--tools ""` KHÔNG chặn hook trong settings.json hay CLAUDE.md của
    CLAUDE_CONFIG_DIR/thư mục cha — thêm `--safe-mode` (tắt hook, CLAUDE.md, skill, plugin, MCP; đăng nhập vẫn chạy).
    Lời nhắn hệ thống đưa qua `--system-prompt-file` (tệp tạm 0600): không lộ trên /proc/*/cmdline và không vỡ khi dài
    quá 128 KiB (MAX_ARG_STRLEN). `--model=<tên>` để tên model không bao giờ bị hiểu thành một cờ."""

    kind = "claude_code_cli"
    MAX_PROMPT = 400_000

    def __init__(self, binary: str, claude_home: str, timeout: float = 300.0):
        self.binary, self.claude_home, self.timeout = binary, claude_home, timeout

    def _workdir(self) -> Path:
        d = cli_home_dir(self.claude_home).parent / "work"
        d.mkdir(parents=True, exist_ok=True)
        return d

    async def _run(self, *args: str, stdin: bytes | None = None) -> tuple[int, bytes, bytes]:
        try:
            proc = await asyncio.create_subprocess_exec(
                self.binary, *args, stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=claude_env(self.claude_home),
                cwd=str(self._workdir()))
        except FileNotFoundError as e:
            raise AuthFailed("Chưa cài Claude Code CLI trong máy chủ") from e
        try:
            out, err = await asyncio.wait_for(proc.communicate(stdin), self.timeout)
        except (TimeoutError, asyncio.CancelledError):
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
            raise
        return proc.returncode or 0, out, err

    async def auth_status(self) -> dict[str, Any]:
        """`claude auth status --json` → {loggedIn, authMethod, email, subscriptionType…}; thoát 1 khi chưa đăng
        nhập."""
        try:
            code, out, _err = await self._run("auth", "status", "--json")
        except TimeoutError as e:
            raise ProviderError(f"CLI quá {self.timeout:.0f}s") from e
        try:
            data = orjson.loads(out)
        except orjson.JSONDecodeError:
            data = {}
        return data if isinstance(data, dict) else {"loggedIn": code == 0}

    @staticmethod
    def model_args(model: str, effort: str | None = None) -> list[str]:
        """`--model=<tên>` + `--effort=<mức>` (v0.1.32, `claude --help` 2.1.285: low, medium, high, xhigh, max)."""
        from gh.providers.catalog import CLAUDE_EFFORTS

        return [f"--model={model}", *([f"--effort={effort}"] if effort in CLAUDE_EFFORTS else [])]

    async def generate(self, model: str, messages: list[Message], *, json_mode: bool, temperature: float,
                       effort: str | None = None) -> Completion:
        if not (cli_home_dir(self.claude_home) / CLAUDE_CRED_FILE).exists():
            if (cli_home_dir(self.claude_home) / (CLAUDE_CRED_FILE + ".before-login")).exists():
                raise ProviderError("Claude Code CLI đang đăng nhập thêm tài khoản")
            raise AuthFailed("Claude Code CLI chưa đăng nhập")
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        prompt = "\n\n".join(f"[{m.role}]\n{m.content}" if m.role != "user" else m.content
                               for m in messages if m.role != "system")
        if len(prompt.encode()) > self.MAX_PROMPT:
            raise BadRequest("Prompt quá dài cho CLI")
        if len(system.encode()) > self.MAX_PROMPT:
            raise BadRequest("Lời nhắn hệ thống quá dài cho CLI")
        args = ["-p", *self.model_args(model, effort), "--output-format", "json", "--no-session-persistence",
                "--safe-mode", "--strict-mcp-config", "--disable-slash-commands"]
        sys_file: str | None = None
        if system:
            fd, sys_file = tempfile.mkstemp(prefix="gh-claude-sys-", suffix=".txt")   # 0600, xoá ngay sau lượt gọi
            with os.fdopen(fd, "wb") as fh:
                fh.write(system.encode())
            args += ["--system-prompt-file", sys_file]
        args += ["--tools", ""]   # cuối cùng: `--tools <tools...>` nhận nhiều giá trị
        started = time.monotonic()
        try:
            code, out, err = await self._run(*args, stdin=prompt.encode())
        except TimeoutError as e:
            raise ProviderError(f"CLI quá {self.timeout:.0f}s") from e
        finally:
            if sys_file:
                with contextlib.suppress(OSError):
                    os.unlink(sys_file)
        text = out.decode(errors="replace").strip()
        try:
            env = orjson.loads(text.splitlines()[-1] if text else "")
        except (orjson.JSONDecodeError, IndexError):
            env = None
        if code != 0 or not isinstance(env, dict) or env.get("is_error"):
            msg = (str(env.get("result") or env.get("error") or env.get("subtype") or "")
                   if isinstance(env, dict) else "") or err.decode(errors="replace")[-300:] or text[-300:]
            low = msg.lower()
            status = env.get("api_error_status") if isinstance(env, dict) else None
            rej = rejection(msg)
            if rej is not None or status == 404:
                raise rej or ModelRejected(msg[:300], raw=msg)
            if status in (401, 403) or any(k in low for k in ("log in", "login", "authenticat", "oauth",
                                                                 "credential", "unauthorized")):
                raise AuthFailed(msg[:300])
            if status == 429 or any(k in low for k in ("rate limit", "usage limit", "limit reached", "429")):
                raise RateLimited(msg[:300], 300)
            raise ProviderError(f"CLI thoát {code}: {msg[:300]}")
        usage = env.get("usage") or {}
        return Completion(str(env.get("result") or ""), usage.get("input_tokens"), usage.get("output_tokens"),
                          {"duration_ms": env.get("duration_ms"), "ms": int((time.monotonic() - started) * 1000)})

    async def diagnose(self, model: str | None, effort: str | None, prompt: str) -> list[dict[str, Any]]:
        """Phiên bản, trạng thái đăng nhập (Claude Code không có lệnh liệt kê model), một lượt gọi rất ngắn."""
        name = Path(self.binary).name
        steps = [await diag_step("Phiên bản", [name, "--version"], lambda: self._run("--version"), 20),
                 await diag_step("Đăng nhập (Claude Code không có lệnh liệt kê model)",
                                 [name, "auth", "status", "--json"], lambda: self._run("auth", "status", "--json"), 30)]
        argv = ["-p", *self.model_args(model or "haiku", effort), "--output-format", "json",
                "--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands",
                "--tools", ""]
        if not (cli_home_dir(self.claude_home) / CLAUDE_CRED_FILE).exists():
            steps.append(_skipped("Gọi thử 1 lượt", [name, *argv], "bỏ qua — CLI chưa đăng nhập"))
        else:
            steps.append(await diag_step("Gọi thử 1 lượt", [name, *argv, "(stdin:", prompt + ")"],
                                         lambda: self._run(*argv, stdin=prompt.encode()), 90))
        return steps

    async def discover_models(self) -> list[dict[str, Any]]:
        """Claude Code không có lệnh liệt kê model → chỉ kiểm phiên đăng nhập; danh sách là bí danh
        (gh.providers.catalog)."""
        st = await self.auth_status()
        if not st.get("loggedIn"):
            raise AuthFailed("Claude Code CLI chưa đăng nhập")
        return []

    async def list_models(self) -> list[str]:
        from gh.providers.catalog import CLAUDE_CODE_MODELS

        await self.discover_models()
        return [m["id"] for m in CLAUDE_CODE_MODELS]

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
