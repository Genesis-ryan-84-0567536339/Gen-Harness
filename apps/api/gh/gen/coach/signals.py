"""Tín hiệu cho Gen hướng dẫn (v0.1.54, g1-api) — CHỈ ĐỌC.

`collect(db, redis, org_id)` gom tín hiệu của MỘT tổ chức từ các nguồn có sẵn (sức khoẻ, "Việc Sếp cần làm", việc
thiết lập tuỳ chọn, cấu hình…) thành `Signals`; cache Redis `gh:gen:coach:sig:<org_id>` TTL 60 giây (orjson) nên
nhiều lần mở thẻ / nhiều Owner trong một phút chỉ đọc nguồn một lần. Mỗi nguồn bọc `asyncio.wait_for` (~2 giây) +
try/except: nguồn lỗi thì BỎ mục đó (log cảnh báo, không kèm dữ liệu) — thẻ vẫn trả.

Dữ liệu giữ lại rất hẹp: từ sự cố sức khoẻ chỉ lấy `kind`, `severity`, `link`, `raised_at` (KHÔNG lấy tiêu đề / thân
sự cố); từ kết quả kiểm "Việc Sếp cần làm" chỉ lấy cờ đạt và `write_missing` (đã gộp thành một cờ, không giữ thông
điệp / chi tiết). Mọi tín hiệu trạng thái là boolean theo từ vựng `STATE_SIGNALS`.

Tệp này cũng giữ bộ quy tắc việc (`TODO_RULES`), đích làm sáng (`TODO_TARGETS`), chủ đề (`TOPIC`), tiêu đề sự cố
tĩnh (`COACH_HEALTH_TITLES`) và câu hậu quả khi tắt việc (`DISMISS_WARNINGS`) — toàn câu tĩnh, Gen xưng "em" gọi "Sếp".
"""

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import orjson
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh import health
from gh.boss_checks import service as boss_service

log = logging.getLogger("gh.gen.coach")

CACHE_KEY = "gh:gen:coach:sig:{}"
CACHE_TTL_S = 60
SOURCE_TIMEOUT_S = 2.0
#: Token Gen-hub còn ≤ N ngày thì thành việc P1 (chuông riêng của hub_link nhắc sớm hơn, từ `EXPIRY_WARN_DAYS` = 14).
HUB_TOKEN_WARN_DAYS = 7

# ─── từ vựng tín hiệu ────────────────────────────────────────────────────────────────────────────────────────

#: Khoá của 9 dòng "Việc Sếp cần làm" (boss_checks.service.ROWS) — test bảo đảm khớp ROWS.
BOSS_KEYS = ("hub", "facebook", "agy", "claude", "jev", "telegram", "remote", "facebook_reply", "kho_write")
#: Việc thiết lập tuỳ chọn có tín hiệu `followup.<n>.done` (5–11 + 13 Facebook + 14 Gen-hub).
FOLLOWUP_NS = (5, 6, 7, 8, 9, 10, 11, 13, 14)
#: Chỉ 5–10 từng là VIỆC trên thẻ (11 trùng `backup.unset`; 13, 14 trùng `boss.facebook` / `boss.hub`).
FOLLOWUP_TODO_NS = (5, 6, 7, 8, 9, 10)

STATE_SIGNALS: frozenset[str] = frozenset({
    "model.bound", "api_key.present", "ai_budget.set", "pin.set", "telegram.briefing_on", "hub.kho_write_missing",
    "memory.empty", "backup.scheduled", "offsite.chosen", "drafts.any",
    *(f"boss.{k}.done" for k in BOSS_KEYS),
    *(f"followup.{n}.done" for n in FOLLOWUP_NS),
})

#: Chủ đề của việc / mẹo — mẹo cùng chủ đề với một việc đang hiện thì bị bỏ (không nói hai lần một chuyện).
TOPICS = frozenset({"model", "hub", "facebook", "agy", "claude", "telegram", "remote", "backup", "offsite", "drafts",
                    "memory", "ai_cost", "setup", "health"})
#: Tiền tố khoá việc → chủ đề. Tra từ khoá đầy đủ rồi bỏ dần đoạn cuối (`topic_of`).
TOPIC: dict[str, str] = {
    "health": "health", "model": "model", "boss.hub": "hub", "boss.facebook": "facebook", "boss.agy": "agy",
    "boss.claude": "claude", "boss.telegram": "telegram", "boss.remote": "remote", "backup": "backup",
    "hub": "hub", "drafts": "drafts", "followup": "setup",
}

# ─── đích làm sáng ────────────────────────────────────────────────────────────────────────────────────────────

#: Đích của dòng "Việc Sếp cần làm" theo khoá dòng. LƯU Ý: id mục tiêu do gói web-coach khai trong registry.json.
BOSS_TARGET = "boss_checks.row.{key}"

#: Khoá việc (không kể health.<kind>: đích của sự cố là liên kết `link` của chính sự cố) → đích làm sáng.
TODO_TARGETS: dict[str, str] = {
    "model.missing": "api.bindings",
    **{f"boss.{r['key']}": BOSS_TARGET.format(key=r["key"]) for r in boss_service.ROWS if not r["optional"]},
    "backup.unset": "system.backup.schedule",
    "hub.token_expiring": "mcp.hub_link.token",
    "drafts.pending": "workbench.drafts",
    **{f"followup.{n}": f"guide.item.do:{n}" for n in FOLLOWUP_TODO_NS},
}
ALL_TARGETS: frozenset[str] = frozenset(TODO_TARGETS.values())

# ─── quy tắc việc ─────────────────────────────────────────────────────────────────────────────────────────────

LEVELS = ("P0", "P1", "P2", "P3")


@dataclass(frozen=True)
class Rule:
    """Một quy tắc sinh việc. `kind`: 'state' (điều kiện `when` trên tín hiệu trạng thái), 'health' (mỗi nhóm sự cố
    cùng kind có mức độ `severity` thành MỘT việc `health.<kind>`), 'hub_token' (cờ `hub_expiring`)."""
    key: str
    level: str
    when: tuple[str, ...] = ()
    kind: str = "state"
    severity: str | None = None


#: Thứ tự CÓ Ý NGHĨA: xếp hạng theo mức (P0 > P1 > P2 > P3), cùng mức theo thứ tự trong bảng này.
TODO_RULES: tuple[Rule, ...] = (
    Rule("health:bad", "P0", kind="health", severity="bad"),
    Rule("model.missing", "P0", when=("!model.bound",)),
    *(Rule(f"boss.{r['key']}", "P1", when=(f"!boss.{r['key']}.done",)) for r in boss_service.ROWS
      if not r["optional"]),
    Rule("health:warn", "P1", kind="health", severity="warn"),
    Rule("backup.unset", "P1", when=("!backup.scheduled",)),
    Rule("hub.token_expiring", "P1", kind="hub_token"),
    Rule("drafts.pending", "P2", when=("drafts.any",)),
    *(Rule(f"followup.{n}", "P3", when=(f"!followup.{n}.done",)) for n in FOLLOWUP_TODO_NS),
)

# ─── câu tĩnh (Gen xưng em, gọi Sếp) ──────────────────────────────────────────────────────────────────────────

GENERIC_HEALTH_TITLE = "Có sự cố cần Sếp xem"
#: Phủ MỌI kind trong health.ACTIONS (+ 'host.nightly': v0.1.53 thêm kind này; main có v0.1.53 thì test vẫn xanh).
COACH_HEALTH_TITLES: dict[str, str] = {
    "channel.down": "Kênh chat bị rớt — Sếp đăng nhập lại giúp em",
    "model.auth_expired": "Model AI hết đăng nhập — Sếp đăng nhập lại để em trả lời được",
    "update.failed": "Lần cập nhật gần nhất bị lỗi — Sếp xem và thử lại giúp em",
    "backup.stale": "Đã lâu chưa có bản sao lưu mới — Sếp mở mục Sao lưu giúp em",
    "worker.silent": "Bộ xử lý nền đang im — Sếp xem sức khoẻ hệ thống giúp em",
    "disk.low": "Ổ đĩa sắp hết chỗ — Sếp giải phóng dung lượng giúp em",
    "host.autostart": "Máy chủ có thể không tự chạy lại khi bật máy — Sếp xem cách bật giúp em",
    "host.nightly": "Lịch tự cập nhật ban đêm chưa chạy được — Sếp xem giúp em",
    "offsite.stale": "Bản sao ngoài máy chưa có hoặc đã cũ — Sếp cắm ổ hoặc chọn nơi lưu giúp em",
    "offsite.failed": "Sao lưu ra ổ ngoài chưa thành công — Sếp xem giúp em",
    "job.timeout": "Một việc nền chạy quá giờ — Sếp xem sức khoẻ hệ thống giúp em",
    "ai.budget_exceeded": "Chi phí AI hôm nay đã vượt trần — Sếp xem chi phí giúp em",
    "ai.background_no_source": "Việc nền chưa có nguồn AI dùng được — Sếp mở Bộ não AI giúp em",
    "telegram.failed": "Telegram gửi tin bị lỗi — Sếp mở cấu hình Telegram giúp em",
    "network.open_lan": "Cổng Console đang mở cho cả mạng — Sếp chọn cách truy cập giúp em",
    "social.session_expired": "Phiên Facebook đã hết — Sếp đăng nhập lại giúp em",
    "hub.unreachable": "Gen-hub không trả lời — Sếp kiểm tra thẻ Gen-hub giúp em",
}
HEALTH_WHY = {
    "bad": "Sự cố này đang ảnh hưởng tới việc hằng ngày nên em xếp lên đầu.",
    "warn": "Chưa gấp nhưng để lâu có thể thành sự cố lớn — Sếp xử lý khi tiện.",
}

#: Tiêu đề + lý do của việc tĩnh theo khoá. `drafts.pending` có số đếm nên dựng riêng (`drafts_title`).
TODO_COPY: dict[str, tuple[str, str]] = {
    "model.missing": ("Gen chưa có model để trả lời",
                      "Chưa gán model cho Gen và Sàng lọc thì em chưa trả lời hay lọc tin được — Sếp chọn model nhé."),
    "boss.hub": ("Nối Gen-hub rồi bấm Kiểm tra",
                 "Gen-hub là cầu để em đọc lịch, mail và Kho Ryan của Sếp."),
    "boss.facebook": ("Nối Facebook rồi bấm Kiểm tra",
                      "Có kết nối Facebook em mới đọc được thông báo, bình luận và tin nhắn giúp Sếp."),
    "boss.agy": ("Đăng nhập Google / Antigravity rồi thử gọi",
                 "Nguồn AI này dùng cho Gen của Sếp — thử gọi và đổi qua lại hai tài khoản để chắc là chạy được."),
    "boss.claude": ("Đăng nhập Claude Code CLI rồi thử gọi",
                    "Em cần Claude Code CLI đăng nhập xong mới dùng được nguồn AI này cho Sếp."),
    "boss.telegram": ("Nối Telegram để nhận báo động và bản tin",
                      "Có Telegram thì sự cố và bản tin sáng chiều tới thẳng điện thoại của Sếp."),
    "boss.remote": ("Thử mở Console từ điện thoại",
                    "Sếp mở được Console từ máy khác thì mới xử lý việc khi đi ngoài."),
    "backup.unset": ("Đặt lịch sao lưu",
                     "Chưa đặt lịch sao lưu thì hỏng ổ đĩa hay lỡ tay xoá là mất dữ liệu."),
    "hub.token_expiring": ("Token Gen-hub sắp hết hạn",
                           "Hết hạn thì em mất kết nối lịch, mail và Kho — Sếp tạo token mới ở thẻ Gen-hub."),
    "drafts.pending": ("Có bản nháp chờ Sếp duyệt",
                       "Em không tự gửi gì ra ngoài — nháp nằm chờ Sếp duyệt ở Bàn làm việc."),
    "followup.5": ("Kết nối Zalo / WhatsApp",
                   "Có kênh em mới đọc được tin nhắn trong các nhóm chat của Sếp."),
    "followup.6": ("Chọn nhóm cho agent lắng nghe",
                   "Mọi nhóm mới đều ở chế độ Không nghe — Sếp chọn nhóm nào em được nghe."),
    "followup.7": ("Bật sàng lọc dữ liệu",
                   "Tin thô được lọc và chấm điểm trước khi vào kho sạch — agent chỉ dùng dữ liệu đã lọc."),
    "followup.8": ("Tạo agent đầu tiên",
                   "Agent là nhân viên AI làm việc thay Sếp trên các kênh, có tên và giọng nói riêng."),
    "followup.9": ("Đặt mức tự trị cho agent",
                   "Sếp quyết định agent được tự làm tới đâu: chỉ gợi ý, hay soạn sẵn chờ Sếp duyệt."),
    "followup.10": ("Mời người trong đội",
                    "Quản lý, nhân viên cùng dùng Console với quyền riêng — mỗi người chỉ thấy phần được giao."),
}

DEFAULT_DISMISS_WARNING = "Tắt việc này thì em không nhắc lại nữa — Sếp bật lại được ở phần cài đặt Gen hướng dẫn."
#: Câu hậu quả tĩnh hiện trước khi Sếp chọn "Không dùng việc này" — mọi khoá P1/P3. `_default` cho khoá còn lại.
DISMISS_WARNINGS: dict[str, str] = {
    "_default": DEFAULT_DISMISS_WARNING,
    "health": "Bỏ qua thì sự cố này vẫn còn đó mà em không nhắc nữa.",
    "boss.hub": "Không nối Gen-hub thì Gen không đọc được lịch, mail và Kho Ryan của Sếp.",
    "boss.facebook": "Không nối Facebook thì Gen không đọc hay trả lời bình luận được.",
    "boss.agy": "Không đăng nhập Google / Antigravity thì Gen không dùng được nguồn AI này.",
    "boss.claude": "Không đăng nhập Claude Code CLI thì Gen không dùng được nguồn AI này.",
    "boss.telegram": "Không nối Telegram thì báo động và bản tin không tới điện thoại của Sếp.",
    "boss.remote": "Không thử truy cập từ xa thì Sếp có thể không mở được Console khi đi ngoài.",
    "backup.unset": "Không đặt lịch sao lưu thì hỏng ổ đĩa hay lỡ tay xoá là mất dữ liệu.",
    "hub.token_expiring": "Bỏ qua thì khi token hết hạn Gen mất kết nối lịch, mail và Kho.",
    "followup.5": "Không kết nối Zalo / WhatsApp thì hệ thống chưa có tin nhắn nào để làm việc.",
    "followup.6": "Không chọn nhóm lắng nghe thì agent không đọc nhóm nào cả.",
    "followup.7": "Không bật sàng lọc thì tin thô không được lọc và chấm điểm trước khi agent dùng.",
    "followup.8": "Không tạo agent thì chưa có nhân viên AI nào làm việc thay Sếp.",
    "followup.9": "Không đặt mức tự trị thì agent chưa biết được tự làm tới đâu.",
    "followup.10": "Không mời đội thì chỉ mình Sếp dùng Console.",
}


def dismiss_warning_for(key: str) -> str:
    if key.startswith("health."):
        return DISMISS_WARNINGS["health"]
    return DISMISS_WARNINGS.get(key) or DEFAULT_DISMISS_WARNING


def topic_of(key: str) -> str | None:
    """Chủ đề của khoá việc: tra khoá đầy đủ rồi bỏ dần đoạn cuối ('health.channel.down' → 'health')."""
    parts = key.split(".")
    while parts:
        t = TOPIC.get(".".join(parts))
        if t:
            return t
        parts.pop()
    return None


def health_kinds() -> frozenset[str]:
    return frozenset(health.ACTIONS) | frozenset(COACH_HEALTH_TITLES)


def static_todo_keys() -> frozenset[str]:
    """Khoá việc hợp lệ KHÔNG kể health.<kind>."""
    return frozenset(r.key for r in TODO_RULES if r.kind != "health")


def todo_key_known(key: str) -> bool:
    if key.startswith("health."):
        return key.removeprefix("health.") in health_kinds()
    return key in static_todo_keys()


def static_level(key: str) -> str | None:
    """Mức mặc định của khoá việc tĩnh; health.<kind> không có mức cố định (P0 nếu 'bad', P1 nếu 'warn')."""
    for r in TODO_RULES:
        if r.key == key and r.kind != "health":
            return r.level
    return None


def todo_copy(key: str) -> tuple[str, str]:
    """(tiêu đề, lý do) tĩnh của việc. Dòng "Việc Sếp cần làm" mới (chưa có câu riêng) vẫn có câu chung — không để
    thêm một dòng bắt buộc làm hỏng cả thẻ."""
    if key in TODO_COPY:
        return TODO_COPY[key]
    for row in boss_service.ROWS:
        if key == f"boss.{row['key']}":
            return (f"Hoàn tất mục {row['title']} ở Việc Sếp cần làm",
                    "Mục này còn thiếu trong danh sách việc bắt buộc — Sếp mở Việc Sếp cần làm để làm tiếp.")
    return (GENERIC_HEALTH_TITLE, HEALTH_WHY["warn"])


def drafts_title(n: int) -> str:
    return f"Có {n} bản nháp chờ Sếp duyệt"


def health_title(kind: str) -> str:
    return COACH_HEALTH_TITLES.get(kind, GENERIC_HEALTH_TITLE)


# ─── biểu thức điều kiện ─────────────────────────────────────────────────────────────────────────────────────

def eval_cond(expr_list: Iterable[str] | None, state: Mapping[str, bool]) -> bool:
    """Biểu thức = danh sách tên tín hiệu, AND; tiền tố '!' = phủ định. Tín hiệu CHƯA biết (nguồn lỗi nên vắng trong
    `state`) làm cả biểu thức sai — không khẳng định điều chưa đọc được. Danh sách rỗng ⇒ đúng."""
    for raw in expr_list or ():
        name = raw.strip()
        negate = name.startswith("!")
        name = name.lstrip("!").strip()
        if name not in state:
            return False
        if bool(state[name]) == negate:
            return False
    return True


# ─── Signals ──────────────────────────────────────────────────────────────────────────────────────────────────

@dataclass
class Signals:
    state: dict[str, bool] = field(default_factory=dict)
    #: [{kind, severity, link, raised_at}] — mỗi sự cố đang mở một dòng (chưa gộp theo kind).
    alerts: list[dict[str, Any]] = field(default_factory=list)
    #: Lần mở sự cố bad/warn mới nhất (kể cả sự cố đã đóng) — mốc cho `update_stable`.
    last_alert_raised_at: str | None = None
    required_done: int = 0
    required_total: int = boss_service.REQUIRED_TOTAL
    drafts_pending: int = 0
    hub_days_left: int | None = None
    hub_expiring: bool = False
    #: Tên các nguồn đọc lỗi lần này (mục tương ứng bị bỏ).
    failed: list[str] = field(default_factory=list)

    def p01_known(self) -> bool:
        """Có đọc được đủ nguồn sinh việc P0/P1 không? Thiếu nguồn ⇒ KHÔNG biết có việc P0/P1 hay không, nên không được
        coi là 'không có việc' để bắt đầu đếm ngày ổn định."""
        return not set(self.failed) & P01_SOURCES

    def to_dict(self) -> dict[str, Any]:
        return {"state": self.state, "alerts": self.alerts, "last_alert_raised_at": self.last_alert_raised_at,
                "required_done": self.required_done, "required_total": self.required_total,
                "drafts_pending": self.drafts_pending, "hub_days_left": self.hub_days_left,
                "hub_expiring": self.hub_expiring, "failed": self.failed}

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Signals":
        return cls(state={str(k): bool(v) for k, v in dict(d.get("state") or {}).items() if k in STATE_SIGNALS},
                   alerts=[dict(a) for a in (d.get("alerts") or []) if isinstance(a, dict)],
                   last_alert_raised_at=d.get("last_alert_raised_at"),
                   required_done=int(d.get("required_done") or 0),
                   required_total=int(d.get("required_total") or boss_service.REQUIRED_TOTAL),
                   drafts_pending=int(d.get("drafts_pending") or 0), hub_days_left=d.get("hub_days_left"),
                   hub_expiring=bool(d.get("hub_expiring")), failed=[str(x) for x in (d.get("failed") or [])])


def parse_ts(value: Any) -> datetime | None:
    return health._parse_ts(value)


def group_alerts(alerts: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Gộp nhiều sự cố cùng kind (channel.down:<id>…) thành MỘT dòng: mức 'bad' nếu có sự cố bad, còn lại 'warn';
    liên kết + raised_at lấy của sự cố MỚI nhất. Sắp theo raised_at giảm dần (mới nhất trước), rồi theo kind."""
    best: dict[str, dict[str, Any]] = {}
    for a in alerts:
        kind = str(a.get("kind") or "")
        if not kind:
            continue
        raised = parse_ts(a.get("raised_at"))
        cur = best.get(kind)
        if cur is None:
            best[kind] = {"kind": kind, "severity": "bad" if a.get("severity") == "bad" else "warn",
                          "link": a.get("link"), "raised_at": a.get("raised_at"), "_t": raised}
            continue
        if a.get("severity") == "bad":
            cur["severity"] = "bad"
        old = cur["_t"]
        if raised is not None and (old is None or raised > old):
            cur.update(link=a.get("link"), raised_at=a.get("raised_at"), _t=raised)
    out = sorted(best.values(), key=lambda g: (g["_t"] is None, -(g["_t"].timestamp() if g["_t"] else 0), g["kind"]))
    return [{k: v for k, v in g.items() if k != "_t"} for g in out]


# ─── nguồn ────────────────────────────────────────────────────────────────────────────────────────────────────

def _iso(dt: datetime | None) -> str | None:
    return health._iso(dt)


async def _src_health(db: AsyncSession, redis: Any, org: uuid.UUID) -> dict[str, Any]:
    issues = await health.active_issues(db, org, is_owner=True)
    alerts = [{"kind": str(i["kind"]), "severity": str(i["severity"]), "link": i.get("link"),
               "raised_at": i.get("raised_at")} for i in issues]
    last = (await db.execute(text("""SELECT max(raised_at) FROM ops.health_alerts
                                     WHERE org_id = :o AND severity IN ('bad', 'warn')"""),
                             {"o": org})).scalar_one_or_none()
    return {"alerts": alerts, "last_alert_raised_at": _iso(last)}


async def _src_boss(db: AsyncSession, redis: Any, org: uuid.UUID) -> dict[str, Any]:
    ov = await boss_service.overview(db, org)
    state = {f"boss.{r['key']}.done": bool(r["done"]) for r in ov["rows"]}
    hub_res = (ov.get("results") or {}).get("hub") or {}
    missing = (hub_res.get("detail") or {}).get("write_missing")
    state["hub.kho_write_missing"] = isinstance(missing, list) and len(missing) > 0   # chỉ cờ, không giữ nội dung
    return {"state": state, "required_done": int(ov["required_done"]), "required_total": int(ov["required_total"])}


async def _src_followup(db: AsyncSession, redis: Any, org: uuid.UUID) -> dict[str, Any]:
    from gh.setup.routes import follow_up_status

    row = (await db.execute(text("SELECT org_id, completed FROM ops.setup_state WHERE org_id = :o"),
                            {"o": org})).one_or_none()
    if row is None:
        return {}
    state: dict[str, bool] = {}
    for it in await follow_up_status(db, row):
        n = it.get("n")
        if n == 4:    # bước 4 "Bộ não AI": cùng điều kiện với NoModelBanner (FOLLOW_UP_SQL[4])
            state["model.bound"] = bool(it.get("done"))
        elif n in FOLLOWUP_NS:
            state[f"followup.{n}.done"] = bool(it.get("done"))
    return {"state": state}


async def _src_settings(db: AsyncSession, redis: Any, org: uuid.UUID) -> dict[str, Any]:
    r = (await db.execute(text("""SELECT (settings ? 'backup') AS backup,
                                         settings->'ai_cost'->'daily_budget_vnd' AS budget
                                  FROM core.organizations WHERE id = :o"""), {"o": org})).one_or_none()
    if r is None:
        return {}
    budget = r.budget
    return {"state": {"backup.scheduled": bool(r.backup),
                      "ai_budget.set": isinstance(budget, int | float) and not isinstance(budget, bool)}}


async def _src_offsite(db: AsyncSession, redis: Any, org: uuid.UUID) -> dict[str, Any]:
    from gh.system_api import offsite as offsite_api

    d = health._host_dir()
    if not d.is_dir():      # bản phát triển không có hộp thư với genh ⇒ chưa biết, không khẳng định "chưa chọn"
        return {}
    return {"state": {"offsite.chosen": bool(offsite_api.read_status(d)["configured"])}}


async def _src_hub(db: AsyncSession, redis: Any, org: uuid.UUID) -> dict[str, Any]:
    from gh.hub_link import service as hub

    link = hub.link_out(await hub.load(db, org))
    days = link.get("days_left")
    limit = min(HUB_TOKEN_WARN_DAYS, hub.EXPIRY_WARN_DAYS)
    expiring = bool(link.get("configured") and link.get("has_token") and isinstance(days, int) and days <= limit)
    return {"hub_days_left": days if isinstance(days, int) else None, "hub_expiring": expiring}


async def _src_drafts(db: AsyncSession, redis: Any, org: uuid.UUID) -> dict[str, Any]:
    # Cùng SQL đếm với `gh.gen.briefing._drafts_pending` (không import briefing để tránh vòng import với gh.gen.engine).
    n = int((await db.execute(text("SELECT count(*) FROM biz.action_drafts WHERE org_id = :o AND status = 'pending'"),
                              {"o": org})).scalar_one())
    return {"state": {"drafts.any": n > 0}, "drafts_pending": n}


async def _src_telegram(db: AsyncSession, redis: Any, org: uuid.UUID) -> dict[str, Any]:
    from gh.telegram import service as telegram

    row = await telegram.get_config(db, org)
    return {"state": {"telegram.briefing_on": bool(row is not None and row.enabled and row.briefing)}}


async def _src_memory(db: AsyncSession, redis: Any, org: uuid.UUID) -> dict[str, Any]:
    n = int((await db.execute(text("SELECT count(*) FROM agent.gen_memory_notes WHERE org_id = :o"),
                              {"o": org})).scalar_one())
    return {"state": {"memory.empty": n == 0}}


async def _src_api_key(db: AsyncSession, redis: Any, org: uuid.UUID) -> dict[str, Any]:
    from gh.providers.router import has_api_source

    return {"state": {"api_key.present": await has_api_source(db, org)}}


async def _src_pin(db: AsyncSession, redis: Any, org: uuid.UUID) -> dict[str, Any]:
    ok = (await db.execute(text("""
        SELECT EXISTS (SELECT 1 FROM core.users u JOIN core.user_roles ur ON ur.user_id = u.id
                       JOIN core.roles r ON r.id = ur.role_id
                       WHERE u.org_id = :o AND u.is_active AND u.deleted_at IS NULL AND r.code = 'owner'
                         AND u.pin_hash IS NOT NULL)"""), {"o": org})).scalar_one()
    return {"state": {"pin.set": bool(ok)}}


#: Các nguồn quyết định việc P0/P1: sự cố sức khoẻ, model (bước 4), dòng bắt buộc, lịch sao lưu, token Gen-hub.
P01_SOURCES = frozenset({"health", "boss", "followup", "settings", "hub"})

Source = Callable[[AsyncSession, Any, uuid.UUID], Awaitable[dict[str, Any]]]


def _sources() -> list[tuple[str, Source]]:
    """Tra tên hàm lúc gọi (không giữ tham chiếu cũ) để test đếm / thay nguồn bằng monkeypatch."""
    g = globals()
    return [(n, g[f"_src_{n}"]) for n in ("health", "boss", "followup", "settings", "offsite", "hub", "drafts",
                                           "telegram", "memory", "api_key", "pin")]


def _merge(sig: Signals, part: Mapping[str, Any]) -> None:
    for k, v in dict(part.get("state") or {}).items():
        if k in STATE_SIGNALS:
            sig.state[k] = bool(v)
    for attr in ("alerts", "last_alert_raised_at", "required_done", "required_total", "drafts_pending",
                 "hub_days_left", "hub_expiring"):
        if attr in part:
            setattr(sig, attr, part[attr])


async def collect(db: AsyncSession, redis: Any, org_id: uuid.UUID) -> Signals:
    """Tín hiệu của tổ chức (cache 60 giây). Không ghi gì vào CSDL; nguồn lỗi/quá 2 giây thì bỏ mục đó."""
    key = CACHE_KEY.format(org_id)
    if redis is not None:
        try:
            raw = await redis.get(key)
            if raw:
                return Signals.from_dict(orjson.loads(raw))
        except Exception:  # noqa: BLE001 — cache hỏng thì đọc lại nguồn
            log.warning("Gen hướng dẫn: không đọc được cache tín hiệu", exc_info=False)
    sig = Signals()
    for name, fn in _sources():
        try:
            async with db.begin_nested():
                part = await asyncio.wait_for(fn(db, redis, org_id), SOURCE_TIMEOUT_S)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — một nguồn lỗi chỉ làm mất mục của nó
            log.warning("Gen hướng dẫn: bỏ nguồn %s (%s)", name, type(exc).__name__)
            sig.failed.append(name)
            continue
        _merge(sig, part)
    if redis is not None:
        try:
            await redis.set(key, orjson.dumps(sig.to_dict()), ex=CACHE_TTL_S)
        except Exception:  # noqa: BLE001
            log.warning("Gen hướng dẫn: không ghi được cache tín hiệu", exc_info=False)
    return sig
