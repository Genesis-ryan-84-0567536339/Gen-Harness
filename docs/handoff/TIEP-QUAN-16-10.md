# Tiếp quản Gen-Harness trên máy cục bộ — hiện trạng 16/10/2026

Tệp này do phiên Claude Code trên đám mây soạn khi bàn giao cho Claude Code chạy trên máy của Sếp.
**Nạp trước tiên: `docs/handoff/TRI-NHO-PHIEN-DAM-MAY.md` (trí nhớ, kỹ năng, luật, quyết định của Sếp).** Đọc kèm: `CLAUDE.md` (luật cứng + quy trình), `docs/reports/HANDOFF-v0.1.1.md` (hiện trạng), `docs/ROADMAP.md` (tiến độ + Nợ).

## Trạng thái phiên đám mây

**ĐÃ DỪNG — 15:09 UTC 16/10/2026.** Sếp chốt bàn giao: Claude Code cục bộ là người lái DUY NHẤT từ giờ. Phiên đám mây đã dừng mọi workflow/agent/lịch hẹn,
đẩy mọi phần dở lên nhánh, và không sửa thêm nhánh nào của Gen-Harness.
Trước khi đụng nhánh nào trong bảng: `git fetch origin` và đọc lại tệp này trên nhánh `claude/ban-giao-local`.

## Đã phát hành

- **v0.1.61** = `releases/latest` (promote 13:53Z 16/10, genh checksum khớp, `genh version` = v0.1.61). Main = `a9513cb`.
  Đợt A phần 1 (A1 A2 A3 A6 A7 A13) của kế hoạch sửa sau kiểm kê + vá `TARGET_IDENTITY_MISMATCH` (đích nháp chỉ nhận tài khoản thuộc đúng người).
- Nhánh `claude/v0161` đã nối main bằng `-s ours` (c4af920).

## Đang làm cho v0.1.62 (chưa phát hành, chưa mở PR)

| Nhánh | Nội dung | Trạng thái lúc bàn giao |
|---|---|---|
| `claude/wip/v0162/A4` (0171d7a) | Hộp thư + Việc xem hết: `useInfiniteQuery` + `LoadMore.tsx` "Đang xem 50/130" (F052) | XONG, chưa review. vitest 1505, tsc/eslint sạch. Lưu ý: con trỏ `list_inbox`/`list_tasks` (`gh/biz/queue/routes.py`) dùng `created_at < cursor` ⇒ dòng trùng `created_at` ở ranh giới trang có thể rơi — nên đổi sang cặp (created_at, id) như A5 |
| `claude/wip/v0162/A5` (7625325) | Khách & Nhóm: con trỏ (created_at, id), tìm/lọc kênh ở máy chủ, gán BOT hàng loạt theo bộ lọc (`POST /directory/people/bulk-bot`, `expected_total` lệch ⇒ 409), xuất JSON thật, "Ẩn danh hoá" có xác nhận (F053 F100 F101 F054) | XONG, chưa review. pytest 72 + lượt app 72, vitest 1513/1514 (`backups.test.tsx` chập chờn khi máy tải cao). Chạm thêm `ProfileScreen.tsx` (đổi ?id= sang hồ sơ gốc sau 307) |
| `claude/wip/v0162/A8` (4cd044d) | Nhật ký: phân trang con trỏ, tìm/lọc ở máy chủ (`/audit` + q, q_actions, q_actors, hide_noise), `auditLabels.ts` dịch ~200 mã, ẩn `http.*` mặc định (F099 F105) — sửa luôn P3 "Nhật ký mã tiếng Anh" của kiểm hồi quy | XONG, chưa review. pytest 210 + lượt app 58, vitest 1510. Client đọc `/audit` thay `/audit-log` để không chạm `system_api/routes.py` |
| `claude/wip/v0162/A9` (83a6cbd) | Lỗi sao lưu nói tiếng người (stderr pg_dump sang `technical`, hiện ở "Chi tiết kỹ thuật"), 403 phân theo mã (CSRF_INVALID ⇒ "Phiên đã cũ…") (F106 F110) | XONG, chưa review. pytest 48 + lượt app 48, vitest 1510. Job lỗi cũ trong Redis (TTL 7 ngày) còn có thể mang stderr thô |
| `claude/wip/v0162/A10` (92134ea) | `mask_for_model` che OTP/mã xác minh/mật khẩu/token URL (không che oan 8 mẫu thư thường); mã thiết lập Owner không vào log, ghi `run/setup-code.json` 0600 (F123 F128) | XONG, chưa review — **cần `/security-review`**. pytest 500 + lượt app 163. genh chưa đọc `run/setup-code.json` (bản cài thật đã tự sinh setup_token nên chủ yếu cho cài tay/dev). Sửa luôn P3 "mã thiết lập bị che trong log" |
| `claude/wip/v0162/A11` (ae7eedf) | Cung ↔ Cầu không ghép bừa: thiếu tên hàng ⇒ không tạo tín hiệu thị trường; khớp khi bao trọn hoặc chung ≥ 2 từ tên hàng; gỡ gợi ý cũ dưới ngưỡng (F061) | XONG, chưa review. pytest 175 + lượt app 65. Quyết định nhỏ cần Sếp biết: cầu thiếu tên hàng vẫn mở cơ hội `raw_signal` (để không mất khách) — muốn bỏ thì sửa một nhánh trong `jobs.py` |
| `claude/wip/v0162/A12` (ddfeb2f) | Tài liệu khớp mã (README/gen-coach 10 dòng 1 bắt buộc, handoff/06 banner, runbook) + `.github/scripts/check_doc_facts.py` (ROADMAP "sau vX" == VERSION) (F118 F041 F112) | XONG, chưa review. unittest scripts 186, check_doc_links sạch. ⚠ Lên `VERSION` v0.1.62 thì phải sửa ROADMAP cùng lúc, nếu không `check_doc_facts` đỏ |
| `claude/v0162` (9b24240) | Nhánh tích hợp: đã merge thường đủ 7 gói A4 A5 A8 A9 A10 A11 A12 + hạ baseline thuật ngữ (afe11cf) + commit "dở" sửa `e2e/flows.spec.ts` (nhãn Nhật ký mới) | **DỞ**: dừng giữa bước kiểm; CHƯA chạy bộ kiểm đầy đủ, CHƯA review Opus, CHƯA gộp agy/B4/B5, chưa có docs phát hành |
| `claude/wip/v0162/agy-mo-thang` (926057c) | **Antigravity mở cho mọi vai** (quyết định Sếp 16/10, đã báo rủi ro): bỏ `allow_agy`/`AGY_OWNER_ONLY`, agy chạy cả việc nền, ô chọn model mọi agent có agy; giữ cô lập mỗi lượt của `AgyClient`; giữ luật Claude CLI việc nền (F-86) | test bị chạm xanh, ruff/mypy/tsc/eslint sạch, Playwright 36/36; **bộ pytest đầy đủ chưa có kết quả** (hai lượt bị dừng giữa chừng vì máy quá tải, 0 lỗi tới lúc dừng); 2 ca vitest `setup.test.tsx` trượt timeout khi máy tải cao (chạy riêng 22/22 qua) — chạy lại trên máy cục bộ; cần `/security-review` trước khi gộp |
| `claude/wip/v0162/B4` (426e7ce) | Kênh bền: mất mạng không xoá phiên Zalo/WhatsApp (phân loại lỗi, chỉ 401/đăng xuất mới hết hạn, `POST /channels/{type}/resume` + nút "Nối lại bằng phiên đã lưu"), QR sống theo `expires_at`, phiên mới phát `session.close` đóng phiên cũ, uptime giữ mốc gốc, câu BRIDGE_OFFLINE trung thực | XONG: bridge 72/72, pytest 17 tệp liên quan + lượt app 36/36, vitest 1512, tsc/eslint sạch. Chưa: Playwright e2e `phase2.spec.ts`, pytest đầy đủ, thử zca-js/Baileys thật. Ghi chú: `resumable`/`bridge_online` khai tạm trong `systemModel.ts` — đưa vào `packages/contracts` + `endpoints.ts` khi tích hợp; resume chỉ cần `system.manage`, KHÔNG đòi PIN (hỏi Sếp nếu muốn thêm `require_pin('channel.login')`) |
| `claude/wip/v0162/B5` (7ac5fb2) | Sức khoẻ: khối `bridge` + sự cố `bridge.silent`; sự cố `dlq.inbound`, `POST /system/queues/{stream}/replay` và `/clear` (PIN `queue.manage` + Action Log); sự cố model hết hạn tách khoá API ↔ CLI | XONG: pytest 381 + lượt app 174, vitest 1514, tsc/eslint sạch. Chưa: ảnh 390/1440 thẻ Sức khoẻ, pytest đầy đủ. Còn dở của F051 (thuộc vùng B4): thẻ kênh vẫn "Đang kết nối" khi bridge im — dùng `/system/health` `bridge.state==='silent'` khi tích hợp |
| (không nhánh) | Kiểm hồi quy app thật trên v0.1.61 (mọi màn, 390/1440) | XONG — không có hồi quy P1/P2 do sửa lỗi; xem mục "Kiểm hồi quy" |

### Việc tiếp theo cho v0.1.62 (Claude cục bộ làm, theo thứ tự)

1. Nhánh `claude/v0162` đã có 7 gói đợt A (xem bảng). Gộp thường thêm: `agy-mo-thang`, `B4`, `B5` (gói nào chưa xong thì để bản sau). Xung đột dự kiến nhỏ ở
   `apps/api/gh/system_api/routes.py` (agy ↔ B4) và `apps/api/gh/health.py` (agy ↔ B5): giữ đủ hai bên.
2. Chạy kiểm như `.github/workflows/ci.yml` MỘT lần đầy đủ (api ruff + mypy + pytest hai lượt thường và `GH_TEST_APP_ROLE=1`;
   web lint + typecheck + vitest + build + Playwright mock + route-crawl; `.github/scripts`). Đỏ ⇒ tìm gốc rễ, không skip.
3. `/security-review` (agy, A10 che dữ liệu + mã thiết lập, B5 PIN `queue.manage`, B4 resume không PIN) + `/code-review` toàn nhánh (chưa gói nào của v0.1.62 được review). Sửa phát hiện thật.
   Gộp luôn P2 "tiêu đề cảnh báo thô" của kiểm hồi quy nếu kịp (nhỏ, `gh/refinery/runner.py`).
4. **Kiểm trên máy thật** (lợi thế của máy cục bộ): dựng bản dev riêng (mục "Môi trường dev" dưới), đăng nhập Antigravity thật,
   chạy thử Gen + Bản tin + một agent tự tạo + việc nền bằng agy; nếu Sếp sẵn sàng thì quét QR WhatsApp/Zalo thật trên bản dev (Nợ #35).
   Chụp ảnh 390/1440 các màn đổi, gửi Sếp xem trước.
5. Ghi bản: `VERSION` = v0.1.62, `CHANGELOG.md`, `docs/releases/v0.1.62.md` (có "Boss phải làm"), ROADMAP (thêm Nợ "tách agy ra hộp riêng"),
   HANDOFF (≤ 200 dòng), mốc `test_check_doc_links`. Thêm tài liệu "chạy dev trên máy cục bộ" (cổng/DB riêng, không đụng bản cài) — đã hứa với Sếp.
6. Push nhánh → PR `claude/v0162` → main → CI xanh → merge squash → Release/E2E/promote → kiểm `releases/latest` + checksum + `genh version`
   → báo Sếp `genh update`. Sau merge: nối main vào nhánh theo khuôn `-s ours` trong CLAUDE.md.

## Kế hoạch sửa còn lại (sau v0.1.62)

Kiểm kê 16/10: 131 phát hiện đã xác minh (P1 19 · P2 49 · P3 63), 15 gốc rễ, 38 gói, 6 đợt. Toàn văn: `docs/audit/2026-10-16/kiem-ke.md`;
kế hoạch máy đọc được: `docs/audit/2026-10-16/ke-hoach-sua.json` (mỗi gói: `key`, `files`, `what`, `notes`, `finding_ids`; `findings[id]` có bằng chứng,
tác động, gốc rễ, gợi ý sửa — bằng chứng ghi theo v0.1.59/v0.1.60, kiểm lại trên mã hiện tại trước khi sửa).

- Xong: A1 A2 A3 A6 A7 A13 (v0.1.61). Đang làm: A4 A5 A8–A12, B4, B5, agy mở thẳng (v0.1.62).
- Còn: **B1** (nghiệm thu agy — làm trên máy thật), **B2** (một hàm "nguồn AI dùng được"), **B3** (một bộ chọn model + bảng tầng), **B6** (sàng lọc ghi loại người,
  đánh dấu nhân viên), **B7** (agent tạo/sửa/bật tắt/nhân bản, thấy model từng agent), **B8** (gán BOT cho một người), **B9** (tài liệu nội bộ);
  đợt **C** (7 gói), **D** (5), **E** (3), **F** (1 — danh bạ & chế độ nghe).
- Quyết định của Sếp (16/10) cho 9 câu hỏi kiểm kê: Q1 mở thẳng Antigravity, hộp riêng làm sau như Nợ ưu tiên · Q2 chọn 1 · Q3 chọn 1 · Q4 chọn 2 ·
  **Q5 chọn 2** (thu thành viên mọi nhóm, kể cả nhóm "Không nghe" — khác lời khuyên trong tệp) · Q6 chọn 1 · Q7 chọn 1 · Q8 chọn 1 · Q9 chọn 2.
- Mỗi đợt: chia gói không chồng tệp (QD-14) → mỗi gói một nhánh `claude/wip/<bản>/<gói>` → tích hợp → kiểm đầy đủ một lần → review → phát hành.

## Nợ và việc của Sếp

- Nợ mới: tách agy ra hộp/container riêng không gắn khoá (rủi ro còn lại của "mở thẳng"); #35 kiểm WhatsApp với máy chủ thật;
  #38 mcp_write chưa thực thi; #39 51 chữ cấm trong baseline `check_terms`; #40 44 mục `crawl_baseline`; #41 hậu tố `v016x` trong tên tệp (không đổi tên migration đã phát hành).
- Việc chỉ Sếp làm được: Brain PR #137; secret `GH_PERSONAL_PATTERNS`; VIEC-34, VIEC-35 (Kho đang tạm ngưng — để Sếp quyết khi mở lại).

## Môi trường dev trên máy cục bộ (nguyên tắc)

- Bản cài thật ở `~/.gen-harness` (`genh status`, `genh version`, `genh logs`). **Chỉ đọc.** Không `genh update/stop/restart`,
  không đụng container/volume/cổng của nó trừ khi Sếp bảo.
- Mã làm việc ở một thư mục clone riêng (vd `~/dev/Gen-Harness`). Stack dev chạy với `COMPOSE_PROJECT_NAME` khác, cổng khác, volume khác
  (đọc `deploy/compose.yaml`, `Makefile`, `docs/runbook.md` để biết biến). Trước và sau khi dựng: `docker ps` để chắc không chạm bản thật.
- Test api cần Postgres 16 có pgvector + pg_partman và Redis (xem `services` trong `.github/workflows/ci.yml`): chạy container riêng ở cổng lạ.
- Sau mỗi việc: dừng stack dev nếu không dùng, dọn ổ (máy thật còn chạy Gen-hub).

## Bài học vận hành (đừng lặp lại)

- Máy dùng chung nhiều agent: KHÔNG `pkill -f` theo mẫu rộng (đã làm chết test/tiến trình của agent khác hai lần trong ngày 16/10); mỗi agent một cổng Redis + template DB riêng.
- Chạy quá nhiều bộ pytest đầy đủ song song làm máy quá tải, test timeout giả — một bộ đầy đủ MỘT lần ở bước tích hợp là đủ.

- Lượt CI bị huỷ vì có push mới hiện `ci-ok` đỏ trên sha cũ — không phải lỗi; xem lượt của sha mới.
- Release xanh chưa phải promote: E2E + promote chạy ở `e2e-install.yml` (workflow_run). Chỉ báo "đã phát hành" sau khi `releases/latest` đúng tag
  + checksum genh khớp + `genh version` đúng.
- `-s ours` chỉ khi cây main trùng hệt điểm tách (bài học v0.1.41).
- WhatsApp: lấy phiên bản WA Web bằng UA trung thực `Gen-Harness-bridge/<ver>` — không giả trình duyệt; không tạo tài khoản giả, không né chống bot.
- Một race thật đã gặp: thông báo WebSocket đến trước khi socket mở ⇒ invalidate khi socket mở (v0.1.60).
- Đĩa đầy (ENOSPC) khi nhiều worktree + node_modules: dùng `cp -al` hoặc một node_modules chung, xoá worktree đã push.

## Kiểm hồi quy v0.1.61 (đám mây, 16/10)

App thật (api + worker + web dev, Postgres/Redis riêng), Playwright 390 và 1440: thiết lập lần đầu, đăng nhập, 7 màn Mặt tiền + ~34 route Console
cho Owner và Quản lý; mời Quản lý → đổi mật khẩu tạm → tự đặt PIN; bảng quyền đổi cột; nháp → duyệt bằng PIN → thẻ Gửi lỗi → Gửi lại; gộp người + Hoàn tác;
Nhật ký; Sao lưu ngay. Kết luận: **không có hồi quy P1/P2 do sửa lỗi**; không pageerror, không tràn ngang 390, không `[object Object]`/undefined/NaN.
Lỗi tồn từ trước (đưa vào v0.1.62 hoặc đợt sau, gói nào gần thì gộp vào gói đó):

- **P2** Cảnh báo của bộ sàng lọc có tiêu đề thô "Complained · GRP-ZL-0005" (Tình báo, Thông tin): `apps/api/gh/refinery/runner.py` ~487 dùng nguyên `event_type` + `group_code`; đã có bảng `EVENT_LABEL` — dùng nhãn tiếng Việt + tên nhóm.
- P3 Nhật ký hiện mã hành động tiếng Anh (`auth.login`, `draft.approved`…) và dòng `http.post` không nhãn; tìm kiếm phải gõ mã Anh (`LogTab.tsx`, `gh/middleware.py`) — gần gói A8.
- P3 Kết nối: hai thẻ Telegram mâu thuẫn ("Chưa cài" ở danh sách kênh và thẻ bot Telegram đầy đủ).
- P3 Bản nháp › Ngữ cảnh hiện enum thô `raw_signal · OPP-0003` (owner/feed FeedDetail/DraftCard).
- P3 Quyền hạn: ô chọn cắt chữ ("Khách được ¦"), tab Cài đặt ở 390 cắt chữ, cột Vai trò "Quản".
- P3 Đăng nhập sai / đặt PIN thành công xong: form xoá ô rồi kiểm lại trên giá trị rỗng ⇒ hiện lỗi thừa (`LoginPage.tsx`, PinCard).
- P3 Vai Quản lý: mỗi màn có 403 trong console do khung gọi `/system/update`, `/setup/follow-up` (chỉ Owner) vô điều kiện.
- P3 Dev: proxy vite `'/api'` nuốt route Console `/api` (dùng `'/api/'`); mã thiết lập in log bị `_redact_log` che ⇒ `make logs-token` không lấy được (`gh/app.py`, `gh/bootstrap.py:181`).
- P3 Mặt tiền coi "không còn kênh hoạt động" là "ngày đầu" dù đã có tin ⇒ ẩn tin cũ trong khi huy hiệu vẫn đếm (`gh/owner/service.py` `channels_connected()`).

Ảnh và log của lượt kiểm chỉ nằm trên máy đám mây (không chuyển được); khi cần, chạy lại theo kịch bản trên bằng kỹ năng `webapp-testing`.
