"""Phân lớp dùng Antigravity CLI (`agy`) — MỘT hàm quyết định duy nhất (`decide`), quyết định của Sếp 16/10/2026.

Kiến trúc Sếp chốt (gói G, v0.1.62):
- LỚP CORE (chỉ tương tác với Sếp / xử lý nội bộ): `core.gen` của Sếp (Owner), `core.briefing`, `core.refinery` và agent
  nội bộ (`agent:<id>` KHÔNG có nhiệm vụ giao tiếp với bên ngoài) ⇒ dùng được agy.
- LỚP NGOẠI GIAO (nói chuyện / soạn tin cho người ngoài): `core.reply` (soạn lại, dịch nháp tin gửi khách) và agent
  ngoại giao ⇒ CHƯA dùng agy; hộp riêng làm ở bản sau (agy chạy cùng container với khoá hệ thống nên nội dung bên
  ngoài có thể lừa agy đọc tệp — xem docstring `gh.providers.clients.AgyClient`).
- Gen của người dùng KHÔNG phải Owner (nhân viên) ⇒ không dùng agy; dùng khoá API.

Tiêu chí "agent ngoại giao" (rõ ràng, kiểm được bằng SQL — `diplomatic_agent_ids`): agent là ngoại giao khi nó được GẮN
để nhận nội dung từ bên ngoài, tức là có ít nhất một trong ba:
  1. phạm vi nghe kênh / nhóm chat (`agent.channel_scopes`);
  2. được gán làm BOT của một nhóm (`core.groups.assigned_agent_id`);
  3. được gán làm BOT của một người (`core.persons.attrs->>'agent_id'`).
Đây đúng là các đường mà agent trực việc (`gh.biz.duty`) và bản nháp trả lời khách nhận tin khách, nên xét theo việc
agent CÓ THỂ đọc nội dung ngoài (không theo mẫu / mức tự trị). Agent chưa gắn kênh / nhóm / người nào chỉ nhận lời của
Sếp (vd lượt thử trong trình thiết lập) ⇒ nội bộ. Quyết định tính LÚC GỌI (không lưu): gắn kênh cho agent sau này thì
dòng gán agy cũ của agent đó tự hết hiệu lực.

Soạn lại / dịch nháp (purpose `draft_translate` / `draft_regenerate`) luôn ngoại giao theo MỤC ĐÍCH, bất kể khoá của
nháp (`agent:<id>` có thể hết "ngoại giao" sau khi nháp được tạo) — review lần 2 v0.1.62.

Hàm `decide` THUẦN (không DB); các nơi dùng: `set_binding` (agents_api), `ModelRouter.generate`, hồ sơ tiêu chuẩn
(`gh.defaults.profiles.resolve` / `missing_reason`), ô chọn model của khung chat Gen (`choice_options`) và danh sách
gán model của web (`agy_blocked_reason`).
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import Uuid, bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

KIND_AGY = "antigravity_cli"
ROLE_REPLY = "core.reply"
ROLE_GEN = "core.gen"
AGENT_PREFIX = "agent:"

CODE_DIPLOMATIC = "diplomatic"
CODE_STAFF_GEN = "staff_gen"

#: Câu hiển thị cho người dùng (tiếng Việt có dấu, trung thực) — nguồn duy nhất.
REASON_DIPLOMATIC = "Antigravity chưa dùng cho việc trả lời người ngoài — chờ hộp riêng (bản sau)"
REASON_STAFF_GEN = "Antigravity chưa dùng cho Gen của nhân viên — Gen của nhân viên dùng khoá API"

#: Việc soạn lại / dịch nháp tin gửi khách: LUÔN ngoại giao, bất kể khoá (`core.reply` hay `agent:<id>` của nháp — agent
#: có thể hết "ngoại giao" sau khi nháp được tạo, và lời yêu cầu soạn lại là chữ Sếp gõ tự do).
DIPLOMATIC_PURPOSES = frozenset({"draft_translate", "draft_regenerate"})


@dataclass(frozen=True)
class AgyVerdict:
    """Kết quả quyết định: `allowed`; nếu không thì `code` (diplomatic | staff_gen) và `reason` (chuỗi hiển thị)."""

    allowed: bool = True
    code: str | None = None
    reason: str | None = None


ALLOWED = AgyVerdict()
DENIED_DIPLOMATIC = AgyVerdict(False, CODE_DIPLOMATIC, REASON_DIPLOMATIC)
DENIED_STAFF_GEN = AgyVerdict(False, CODE_STAFF_GEN, REASON_STAFF_GEN)


def decide(agent_key: str, *, owner: bool = True, diplomatic: bool = False, purpose: str | None = None) -> AgyVerdict:
    """Khoá agent này có được chạy bằng Antigravity CLI không?

    - `owner`: người hỏi là Owner (chỉ ảnh hưởng `core.gen`; mặc định True cho mọi lượt không có người hỏi cụ thể);
    - `diplomatic`: với `agent:<id>` — agent đó là ngoại giao (`diplomatic_agent_ids`); khoá khác bỏ qua tham số này.
    - `purpose`: việc đang làm (`ModelRouter.generate`). Soạn lại / dịch nháp (`DIPLOMATIC_PURPOSES`) không dùng agy
      bất kể khoá.
    Khoá lạ (core.embedding…) không bị chặn ở đây — chúng không dùng agy."""
    if purpose in DIPLOMATIC_PURPOSES:
        return DENIED_DIPLOMATIC
    if agent_key == ROLE_REPLY:
        return DENIED_DIPLOMATIC
    if agent_key.startswith(AGENT_PREFIX) and diplomatic:
        return DENIED_DIPLOMATIC
    if agent_key == ROLE_GEN and not owner:
        return DENIED_STAFF_GEN
    return ALLOWED


def agent_id_of(agent_key: str) -> uuid.UUID | None:
    if not agent_key.startswith(AGENT_PREFIX):
        return None
    try:
        return uuid.UUID(agent_key[len(AGENT_PREFIX):])
    except ValueError:
        return None


_DIPLOMATIC_SQL = """
    SELECT a.id FROM agent.identities a
    WHERE a.org_id = :o AND (:a IS NULL OR a.id = :a) AND (
          EXISTS (SELECT 1 FROM agent.channel_scopes s WHERE s.agent_id = a.id)
       OR EXISTS (SELECT 1 FROM core.groups g WHERE g.org_id = a.org_id AND g.assigned_agent_id = a.id)
       OR EXISTS (SELECT 1 FROM core.persons p WHERE p.org_id = a.org_id AND p.attrs->>'agent_id' = a.id::text))
"""


async def diplomatic_agent_ids(db: AsyncSession, org_id: uuid.UUID,
                               only: uuid.UUID | None = None) -> set[uuid.UUID]:
    """Agent ngoại giao của tổ chức (tiêu chí ở docstring module): có phạm vi nghe kênh / nhóm, hoặc được gán BOT cho
    một nhóm / một người. MỘT truy vấn cho cả tổ chức (danh sách gán model dùng chung); `only` thu về một agent
    (mỗi lượt `ModelRouter.generate` chỉ hỏi đúng agent đang gọi)."""
    rows = (await db.execute(text(_DIPLOMATIC_SQL).bindparams(bindparam("a", type_=Uuid())),
                             {"o": org_id, "a": only})).all()
    return {r.id for r in rows}


async def verdict_for(db: AsyncSession, org_id: uuid.UUID, agent_key: str, *, owner: bool = True,
                      purpose: str | None = None) -> AgyVerdict:
    """`decide` cho MỘT khoá, tự tra DB khi là `agent:<id>` (các khoá khác, và việc đã bị cấm theo `purpose`, không tốn
    truy vấn)."""
    aid = agent_id_of(agent_key)
    diplomatic = (aid is not None and purpose not in DIPLOMATIC_PURPOSES
                  and aid in await diplomatic_agent_ids(db, org_id, only=aid))
    return decide(agent_key, owner=owner, diplomatic=diplomatic, purpose=purpose)


async def verdicts_for(db: AsyncSession, org_id: uuid.UUID, agent_keys: list[str], *,
                       owner: bool = True) -> dict[str, AgyVerdict]:
    """`decide` cho nhiều khoá bằng đúng một truy vấn ngoại giao."""
    dip = await diplomatic_agent_ids(db, org_id) if any(k.startswith(AGENT_PREFIX) for k in agent_keys) else set()
    return {k: decide(k, owner=owner, diplomatic=(agent_id_of(k) in dip)) for k in agent_keys}
