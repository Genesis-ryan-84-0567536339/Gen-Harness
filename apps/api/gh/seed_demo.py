"""Seed dữ liệu mẫu cho môi trường demo (PLAN §5.1).

Không tự viết `INSERT` thẳng vào `clean.*`/`biz.*`: mọi kết luận sạch đi qua đúng luồng thật của kiến trúc
(ARCHITECTURE §4) — `gh.data.ingest.ingest_message` (bridge → Kho thô) rồi `gh.refinery.runner.Refinery` (Kho
thô → Kho sạch, cùng bộ quy tắc R-01…R-06 thật của `gh.refinery.presets`) rồi các hook nghiệp vụ thật
(`gh.biz.market.jobs`, `gh.biz.people.jobs`, `gh.biz.queue.jobs`) sinh cơ hội/tín hiệu thị trường/cảnh báo/đánh
giá con người. Vì không có model LLM thật trong môi trường seed, bước trích xuất (bước 2 của sàng lọc) dùng
`SeedRouter` — cùng vai trò `FakeRouter` ở `tests/phase2.py` (mọi test giai đoạn 2-4 cũng không gọi LLM thật):
trả kết luận đã soạn sẵn cho từng câu chữ cụ thể, còn quy tắc tất định (bước 1) vẫn là mã thật không giả lập.

Nội dung mẫu giữ đúng tên người/nhóm/công ty xuất hiện trong `docs/design/seed-data.json` (Trần Văn Hậu, Nguyễn
Văn Bảo, Hoàng Thị Lan, Group Ngành gỗ Miền Nam, Đối tác in ấn Thành Phát…) để so ảnh giai đoạn 5.2 dễ khớp.

**Vì sao không xoá được `raw.events`** (quan trọng cho `clear_demo`): bảng thô có trigger
`raw_events_append_only` (`core.forbid_mutation`, `db/sql/0001_baseline.sql`) chặn tuyệt đối UPDATE/DELETE —
đây là luật cứng R1, không có đường vòng, kể cả cho dữ liệu mẫu. Vì vậy "xoá dữ liệu mẫu" ở đây nghĩa là: xoá
sạch mọi *kết luận* sinh ra từ các tin mẫu (`clean.*`, `biz.*`, `ops`/`biz.alerts`, `memory.entries`) và các đối
tượng tạo trực tiếp ngoài luồng ingest (agent, provider, model demo) — còn các tin thô mẫu tự thân, cùng
`core.persons`/`core.groups` mà chúng tham chiếu, vẫn còn (như một bản ghi lịch sử bất biến thật sự phải có).
Để việc gọi lại `seed_demo` sau khi `clear_demo` phục dựng đúng kết luận, `clear_demo` đưa `refinery.event_state`
của các tin mẫu về lại `pending` — `seed_demo` gọi lại `Refinery` sẽ sàng lọc lại đúng các tin đó.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, time, timedelta
from typing import Any

import orjson
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from gh import bootstrap as bootstrap_mod
from gh.biz.hooks import HookCtx
from gh.biz.market.jobs import market_signal_capture, recompute_matches_org
from gh.biz.people.jobs import period_for, recompute_people_reviews_org
from gh.biz.queue.jobs import early_warning_scan
from gh.config import get_settings
from gh.data.ingest import ingest_message
from gh.db import sessionmaker
from gh.providers.clients import Message
from gh.providers.router import Routed
from gh.refinery.runner import Refinery

log = logging.getLogger("gh.seed_demo")

# Không gian tên riêng cho mọi thực thể do seed tạo — vừa để idempotent (khoá trùng theo mã ngoài có sẵn của
# ingest), vừa để `clear_demo` tìm lại đúng những gì chính nó đã tạo mà không đụng dữ liệu thật của tổ chức.
NS = "seed-demo"
MSG_PREFIX = f"{NS}-msg-"


def _mid(i: int) -> str:
    return f"{MSG_PREFIX}{i:03d}"


def _gext(key: str) -> str:
    return f"{NS}-group-{key}"


def _pext(key: str) -> str:
    return f"{NS}-person-{key}"


# ═══ Danh bạ mẫu (giữ đúng tên trong design/seed-data.json) ═════════════════

@dataclass(frozen=True)
class Person:
    key: str
    name: str
    channel: str
    organization_name: str | None = None
    title: str | None = None
    person_type: str = "unknown"          # customer | partner | staff | candidate | supplier | unknown
    relation_to_owner: str | None = None


PEOPLE = [
    Person("hau", "Trần Văn Hậu", "zalo", "Xưởng gỗ Bình Dương", "chủ xưởng", "customer", "direct"),
    Person("duoc", "Lâm Văn Được", "zalo", "Kho ván Bình Dương", "chủ kho", "supplier", "stranger"),
    Person("phuc", "Bùi Văn Phúc", "zalo", "Gỗ Trường Thành Mới", "phụ trách mua hàng", "customer", "stranger"),
    Person("tung", "Ngô Thanh Tùng", "zalo", "Gỗ Phát Đạt", "kinh doanh", "supplier", "stranger"),
    Person("minh", "Phạm Quốc Minh", "zalo", "Nội thất Minh Long", None, "customer", "via_staff"),
    Person("duyen", "Trịnh Mỹ Duyên", "zalo", "Gỗ Đông Phương", None, "customer", "stranger"),
    Person("bao", "Nguyễn Văn Bảo", "zalo", "Công ty in Thành Phát", "giám đốc", "customer", "direct"),
    Person("son", "Võ Thanh Sơn", "zalo", None, "key account ngành lạnh", "candidate", "stranger"),
    Person("bich", "Lê Thị Bích", "whatsapp", "Kho lạnh Tân Cảng", "quản lý", "customer", "stranger"),
    Person("lan", "Hoàng Thị Lan", "whatsapp", "An Khang Logistics", "sales director", "customer", "via_staff"),
    Person("ha", "Nguyễn Thu Hà", "zalo", None, "Trưởng ban Tài chính", "staff", "staff"),
    Person("mai", "Đỗ Thanh Mai", "zalo", None, "Kế toán trưởng", "staff", "staff"),
]
PEOPLE_BY_KEY = {p.key: p for p in PEOPLE}


@dataclass(frozen=True)
class Group:
    key: str
    name: str
    channel: str
    mode: str              # tagged_only | silent | proactive


GROUPS = [
    Group("genesis_q4", "Vận hành Genesis — Quý 4", "zalo", "tagged_only"),
    Group("go_mien_nam", "Group Ngành gỗ Miền Nam", "zalo", "silent"),
    Group("tai_chinh", "Ban Tài chính", "zalo", "tagged_only"),
    Group("nhansu_logistics", "Group Nhân sự Logistics", "zalo", "silent"),
    Group("doitac_thanhphat", "Đối tác in ấn Thành Phát", "zalo", "proactive"),
    Group("mo_rong", "Điều hành mở rộng", "whatsapp", "tagged_only"),
    Group("kho_lanh_tancang", "Kho lạnh Tân Cảng", "whatsapp", "silent"),
]
GROUPS_BY_KEY = {g.key: g for g in GROUPS}


# ═══ Kịch bản tin nhắn thô (đúng envelope bridge → gh.data.ingest.ingest_message) ═══════════════════════════

@dataclass(frozen=True)
class Msg:
    n: int
    sender: str                    # khoá trong PEOPLE
    text: str
    group: str | None = None       # khoá trong GROUPS, None = tin riêng
    kind: str = "text"
    mentions: bool = False
    direction: str = "inbound"
    when: timedelta = field(default_factory=lambda: timedelta())   # lệch so với mốc thời gian (âm = quá khứ)
    anchor: str = "now"            # "now" (phiên chạy seed) | "period" (kỳ 7 ngày gần nhất đã trọn vẹn)
    unit: dict[str, Any] | None = None   # kết luận SeedRouter trả cho model (None = để rule/model tự coi là nhiễu)


def _ago(**kw: float) -> timedelta:
    """Độ lệch âm (quá khứ) so với mốc thời gian của kịch bản (`m.anchor`)."""
    return -timedelta(**kw)


# Cơ hội & tín hiệu thị trường (Group Ngành gỗ Miền Nam) — khớp meaningItems OPP-1842 và biz.matches thiết kế.
MARKET = [
    Msg(1, "hau", "Bên nào có sẵn MDF E1 17mm khổ 1220x2440 cho em 3 cont trong tháng 10 không ạ, ngân sách tầm "
              "1.2 tỷ, ưu tiên giao tận xưởng Bình Dương.", group="go_mien_nam", when=_ago(minutes=18),
        unit={"event_type": "AskedPrice", "side": "demand", "confidence": 0.96,
              "conclusion": "Xưởng gỗ Bình Dương cần 3 container ván MDF E1 17mm, giao trong tháng 10.",
              "entities": {"product": "Ván MDF E1 17mm", "qty": 3, "unit": "container",
                           "budget_vnd": 1_200_000_000, "place": "Bình Dương", "deadline": "tháng 10"},
              "rules": {"R-01": 0.92}, "signals": {"heat": 91, "potential": 40}}),
    Msg(2, "duoc", "Mình có kho ở Bình Dương, còn tồn 6 cont E1 17mm, ai cần inbox mình nhé.", group="go_mien_nam",
        when=_ago(minutes=25),
        unit={"event_type": "OfferedSupply", "side": "supply", "confidence": 0.91,
              "conclusion": "Kho ván Bình Dương còn tồn 6 container ván MDF E1 17mm.",
              "entities": {"product": "Ván MDF E1 17mm", "qty": 6, "unit": "container", "place": "Bình Dương"},
              "rules": {"R-02": 0.9}, "signals": {"potential": 84}}),
    Msg(3, "phuc", "ai co nguon van phu melamine gia si k a", group="go_mien_nam", when=_ago(minutes=32),
        unit={"event_type": "AskedPrice", "side": "demand", "confidence": 0.52,
              "conclusion": "Hỏi nguồn ván phủ melamine giá sỉ, chưa rõ số lượng.",
              "entities": {"product": "Ván phủ melamine"}, "rules": {"R-01": 0.5},
              "signals": {"heat": 30, "potential": 10}}),
    Msg(4, "tung", "Bên mình còn tồn ván phủ melamine 12mm giá sỉ, số lượng lớn, ai cần báo em.",
        group="go_mien_nam", when=_ago(minutes=40),
        unit={"event_type": "OfferedSupply", "side": "supply", "confidence": 0.7,
              "conclusion": "Gỗ Phát Đạt còn tồn ván phủ melamine 12mm giá sỉ, số lượng lớn.",
              "entities": {"product": "Ván phủ melamine 12mm", "unit": "tấm"}, "rules": {"R-02": 0.75},
              "signals": {"potential": 55}}),
    Msg(5, "minh", "giá bên minh long đang thấp hơn 4% đó anh, anh xem lại giúp em", group="go_mien_nam",
        when=_ago(minutes=50),
        unit={"event_type": "MentionsCompetitor", "side": None, "confidence": 0.79,
              "conclusion": "Khách nhắc bên Minh Long chào giá thấp hơn 4%, cần xem lại giá.",
              "entities": {"competitor": "Minh Long"}, "rules": {"R-04": 0.7}, "signals": {"churn_risk": 15}}),
    Msg(6, "duoc", "Đơn hàng cont trước giao trễ 4 ngày, khách bên em phàn nàn nhiều lắm.", group="go_mien_nam",
        when=_ago(hours=1),
        unit={"event_type": "Complained", "side": None, "confidence": 0.6,
              "conclusion": "Đơn hàng container trước giao trễ 4 ngày, khách hạ nguồn đang phàn nàn.",
              "entities": {}, "rules": {}, "signals": {"churn_risk": 20}}),
    # Khách đang nguội (>14 ngày, ≥2 đơn vị ý nghĩa) — nuôi cảnh báo customer_cooling thật.
    Msg(7, "duyen", "Bên mình có kế hoạch nhập ván MDF quý sau, cho em xin báo giá sỉ.", group="go_mien_nam",
        when=_ago(days=74, hours=2),
        unit={"event_type": "AskedPrice", "side": "demand", "confidence": 0.7,
              "conclusion": "Gỗ Đông Phương hỏi báo giá sỉ ván MDF cho kế hoạch nhập quý sau.",
              "entities": {"product": "Ván MDF"}, "rules": {"R-01": 0.6}, "signals": {"heat": 40}}),
    Msg(8, "duyen", "Anh chị có mẫu ván phủ melamine gửi em tham khảo trước được không ạ?", group="go_mien_nam",
        when=_ago(days=74),
        unit={"event_type": "AskedPrice", "side": "demand", "confidence": 0.65,
              "conclusion": "Gỗ Đông Phương hỏi xin mẫu ván phủ melamine để tham khảo.",
              "entities": {"product": "Ván phủ melamine"}, "rules": {"R-01": 0.55}, "signals": {"heat": 35}}),
]

# Cảnh báo bất mãn thật (repeat_unanswered ≥ 2 + từ khoá tiêu cực + phương án thay thế — quy tắc R-03 tất định
# thật sự chấm khớp trên 3 tin liên tiếp không ai trả lời) — khớp meaningItems ALR-0233.
COMPLAINT = [
    Msg(9, "bao", "Anh gửi ảnh mẫu bao bì rồi đó, bên em coi giúp anh chưa ạ", group="doitac_thanhphat",
        when=_ago(hours=3, minutes=20)),
    Msg(10, "bao", "Sao chưa thấy phản hồi vậy em, xưởng anh đang cần gấp", group="doitac_thanhphat",
        when=_ago(hours=2, minutes=40)),
    Msg(11, "bao", "Anh hỏi ba lần rồi mà không ai trả lời. Nếu bên mình không làm được thì nói thẳng để anh tìm "
                 "chỗ khác nhé.", group="doitac_thanhphat", when=_ago(hours=2, minutes=14),
        unit={"event_type": "Complained", "side": None, "confidence": 0.94,
              "conclusion": "Khách Thành Phát nhắc ba lần không ai trả lời, doạ chuyển sang nhà cung cấp khác.",
              "entities": {}, "rules": {"R-03": 0.9}, "signals": {"churn_risk": 60}}),
    Msg(12, "duyen", "Sticker", group="doitac_thanhphat", kind="sticker", when=_ago(hours=1)),
]

# Nội bộ + nhiễu (khớp rawRows "ok a" / SentDocument).
INTERNAL = [
    Msg(13, "mai", "Ok chị đã gửi bản hợp đồng sửa vào kho tài liệu rồi nhé", group="genesis_q4", mentions=True,
        when=_ago(minutes=8),
        unit={"event_type": "SentDocument", "side": None, "confidence": 0.86,
              "conclusion": "Đã gửi bản hợp đồng sửa vào kho tài liệu.", "entities": {}, "rules": {},
              "signals": {}}),
    Msg(14, "hau", "ok a", group="genesis_q4", when=_ago(minutes=9)),   # bị loại bởi R-06 (max_words), không tốn model
    Msg(15, "lan", "Em gửi lại file khảo sát qua đây cho nhanh nha anh", group="mo_rong", when=_ago(minutes=12),
        unit={"event_type": "SentDocument", "side": None, "confidence": 0.88,
              "conclusion": "Đã gửi lại file khảo sát qua kênh WhatsApp.", "entities": {}, "rules": {},
              "signals": {}}),
]

# Kho lạnh Tân Cảng — cầu/cung khớp nhau (biz.matches "128 triệu ₫").
COLD_CHAIN = [
    Msg(16, "bich", "Cần kho lạnh 400 pallet khu Tân Cảng, giá sao ạ", group="kho_lanh_tancang",
        when=_ago(hours=1, minutes=5),
        unit={"event_type": "AskedPrice", "side": "demand", "confidence": 0.82,
              "conclusion": "Kho lạnh Tân Cảng cần thuê kho lạnh 400 pallet.",
              "entities": {"product": "Kho lạnh", "qty": 400, "unit": "pallet", "place": "Tân Cảng"},
              "rules": {"R-01": 0.8}, "signals": {"heat": 78}}),
    Msg(17, "lan", "Bên An Khang có tuyến vận chuyển lạnh Bình Dương – Tân Cảng đang trống tải, ai cần báo em.",
        group="kho_lanh_tancang", when=_ago(hours=1),
        unit={"event_type": "OfferedSupply", "side": "supply", "confidence": 0.8,
              "conclusion": "An Khang Logistics còn trống tải tuyến vận chuyển lạnh Bình Dương – Tân Cảng.",
              "entities": {"product": "Tuyến vận chuyển lạnh", "place": "Bình Dương – Tân Cảng"},
              "rules": {"R-02": 0.7}, "signals": {"potential": 60}}),
]

# Tín hiệu ứng viên (R-05) — khớp meaningItems OPP-1839.
CANDIDATE = [
    Msg(18, "son", "Mình làm key account ngành lạnh 5 năm, đang tính đổi hướng sang gỗ nội thất, ai cần tư vấn "
                 "tuyến Bình Dương thì inbox mình.", group="nhansu_logistics", when=_ago(hours=6),
        unit={"event_type": "JobSignal", "side": None, "confidence": 0.68,
              "conclusion": "Người trong group nêu 5 năm kinh nghiệm key account ngành lạnh, đang tìm hướng mới.",
              "entities": {}, "rules": {"R-05": 0.75}, "signals": {"fit": 74}}),
]


def _care_messages(period_mid: datetime) -> list[Msg]:
    """Cặp khách hỏi → nhân viên trả lời trong Ban Tài chính, trong kỳ 7 ngày gần nhất đã trọn vẹn
    (`gh.biz.people.jobs.period_for`) — nuôi lưới phản hồi thật cho `recompute_people_reviews_org`
    (khớp reviewRows: Thu Hà trả lời chậm ~84 phút, Mai trả lời nhanh)."""
    return [
        Msg(19, "lan", "Bên em vẫn chưa nhận được biên bản đối chiếu công nợ tháng 8, chị kiểm tra giúp em với",
            group="tai_chinh", when=timedelta(0), anchor="period",
            unit={"event_type": "AskedStatus", "side": None, "confidence": 0.8,
                  "conclusion": "An Khang hỏi lại biên bản đối chiếu công nợ tháng 8.", "entities": {},
                  "rules": {}, "signals": {}}),
        Msg(20, "ha", "Chị kiểm tra rồi gửi lại em nhé, xin lỗi vì phản hồi trễ", group="tai_chinh",
            direction="outbound", when=timedelta(minutes=84), anchor="period"),
        Msg(21, "minh", "Bên em hỏi lại điều khoản thanh toán đợt hàng vừa rồi ạ", group="tai_chinh",
            when=timedelta(hours=4), anchor="period",
            unit={"event_type": "AskedStatus", "side": None, "confidence": 0.78,
                  "conclusion": "Minh Long hỏi lại điều khoản thanh toán đợt hàng vừa rồi.", "entities": {},
                  "rules": {}, "signals": {}}),
        Msg(22, "mai", "Dạ điều khoản vẫn như cũ, em gửi lại hợp đồng ngay đây ạ", group="tai_chinh",
            direction="outbound", when=timedelta(hours=4, minutes=8), anchor="period"),
    ]


def all_messages(period_mid: datetime) -> list[Msg]:
    return MARKET + COMPLAINT + INTERNAL + COLD_CHAIN + CANDIDATE + _care_messages(period_mid)


# ═══ SeedRouter — vai trò FakeRouter (tests/phase2.py) cho môi trường seed, không gọi LLM thật ═══════════════

def _refs_texts(messages: list[Message]) -> list[tuple[str, str]]:
    body = messages[-1].content.split("Tin nhắn (mỗi dòng một JSON):\n", 1)[1]
    out = []
    for line in body.splitlines():
        if line.strip():
            d = orjson.loads(line)
            out.append((d["ref"], d["text"]))
    return out


class SeedRouter:
    """Bước 2 của sàng lọc (trích xuất) giả lập: mỗi câu chữ mẫu ứng với một kết luận soạn sẵn ở trên; câu chữ
    không có trong kịch bản → coi là nhiễu. Bước 1 (quy tắc tất định) vẫn là `gh.refinery.rules` thật."""

    def __init__(self, unit_of: dict[str, dict[str, Any]]):
        self.unit_of = unit_of

    async def generate(self, org_id: uuid.UUID, *, agent_key: str, purpose: str, messages: list[Message],
                       json_mode: bool = True, temperature: float = 0.2) -> Routed:
        units, noise = [], []
        for ref, txt in _refs_texts(messages):
            spec = self.unit_of.get(txt)
            if spec is None:
                noise.append(ref)
                continue
            units.append({**spec, "evidence": [ref]})
        payload = orjson.dumps({"units": units, "noise": noise}).decode()
        return Routed(payload, "seed", "seed-demo-router", len(payload), 0)

    async def embed(self, org_id: uuid.UUID, texts: list[str]) -> list[list[float]] | None:
        return None  # không có embedding thật trong seed — hạn chế đã biết, xem báo cáo


# ═══ Ingest qua đúng luồng thật (bridge giả lập → gh.data.ingest.ingest_message) ═══════════════════════════

async def _channel_id(db: AsyncSession, org_id: uuid.UUID, type_: str) -> uuid.UUID:
    return (await db.execute(text("SELECT id FROM core.channels WHERE org_id = :o AND type = :t"),
                             {"o": org_id, "t": type_})).scalar_one()


async def _ensure_group(db: AsyncSession, org_id: uuid.UUID, g: Group) -> None:
    """Nhóm mới luôn 'Không nghe' (khoá cứng) — bơm một tin dò để hệ thống thật tạo dòng nhóm, rồi Owner (ở đây
    là script seed, đứng vai Owner) bật lắng nghe đúng như UI thật làm."""
    await ingest_message(db, org_id, {"channel": g.channel, "external_group_id": _gext(g.key),
                                      "group_name": g.name, "external_msg_id": f"{NS}-probe-{g.key}",
                                      "sender_external_id": f"{NS}-probe", "body_text": "probe"})
    await db.execute(text("UPDATE core.groups SET listen_mode = :m WHERE org_id = :o AND external_id = :x"),
                     {"m": g.mode, "o": org_id, "x": _gext(g.key)})


async def _ingest_all(db: AsyncSession, org_id: uuid.UUID, msgs: list[Msg], now: datetime,
                      period_mid: datetime) -> list[uuid.UUID]:
    ids: list[uuid.UUID] = []
    for m in msgs:
        p = PEOPLE_BY_KEY[m.sender]
        base = period_mid if m.anchor == "period" else now
        payload: dict[str, Any] = {
            "channel": p.channel, "external_msg_id": _mid(m.n), "sender_external_id": _pext(m.sender),
            "sender_name": p.name, "body_text": m.text, "kind": m.kind, "mentions_self": m.mentions,
            "direction": m.direction, "occurred_at": (base + m.when).isoformat(),
        }
        if m.group:
            g = GROUPS_BY_KEY[m.group]
            payload |= {"external_group_id": _gext(g.key), "group_name": g.name}
        eid = await ingest_message(db, org_id, payload)
        if eid is not None:
            ids.append(eid)
    return ids


async def _enrich_persons(db: AsyncSession, org_id: uuid.UUID) -> None:
    """Bổ sung hồ sơ (tổ chức, chức danh, loại người, quan hệ) — `ingest_message` chỉ biết tên hiển thị; đây là
    cập nhật mô tả trên bảng mutable (`core.persons`), không phải bịa kết luận sạch."""
    for p in PEOPLE:
        cid = await _channel_id(db, org_id, p.channel)
        await db.execute(text("""
            UPDATE core.persons SET organization_name = COALESCE(:org, organization_name),
                   title = COALESCE(:title, title),
                   person_type = CASE WHEN person_type = 'unknown' THEN :pt ELSE person_type END,
                   relation_to_owner = COALESCE(:rel, relation_to_owner)
            WHERE id = (SELECT person_id FROM core.person_identities WHERE channel_id = :c AND external_id = :x)"""),
            {"org": p.organization_name, "title": p.title, "pt": p.person_type, "rel": p.relation_to_owner,
             "c": cid, "x": _pext(p.key)})


# ═══ Agent, provider, model mẫu (bảng ngoài luồng sàng lọc — service layer trực tiếp) ═══════════════════════

DEMO_AGENTS = [
    {"name": "Trợ lý thương mại", "role_desc": "Báo giá, hợp đồng, follow khách", "template": "commercial",
     "voice": "lễ phép, ngắn gọn, không hứa mốc chưa xác nhận", "speak_when": "khi được tag, hoặc khi khách hỏi giá",
     "forbidden": ["không tự cam kết giá", "không đàm phán điều khoản"], "autonomy_level": 4},
    {"name": "Key Account junior", "role_desc": "Canh group ngành, bắt tín hiệu cơ hội", "template": "key_account",
     "voice": "thân thiện, đúng mực, không chào hàng lộ liễu", "speak_when": "chỉ khi có tín hiệu hỏi giá rõ ràng",
     "forbidden": ["không nhắn riêng người chưa từng tương tác"], "autonomy_level": 3},
    {"name": "Admin hậu cần", "role_desc": "Biên bản, nhắc lịch, chứng từ", "template": "admin",
     "voice": "khô, chính xác, luôn kèm mốc thời gian", "speak_when": "tự nhắc lịch và chứng từ trong phạm vi nội bộ",
     "forbidden": ["không liên hệ khách hàng bên ngoài"], "autonomy_level": 5},
    {"name": "CSKH ca chiều", "role_desc": "Bắt tín hiệu bất mãn, giữ khách", "template": "cs",
     "voice": "nhẹ nhàng, xin lỗi trước khi giải thích", "speak_when": "khi khách có dấu hiệu bất mãn trong ca chiều",
     "forbidden": ["không hứa hoàn tiền"], "autonomy_level": 3},
]

DEMO_PROVIDERS: list[dict[str, Any]] = [
    {"name": "Antigravity Brain", "kind": "antigravity_cli", "rank": 1,
     "models": [("gemini-2.5-pro", "Core agent · suy luận chính")]},
    {"name": "Gemini API", "kind": "gemini", "rank": 2,
     "models": [("gemini-2.5-flash", "Trả lời nhanh trong nhóm"),
                ("gemini-2.5-flash-lite", "Tách ý định, phân loại")]},
    {"name": "DeepSeek", "kind": "deepseek", "rank": 3, "models": [("deepseek-reasoner", "Chấm điểm và suy luận dài")]},
]


async def _ensure_agents_and_providers(db: AsyncSession, org_id: uuid.UUID) -> None:
    for spec in DEMO_PROVIDERS:
        pid = (await db.execute(text("SELECT id FROM agent.providers WHERE org_id = :o AND name = :n"),
                                {"o": org_id, "n": spec["name"]})).scalar_one_or_none()
        if pid is None:
            pid = (await db.execute(text("""INSERT INTO agent.providers (org_id, kind, name, failover_rank,
                                            auth_state) VALUES (:o, :k, :n, :r, 'ok') RETURNING id"""),
                                    {"o": org_id, "k": spec["kind"], "n": spec["name"], "r": spec["rank"]}
                                    )).scalar_one()
        for model_name, role_desc in spec["models"]:
            exists = (await db.execute(text("SELECT 1 FROM agent.models WHERE provider_id = :p AND model_name = :m"),
                                       {"p": pid, "m": model_name})).scalar_one_or_none()
            if exists is None:
                await db.execute(text("""INSERT INTO agent.models (provider_id, model_name, role_desc)
                                         VALUES (:p, :m, :r)"""), {"p": pid, "m": model_name, "r": role_desc})
    for spec in DEMO_AGENTS:
        exists = (await db.execute(text("SELECT 1 FROM agent.identities WHERE org_id = :o AND name = :n"),
                                   {"o": org_id, "n": spec["name"]})).scalar_one_or_none()
        if exists is None:
            await db.execute(text("""
                INSERT INTO agent.identities (org_id, name, role_desc, template, addressing, voice, speak_when,
                                              forbidden, autonomy_level, is_enabled)
                VALUES (:o, :n, :rd, :tpl, '{}', :v, :sw, :fb, :al, true)"""),
                {"o": org_id, "n": spec["name"], "rd": spec["role_desc"], "tpl": spec["template"],
                 "v": spec["voice"], "sw": spec["speak_when"], "fb": spec["forbidden"], "al": spec["autonomy_level"]})


# ═══ Điều phối chính ═════════════════════════════════════════════════════════

async def _org_id(db: AsyncSession) -> uuid.UUID:
    return (await db.execute(text("SELECT id FROM core.organizations ORDER BY created_at LIMIT 1"))).scalar_one()


async def seed_demo(sm: async_sessionmaker[AsyncSession], redis: Redis) -> dict[str, Any]:
    async with sm() as db:
        result = await bootstrap_mod.bootstrap(db)
        await db.commit()
    org_id = result.org_id

    ps, _pe = period_for(datetime.now(UTC).date())
    period_mid = datetime.combine(ps, time(10, 0), tzinfo=UTC) + timedelta(days=2)

    async with sm() as db:
        for g in GROUPS:
            await _ensure_group(db, org_id, g)
        await db.commit()

    now = datetime.now(UTC)
    msgs = all_messages(period_mid)
    unit_of = {m.text: m.unit for m in msgs if m.unit is not None}
    async with sm() as db:
        event_ids = await _ingest_all(db, org_id, msgs, now, period_mid)
        await db.commit()
    async with sm() as db:
        await _enrich_persons(db, org_id)
        await _ensure_agents_and_providers(db, org_id)
        await db.commit()

    all_ids = await _demo_event_ids(sm, org_id)
    router = SeedRouter(unit_of)
    refinery = Refinery(sm, redis, router)  # type: ignore[arg-type]  # SeedRouter: cùng vai trò FakeRouter (tests)
    st = await refinery.run(org_id, "manual", event_ids=all_ids, limit=len(all_ids) or 1)

    async with sm() as db:
        if st.unit_ids:
            ctx = HookCtx(org_id=org_id, unit_ids=[uuid.UUID(i) for i in st.unit_ids], run_id=None, sm=sm,
                         redis=redis, bus=None, router=None)  # type: ignore[arg-type]
            await market_signal_capture(ctx)
        n_matches = await recompute_matches_org(db, org_id)
        n_reviews = await recompute_people_reviews_org(db, org_id)
        await db.commit()
    n_alerts = await early_warning_scan({"redis_bus": redis})

    return {"org_id": str(org_id), "ingested": len(event_ids), "run": st.progress(), "matches": n_matches,
            "people_reviews": n_reviews, "alerts_scanned": n_alerts}


async def _demo_event_ids(sm: async_sessionmaker[AsyncSession], org_id: uuid.UUID) -> list[uuid.UUID]:
    async with sm() as db:
        rows = (await db.execute(text("""
            SELECT k.event_id FROM raw.event_keys k JOIN core.channels c ON c.id = k.channel_id
            WHERE c.org_id = :o AND k.external_msg_id LIKE :p"""),
            {"o": org_id, "p": f"{MSG_PREFIX}%"})).scalars().all()
    return list(rows)


async def clear_demo(sm: async_sessionmaker[AsyncSession], redis: Redis) -> dict[str, Any]:
    """Xoá mọi kết luận/đối tượng do `seed_demo` sinh ra. KHÔNG đụng `raw.events` (bất biến — xem docstring đầu
    file) lẫn `core.persons`/`core.groups`/`core.channels` (raw vẫn tham chiếu tới chúng)."""
    async with sm() as db:
        org_id = await _org_id(db)
        event_ids = await _demo_event_ids(sm, org_id)
        person_ids = list((await db.execute(text("""
            SELECT DISTINCT person_id FROM core.person_identities WHERE external_id LIKE :p AND person_id IS NOT NULL
            """), {"p": f"{NS}-person-%"})).scalars().all())
        group_ids = list((await db.execute(text("SELECT id FROM core.groups WHERE org_id = :o AND external_id LIKE :p"),
                                           {"o": org_id, "p": f"{NS}-group-%"})).scalars().all())
        subject_ids = person_ids + group_ids

        unit_ids = list((await db.execute(text("""SELECT DISTINCT meaning_unit_id FROM clean.evidence
                                                  WHERE raw_event_id = ANY(CAST(:ids AS uuid[]))"""),
                                          {"ids": event_ids})).scalars().all())
        signal_ids = list((await db.execute(text("""SELECT id FROM biz.market_signals
                                                    WHERE meaning_unit_id = ANY(CAST(:u AS uuid[]))"""),
                                            {"u": unit_ids})).scalars().all())

        await db.execute(text("""DELETE FROM biz.matches
                                 WHERE demand_id = ANY(CAST(:s AS uuid[])) OR supply_id = ANY(CAST(:s AS uuid[]))"""),
                         {"s": signal_ids})
        await db.execute(text("""DELETE FROM biz.opportunity_stage_history WHERE opportunity_id IN
                                 (SELECT id FROM biz.opportunities WHERE org_id = :o
                                  AND person_id = ANY(CAST(:p AS uuid[])))"""), {"o": org_id, "p": person_ids})
        await db.execute(text("""DELETE FROM biz.opportunities
                                 WHERE org_id = :o AND person_id = ANY(CAST(:p AS uuid[]))"""),
                         {"o": org_id, "p": person_ids})
        await db.execute(text("DELETE FROM biz.market_signals WHERE id = ANY(CAST(:s AS uuid[]))"), {"s": signal_ids})
        await db.execute(text("DELETE FROM biz.alerts WHERE org_id = :o AND subject_id = ANY(CAST(:s AS uuid[]))"),
                         {"o": org_id, "s": subject_ids})
        await db.execute(text("""DELETE FROM biz.people_reviews
                                 WHERE org_id = :o AND person_id = ANY(CAST(:p AS uuid[]))"""),
                         {"o": org_id, "p": person_ids})
        await db.execute(text("DELETE FROM memory.entries WHERE org_id = :o AND subject_id = ANY(CAST(:s AS uuid[]))"),
                         {"o": org_id, "s": subject_ids})
        await db.execute(text("""DELETE FROM clean.current_scores
                                 WHERE org_id = :o AND subject_id = ANY(CAST(:s AS uuid[]))"""),
                         {"o": org_id, "s": subject_ids})
        await db.execute(text("""DELETE FROM clean.score_snapshots
                                 WHERE org_id = :o AND subject_id = ANY(CAST(:s AS uuid[]))"""),
                         {"o": org_id, "s": subject_ids})
        await db.execute(text("DELETE FROM clean.evidence WHERE raw_event_id = ANY(CAST(:e AS uuid[]))"),
                         {"e": event_ids})
        await db.execute(text("DELETE FROM clean.meaning_units WHERE id = ANY(CAST(:u AS uuid[]))"), {"u": unit_ids})

        # Đưa tin thô mẫu về lại "chưa xử lý" — `seed_demo` gọi lại sẽ sàng lọc lại đúng các tin này.
        await db.execute(text("""UPDATE refinery.event_state SET state = 'pending', run_id = NULL, label = NULL,
                                 confidence = NULL, detail = '{}', attempts = 0, updated_at = now()
                                 WHERE event_id = ANY(CAST(:e AS uuid[]))"""), {"e": event_ids})

        agent_ids = list((await db.execute(text("""SELECT id FROM agent.identities
                                                   WHERE org_id = :o AND name = ANY(CAST(:n AS text[]))"""),
                                           {"o": org_id, "n": [a["name"] for a in DEMO_AGENTS]})).scalars().all())
        await db.execute(text("""DELETE FROM agent.bindings
                                 WHERE org_id = :o AND agent_key = ANY(CAST(:k AS text[]))"""),
                         {"o": org_id, "k": [f"agent:{a}" for a in agent_ids]})
        await db.execute(text("DELETE FROM agent.identities WHERE id = ANY(CAST(:a AS uuid[]))"), {"a": agent_ids})
        provider_ids = list((await db.execute(text("""SELECT id FROM agent.providers
                                                      WHERE org_id = :o AND name = ANY(CAST(:n AS text[]))"""),
                                              {"o": org_id, "n": [p["name"] for p in DEMO_PROVIDERS]}
                                              )).scalars().all())
        await db.execute(text("DELETE FROM agent.models WHERE provider_id = ANY(CAST(:p AS uuid[]))"),
                         {"p": provider_ids})
        await db.execute(text("DELETE FROM agent.providers WHERE id = ANY(CAST(:p AS uuid[]))"), {"p": provider_ids})
        await db.commit()
        return {"org_id": str(org_id), "raw_events_kept": len(event_ids), "meaning_units_removed": len(unit_ids),
                "market_signals_removed": len(signal_ids)}


async def _main() -> None:
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Seed / xoá dữ liệu mẫu Gen-Harness (PLAN §5.1)")
    parser.add_argument("action", choices=["seed", "clear"])
    args = parser.parse_args()
    sm = sessionmaker()
    redis = Redis.from_url(get_settings().redis_url)
    try:
        out = await (seed_demo(sm, redis) if args.action == "seed" else clear_demo(sm, redis))
        log.info("gh.seed_demo %s: %s", args.action, out)
    finally:
        await redis.aclose()


if __name__ == "__main__":
    asyncio.run(_main())
