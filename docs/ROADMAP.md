# Gen-Harness — Lộ trình tổng thể (cập nhật 02/10/2026)

Nguồn chuẩn tiến độ. Mỗi đợt = 1 PR = 1 bản phát hành. CI xanh mới tạo bản thử (prerelease); E2E cài thật xanh mới tự
nâng thành bản chính thức (latest); lịch tự cập nhật đêm đợi bản chính thức ra đủ 24 giờ. genh chỉ kiểm SHA-256 theo
checksums.txt — CHƯA kiểm chữ ký cosign (để sau).

## Vai trò
| Vai | Ai | Việc |
|---|---|---|
| Owner | Sếp (Ryan) | định hướng, duyệt, brainstorm |
| Dev | Claude Code (+ sub agent Haiku/Sonnet/Opus) | code, review, phát hành |
| ~~Dev phụ~~ | ~~Google Jules~~ — **Boss bỏ (QD-10, xác nhận 30/09)** | việc code cho repo khác đi theo agy đa repo (gen-workplace) |
| Quản trị trong app | Gen | vận hành dữ liệu, dẫn Sếp dùng app |
| Vòng ngoài | agent Zalo/WhatsApp (+ Playwright sau) | thu thập thị trường |

## Đã xong
v0.1.15–0.1.20: thiết lập "Để sau" + hướng dẫn từng bước, nút Cập nhật ngay, reset mật khẩu / tin cậy CA, phiên 7 ngày,
Tài khoản của tôi + bắt buộc đổi mật khẩu tạm, sao lưu & khôi phục trên giao diện.
v0.1.21: Gen v1 (A1–A3) — khung chat, dẫn đường trên UI, nguồn Jev; cờ `gen.enabled` (bật cho Owner).
v0.1.22: Đợt B1–B3 — quản lý người dùng, sửa thông tin công ty, trang Trợ giúp.
v0.1.23: Đợt B4–B7 — giao diện điện thoại, trang lỗi/404, chuông thông báo, sáng/tối.
v0.1.24: Đợt A4 — Gen v2 bước 1: đề xuất thao tác có xác nhận (nháp tin, nhắc việc, gán người).
v0.1.25: Đợt C1 — lọc đầu Hộp thư (trùng, rác, điểm) dùng Jev khi có, quy tắc khi không.
v0.1.26: Đợt D1 (lát đầu) — Gen đọc Kho Ryan qua Gen-hub (chỉ đọc, chỉ Owner, che dữ liệu trước khi gửi model).
v0.1.27: gia cố & phủ test — ghim DNS cho Gen-hub, lỗi Gen-hub chỉ Owner thấy, route MCP chung không lộ Kho, số liệu lọc đầu
theo phạm vi, rà trần so trùng, hạn lưu chuông 30/90 ngày, nhắc việc chịu lỗi từng dòng; e2e thẻ đề xuất/lọc đầu/Gen-hub/chuông.
v0.1.28: sửa theo rà soát UX — bước 4 phải có model (tự chọn model đã gọi thử, gán cho agent lõi), bước 12 nói thật việc còn
thiếu, nguồn lỗi xuống cuối + xoá được + một nhãn trạng thái, lỗi kỹ thuật thành câu dễ hiểu, "Để sau" dùng quy tắc/sao lưu
mặc định, tắt phụ đề tiếng Anh + bỏ chữ lập trình viên, ma trận quyền tiếng Việt, bớt ngõ cụt cho vai trò khác Owner, điện thoại
(bảng → thẻ). Còn lại: ghi chú phát hành tiếng Việt, số đếm Hộp thư, một số mục Nhẹ.
v0.1.29: Boss 30/09 "có công cụ, dùng hay không do Owner quyết, cảnh báo rủi ro rõ" — V2 bước 4 "Để sau" được (hộp cảnh báo,
dải "Chưa có model" ở bước 12 + Tổng quan, chọn model lại ở /guide/4); **D3 lát đầu**: dịch vụ `browser` (Playwright,
không DB, không khoá master) + `browser-egress` (chỉ tên miền Facebook), màn Tài khoản mạng xã hội (chỉ Owner, chấp nhận
rủi ro từng tài khoản, Owner tự đăng nhập trong cửa sổ trình duyệt từ xa, phiên mã hoá, gỡ = xoá phiên), Gen CHỈ ĐỌC thông
báo + danh sách hội thoại Facebook cá nhân và tóm tắt, lịch đọc (tắt mặc định), Dừng tất cả, giới hạn tốc độ.
v0.1.30 (hotfix): màn /guide/8 "Agent đầu tiên" sập (React error #31 `{reasons}`) khi không model nào chạy được — lỗi
MODEL_UNAVAILABLE đúng khuôn chung (`detail` là chữ, `reasons` cấp ngoài), web không bao giờ vẽ đối tượng lỗi thô, trạng thái
"Chọn model" tại chỗ; lối vào cố định "Hướng dẫn thiết lập" (thanh bên + menu tài khoản, Owner), thẻ "Việc thiết lập tiếp" có "Ẩn";
mục "Cập nhật phần mềm" cố định (Hệ thống + Trợ giúp) có "Kiểm tra bản mới", đệm bản mới nhất 1 giờ → 10 phút.
v0.1.31: Boss 01/10 "không thấy model và nhóm model nào để chọn" — nguồn CLI liệt kê model thật (`agy models`) theo nhóm
(Gemini / Claude qua Antigravity / Claude…) kèm gợi ý nhanh-rẻ / mạnh, danh mục dự phòng khi CLI không liệt kê được, gọi thử
THẬT trước khi lưu model ("Dùng model này" = model mặc định của nguồn); một sự thật cho trạng thái phiên CLI (token tự gia hạn
→ "Đang hoạt động", "Gọi thử OK" chỉ khi gọi thật được); nguồn mới **Claude Code CLI** (gói Claude Pro/Max của Owner, đăng
nhập trong container bằng link + mã, nhiều tài khoản, tắt tới khi đăng nhập, cảnh báo điều khoản — QD-12 Owner tự quyết).
v0.1.32: Boss 01/10 "high là mức suy nghĩ, không phải tên model" — model và MỨC SUY NGHĨ (effort) tách riêng (agy `--model
<gốc> --effort low|medium|high`, Claude Code `--effort` low…max), chuyển dữ liệu cũ (migration 0023), danh sách không thu gọn
còn model đã lưu, mỗi model có nguồn (CLI / tài liệu chính thức / "chưa xác minh"), nhận diện "CLI không nhận" chính xác +
"Chi tiết kỹ thuật", "Gọi thử OK" kèm giờ, nút **Chẩn đoán** (chỉ Owner) cho nguồn CLI với đầu ra thô đã che + "Chép".
v0.1.33: cổng phát hành & CI đủ test (F-9, F-13) — CI chạy trước Release, Release ra dạng bản thử (prerelease), E2E cài
thật xanh mới tự nâng thành bản chính thức (latest); lịch đêm đợi thời gian chín 24 giờ; CI thêm go vet/go test 4 hệ điều
hành, pytest dưới vai app, Playwright mock, kiểm alembic 1 head, job tổng `ci-ok`/`installer-ok`. Sửa tài liệu: genh chưa kiểm cosign.
v0.1.34: `genh update` an toàn (F-10, F-11, F-33, F-35, F-37) — tải bản mới TRƯỚC sao lưu (tải lỗi = chưa đụng gì), chỉ
khôi phục CSDL khi đã migrate (container tạm từ ảnh cũ), bản lỗi tự quay về bản cũ và lịch đêm không thử lại bản đó, đã mới
nhất thì không sao lưu/không tải, kiểm đĩa + dọn ảnh cũ (giữ 2 bản), giới hạn log mọi dịch vụ (10 MB × 3); E2E thêm dữ liệu
mẫu + đếm dòng và job bản hỏng cố ý (promote đòi xanh).
v0.1.35: sửa lỗi đỏ trong ứng dụng (F-1, F-5, F-14, F-15, F-20 phần gấp, F-43) — giao việc / gán người / gán BOT dùng
người và trợ lý thật (`/pickers/*`, CI cấm ID giả), Tài liệu không phải PDF/ảnh buộc tải xuống + CSP sandbox, Sổ tay theo
quyền Kho, PIN cho nhà cung cấp AI / khoá / chuỗi ưu tiên, lỗi thân thiện có mã (không lộ SQL, tắt /docs production), e2e
thật rút gọn 4 luồng trong CI. Còn: F-20 phần còn lại (✅ xong ở v0.1.45), sinh type từ OpenAPI (hoãn).
v0.1.36: hệ thống tự báo khi hỏng (F-6 bước 1, F-3, F-4 bước 1, F-45, F-46, F-2 tạm) — chuông khử trùng lặp
(`ops.health_alerts`) cho kênh rớt / model hết hạn / cập nhật lỗi / sao lưu quá 36 giờ / Bộ xử lý nền im / ổ đĩa sắp đầy,
`GET /system/health` (không đụng `/ready`), dải "Cần Sếp xử lý" đầu Tổng quan + thẻ "Sức khoẻ hệ thống"; sao lưu timeout
3600 giây, bị huỷ thì báo chuông; log JSON có ts + traceback + error_id; cron theo giờ VN (job nặng 04:20–05:10); một số
phiên bản từ build-arg (`gh.__version__`, LABEL ảnh, Trợ giúp hiện "phiên bản máy chủ" + "phiên bản công cụ cài đặt (genh)"). Còn: F-6/F-4 các
bước sau (F-2 job tự xoá theo hạn lưu: xong ở v0.1.40).
v0.1.37: cập nhật tự lành (F-34, F-35 phần còn lại, F-72, F-73) — khoá loại trừ `<gốc cài>/genh.lock` (lịch đêm bận
bỏ qua, gõ tay bận GH-E94A), bắt SIGTERM + rollback không bị huỷ (hạn riêng 10 phút, dừng giữa chừng GH-E94B, lịch đêm thử
lại), unit systemd `KillMode=mixed`/`TimeoutStopSec=900`, nhịp sống `run/genh-heartbeat.json` ⇒ Console hiện "bị dừng giữa
chừng" + Thử lại thay vì kẹt "đang cập nhật"; tải binary genh theo thời gian rảnh + thử lại 3 lần (cả `install.sh`);
`genh status/doctor` kiểm linger + `docker.service` enabled, chuông `host.autostart` kèm lệnh sửa; E2E nâng cấp có dữ liệu
thêm ô `tags[3]` (nhảy nhiều bản) + kiểm khoá/tự chạy lại khi bật máy.
v0.1.38: cô lập Antigravity CLI + gói chuyển máy (F-22, F-17) — agy chạy với cwd rỗng 0700 riêng mỗi lượt, env sạch,
prompt qua stdin, `--model=<tên>` qua regex, tắt slash command; phiên Claude Code sang volume riêng `claude_state` (api tự
chuyển tệp cũ); **luật cứng: agy chỉ dùng cho Gen của Sếp** (sàng lọc/trực việc/nhân viên bị từ chối, gán → 409
`AGY_OWNER_GEN_ONLY`); canary offline trên agy 1.2.9 thật "không lộ" + bước canary trong E2E cài thật. Gói chuyển máy mã
hoá lại phiên mạng xã hội; phiên không mở được → 409 `SOCIAL_NEEDS_LOGIN` + "Cần đăng nhập lại"; lịch đọc cô lập lỗi từng
tài khoản; test quét mọi cột `*_enc`. Còn: canary `--live` có đăng nhập (v0.1.39, sau khi Boss đăng nhập agy) — chỉ nới
luật cứng khi live "không lộ".
v0.1.39: kết nối chạy thật cùng Boss (F-74, F-76, F-77, F-78, F-31, F-32, F-28) — trang **"Việc Sếp cần làm"**
(`/guide/viec-sep`, chỉ Owner): 5 dòng Gen-hub, Facebook, Google/agy (2 tài khoản, đổi qua lại 2 lần kiểm bằng lượt gọi
thật), Claude Code CLI, Jev (không bắt buộc, kiểm 1 lần); mỗi lần bấm ghi vào `ops.boss_checks` (migration 0025, không lưu
token/mật khẩu/email đầy đủ/giá trị mã — mã đăng nhập chỉ lưu dạng `code_shape`), `GET /boss-checks` + khối `boss_checks`
ở `/system/health` để Claude tự đọc. Gen-hub: địa chỉ https công khai tự bật "mạng công cộng", lỗi có mã thống nhất
(`HUB_TOKEN_REJECTED`, `MCP_NETWORK_BLOCKED`…). Mục "Mạng xã hội" trên thanh bên + thẻ Facebook ở Hệ thống › Kênh + Gen mở
`/social`; một tên "Hướng dẫn thiết lập" (9 việc, thêm Facebook/Gen-hub, việc 10 trỏ `/system?tab=users`, xong theo dữ liệu
thật). Còn: nghiệm thu thật với tài khoản của Boss (kết quả tự ghi ở `ops.boss_checks`), canary `--live` agy sau khi Boss
đăng nhập, đối chiếu `code_shape` với regex F-56 (✅ xong ở v0.1.45); Telegram trong hướng dẫn hoãn.
v0.1.40: dữ liệu an toàn (F-12, F-2, F-16) — **bản sao ngoài máy**: `genh offsite set|run|status|disable`, lịch tuần Chủ
nhật (systemd/cron/launchd/schtasks) xuất gói mã hoá ra ổ USB/NAS Owner chọn, tự kiểm gói (`gh.bundle verify`), xoay vòng 4
gói, đích chưa mount ⇒ GH-EB01 không ghi gì; khoá khôi phục riêng + "Bộ khôi phục" (in/QR), "Tải gói mang đi" (Owner + PIN),
chuông `offsite.stale` (> 7 ngày) / `offsite.failed` ở "Cần Sếp xử lý"; bỏ S3/MinIO giả (đích chỉ `local`); `genh uninstall`
mặc định giữ dữ liệu (`--delete-data` mới xoá); E2E `e2e-offsite` thử khôi phục thật vào cài đặt mới (promote đòi xanh).
**Hạn lưu thật**: `gh/retention.py` (partman retention + xoá theo lô, `browser_jobs.result` 14 ngày), nút Sửa mở lại,
`ops.action_log` "Không áp dụng". **Job nặng**: dò trùng danh tính không còn ngừng đề xuất (NOT EXISTS + watermark + trigram),
bản đồ chỉ quét cửa sổ thời gian, job quá giờ 2 lần ⇒ chuông `job.timeout`. Migration 0026. Còn: `ops.action_log` hạn lưu
(vướng chuỗi băm) — để sau.
v0.1.41: Gen trợ lý thật, lát 1 (F-8 a+b, F-86, F-84 phần ưu tiên) — khung Gen **nhớ hội thoại** qua tải lại + "Hội thoại
cũ"; **Bản tin Gen** 07:30/17:30 giờ VN (việc đến hạn, khách nóng, nháp chờ duyệt, sự cố, Facebook mới, Kho) thành một
chuông mở đúng bản tin, không có khoá API vẫn gửi kèm dòng "Dán khoá OpenRouter/Gemini để Gen tóm tắt"; **việc nền mặc định
chỉ dùng khoá API** — Claude Code CLI chỉ khi Owner bật (cảnh báo nguyên văn + tích + PIN, QD-12), chỉ còn CLI ⇒ chuông
`ai.background_no_source`; nút **Hữu ích / Không hữu ích**; **chi phí AI ₫/ngày theo agent** (giá model, trần mỗi ngày +
chuông vượt trần) ở Tổng quan; mẫu nhà cung cấp **OpenRouter**. Migration 0027. Còn: F-8 (c) gửi bản tin qua Telegram
(✅ xong ở v0.1.44); F-84 phần khác (duyệt nháp, đề xuất Deal/Vụ việc, vai trò khác, stream) hoãn; bộ 10–15 câu hỏi chuẩn + quyết
định giữ/bỏ Jev chạy song song sau bản này.
v0.1.42: "Chế độ Boss" = MỘT menu gọn theo việc (F-7, F-26, F-61, F-63–F-67, F-41) — thanh bên Hôm nay · Hộp thư & Việc ·
Khách & Cơ hội · Kết nối · Đội ngũ · Cài đặt + "Nâng cao" thu gọn (không có công tắc, không có cây menu thứ hai); trang
**Kết nối** một trang (Bộ não AI + tài khoản CLI, Zalo, WhatsApp, Telegram, Facebook, Gen-hub, MCP — viên Đang chạy / Cần
Sếp xử lý / Chưa nối + một nút chính); **Đội ngũ** (Đánh giá/Chăm sóc chỉ khi đã có nhân viên); **Cài đặt** lọc tab theo
quyền; `/` về màn đầu tiên của vai trò (Agent NV → Hộp thư); mỗi thẻ một chỗ (Cập nhật · PIN · CLI · Gen-hub; thang tự trị
khai một nơi); Hôm nay một hàng 4 số; header gọn ngoài Nâng cao, logo phiên bản thật, bỏ phụ đề tiếng Anh; Plugin ẩn &
đóng băng, Hồ sơ sống chỉ mở từ danh sách. Link cũ (`/system?tab=channels|users`) tự chuyển.
v0.1.43: bỏ lời hứa không thật & chữ khó hiểu (F-23, F-25, F-29, F-30, F-38 phần logic, F-62, F-24 chỉ chữ) — bước 1
không còn "Dùng dữ liệu mẫu"; gán model chỉ 3 khoá lõi (`core.refinery`, `core.reply`, `core.gen`); màn trống dẫn "Nối
kênh"/"Quét lại QR"/"Chọn nhóm để nghe"; thang tự trị 3 mức ở giao diện (5–6 ở Nâng cao, backend giữ 0–6); Lọc tin Thấp/Vừa/Cao, Jev +
trọng số vào Nâng cao; ẩn độ tin cậy trên thẻ Hộp thư; `gh/textnorm.py` + `lib/format.ts` dùng chung; nháp tin Gen "Đã lưu
nháp — chưa gửi" + "Mở để duyệt và gửi". Còn: F-38 phần còn lại (gom khi chạm vào code).
v0.1.44: kênh Telegram tới Sếp + Trực canh máy chủ + Gói chẩn đoán (F-6 bước 2, F-8 c, F-4 bước 2) — genh tự cài lịch
`gen-harness-watchdog` mỗi 12 phút (`genh doctor --notify`): đo dịch vụ/api/đĩa/sao lưu/nhịp worker-bridge, tự khởi động lại
dịch vụ chết, báo Telegram chống spam (1 tin CẢNH BÁO + 1 tin ĐÃ ỔN mỗi lượt), chạy được cả khi api chết; bot Telegram của
Sếp ở **Kết nối › Telegram** (token mã hoá, `REENCRYPT_TARGETS`, migration 0029), bản tin 07:30/17:30 + nhắc việc đi một chiều
qua hộp thư đi (không qua bridge); dòng 6 "Telegram" ở Việc Sếp cần làm; `X-Request-ID` ở header/problem+json/log + "Mã yêu
cầu" cạnh mã ERR, `POST /client-errors`; **Gói chẩn đoán** ở Trợ giúp (genh tạo zip đã lọc bí mật). Còn: Sếp nhắn lại Gen
qua Telegram (2 chiều) hoãn; F-28 Telegram làm kênh khách hoãn; watchdog ghi sự cố vào Kho hoãn.
v0.1.45: khoá cấu hình nhạy cảm & vệ sinh bảo mật (F-20 phần còn lại, F-49, F-52, F-54, F-55, F-56, F-57, F-58, F-60) —
PIN chỉ ở đúng đường hạ rào (đổi mức tự trị/điều cấm/giới hạn/phạm vi kênh của agent, tool MCP ghi → đọc, thêm tài khoản CLI,
Hướng dẫn việc 9/10 sau Hoàn tất; cập nhật và sao lưu không hỏi PIN); `system.manage` luôn cần phạm vi ALL; MCP và nhà cung
cấp AI ghim DNS, cấm link-local/0.0.0.0/tên dịch vụ compose, có token thì phải https; nhật ký MCP chỉ lưu dấu vết tham số
(sha256/keys/bytes) và che kết quả; hộp thư `run/` 2770 nhóm 10001, genh bỏ qua symlink/tệp của uid lạ; mật khẩu
pg_dump/pg_restore qua `PGPASSWORD`; WebSocket kiểm Origin (4403) + nạp lại phiên ≤ 60 giây (thu hồi ⇒ 4401); mã đăng nhập
CLI theo regex (đã đối chiếu dạng mã thật của F-77); cờ "Đáng ngờ" cho điểm nhân sự (migration 0030) + đoạn "Mã PIN bảo vệ
được gì" ở Trợ giúp. Đóng F-20 phần còn lại (từ v0.1.35) và việc đối chiếu `code_shape` với regex F-56 (từ v0.1.39).
v0.1.46: nhân viên & điện thoại vào được, đăng nhập an toàn (F-21, F-27, F-1, F-3) — cài mới cổng chỉ nghe 127.0.0.1,
máy cũ giữ 0.0.0.0 (`lan_legacy`) + đúng 1 chuông "Cổng đang mở cho cả mạng"; `genh remote tailscale|cloudflare|--lan|--local`
ghi `.env` (GH_BIND_ADDR/GH_SITE_ADDRESS/GH_PUBLIC_URL); lời mời lấy địa chỉ theo GH_PUBLIC_URL + cảnh báo đỏ khi chỉ mở trên
máy chủ; thẻ "Truy cập từ xa" ở Cài đặt, dòng 7 "Truy cập từ xa" ở Việc Sếp cần làm (bắt buộc ⇒ 6 dòng); 10 lần sai/15 phút
theo IP và email (429), argon2 giả cho email lạ, phiên tối đa 30 ngày. Còn: TOTP (hoãn); nút đổi chế độ trong Console (không
làm — tránh tự cắt truy cập); kiểm Tailscale/điện thoại trên máy Fedora thật của Boss.
v0.1.47: Facebook ghi, lát 1 (F-79, F-85, F-83 phần mạng xã hội, F-59, F-92) — **Trả lời bình luận** và **Nhắn tin** qua
đề xuất Gen → Xác nhận + mã PIN → permit ký (TTL 5 phút, nonce một lần, hash nội dung + đích) → worker kiểm permit và kiểm
Dừng tất cả ngay trước khi bấm gửi → ảnh chụp bằng chứng mã hoá (90 ngày) + Action Log + chuông; Giới hạn gửi/ngày mặc định
10 (trần 20); trễ cố định 3 giây; sandbox trình duyệt bật bằng user namespace + seccomp riêng, tự lùi và báo thật khi máy chủ
không cho — khi đó gửi chỉ mở sau khi Owner bấm "Tôi hiểu rủi ro và đồng ý" (`/social/ghi-facebook`); kiểm phiên Facebook
hằng ngày 09:10 → sự cố + chuông + Telegram (qua genh watchdog); dòng 8 "Facebook trả lời" (không bắt buộc) ở Việc Sếp cần làm;
bỏ số phiên bản khỏi chú thích "chỗ cắm". Còn: **đăng bài = lát 2**; selector ghi Facebook mới kiểm trên trang mẫu —
nghiệm thu thật do Boss; `like`/`follow` chưa làm.
v0.1.48: bản build tái lập & pipeline gọn (F-19, F-36, F-71, F-13, F-44) — ảnh nền + caddy/redis ghim digest đa kiến trúc,
api/browser cài từ `uv.lock` (`uv sync --frozen`, kiểm 2 lần build ra cùng tổ hợp gói), Renovate đề xuất nâng (cài App là
tuỳ chọn); mọi action ghim SHA, quyền mặc định `contents: read`, ảnh GHCR chỉ `:<version>` + `:sha-<commit>` (bỏ `:latest`),
build thử lại 1 lần + cache gha; quét pip-audit/npm audit/govulncheck dạng báo cáo (không chặn); CI đỏ khi bản nhúng genh lệch
`deploy/`; `docs/handoff/schema.sql` đã bỏ (lược đồ thật ở `db/sql` + migrations). Tag GHCR `gen-harness-*:latest` cũ đứng yên ở
bản promote cuối bằng workflow cũ (v0.1.46, hoặc v0.1.47 nếu promote trước khi v0.1.48 merge; không nhận bản vá) — không dùng.
Còn: gói apt trong Dockerfile chưa ghim phiên bản (tầng apt dựng lại mỗi tuần); PR Renovate không tự merge nằm chờ tới khi Boss
nhắn Claude (chưa có lịch tự động).
v0.1.49: Gen đọc lịch / mail / việc / Drive qua Gen-hub, CHỈ ĐỌC (QD-16, F-83, F-8) — Gen (chỉ Owner) hỏi được Tài liệu, Deal,
Vụ việc nội bộ (đã che) và lịch/mail/việc Google qua Gen-hub; tool ghi Google bị chặn ở mọi đường; ngắt mạch Gen-hub (3 lỗi →
60 giây, im 15 phút → sự cố + chuông); Bản tin thêm "Lịch hôm nay", "Mail cần trả lời", "Việc Google đang mở" (thiếu quyền ⇒ 1 dòng
nhắc + nút "Mở thẻ Gen-hub"; Telegram chỉ số đếm, model tóm tắt cũng chỉ thấy số đếm của mục Gen-hub); Kết nối › Gen-hub và Việc Sếp cần làm ghi quyền đọc còn thiếu (không bắt buộc).
Còn: Gen soạn mail/tạo lịch (có xác nhận) — chưa làm, cần Boss chốt.

## Đợt A — Gen v1 (thiết kế: docs/design/gen-v1.md)
- ✅ A1 Khung chat phải + Gen trả lời/tóm tắt (chỉ đọc), lưu hội thoại, Nhật ký hành động — v0.1.21.
- ✅ A2 Giao thức hành động UI: mở trang, khoanh sáng (`data-gen-target`), dẫn từng bước — v0.1.21.
- ✅ A3 Nguồn model Jev (OpenRouter) + Gen dùng Jev cho quyết định nhanh, rơi về LLM khi lỗi — v0.1.21
  (schema `/v1/systemone` còn là giả định, xem HANDOFF v0.1.21).
- ✅ A4 Gen v2 bước 1 — đề xuất thao tác có xác nhận (nháp tin → nhắc việc → gán người; Xác nhận/Sửa/Huỷ, PIN khi nhạy cảm,
  Action Log via=gen; nhắc việc đến giờ → chuông) — v0.1.24.

## Đợt B — Cơ bản còn thiếu
- ✅ B1 quản lý người dùng (mời, đổi vai trò, khoá/mở khoá, đặt lại mật khẩu) — v0.1.22.
- ✅ B2 sửa thông tin công ty (Điều khiển hệ thống › Tổ chức) — v0.1.22.
- ✅ B3 Trợ giúp/Giới thiệu/phiên bản (`/help`, Báo lỗi) — v0.1.22.
- ✅ B4 giao diện điện thoại (ngăn kéo danh mục, Gen phủ toàn màn, 375px không cuộn ngang) — v0.1.23.
- ✅ B5 trang lỗi (có mã lỗi) + trang 404 — v0.1.23.
- ✅ B6 chuông thông báo (`/notifications`, cập nhật trực tiếp qua WebSocket) — v0.1.23.
- ✅ B7 sáng/tối (mặc định theo hệ thống, nhớ theo từng người dùng) — v0.1.23.

## Đợt C — Hạ tầng dữ liệu
- ✅ C1 Sàng lọc dùng Jev làm lớp lọc đầu (rác, trùng, chấm điểm 0–100) + đo chi phí (độ trễ, số lượt Jev) và độ khớp với
  quy tắc; Hộp thư có huy hiệu + "Ẩn rác & trùng", thẻ cấu hình Owner — v0.1.25. (Còn: đo độ chính xác có nhãn người.)
  v0.1.27: số liệu theo phạm vi `queue.read`; trần 3000 mục so trùng đã rà (trùng y hệt không bị trần bỏ sót).

## Đợt D — Phòng làm việc chung (repo Gen-hub, cần mở quyền repo cho phiên này)
- 🟡 D1 Gen nối Kho/warroom/kanban của Gen-hub — **một phần** v0.1.26: Gen đọc Kho (Owner, chỉ đọc, che dữ liệu, đệm 5 phút,
  nhắc token trước 14 ngày; thẻ Gen-hub ở MCP Hub); v0.1.27 gia cố (ghim DNS, lỗi chỉ Owner, route MCP chung chỉ Owner).
  v0.1.49: thêm đọc lịch/mail/việc/Drive Google qua Gen-hub (chỉ đọc, chỉ Owner, ngắt mạch F-83) + 3 mục Bản tin.
  Còn: đề xuất ghi kanban/warroom (bản sau), phương án B.
- ~~D2 Jules worker~~ — **Bỏ** (Boss chốt QD-10, xác nhận lại 30/09). Không làm, không kiểm điều khoản Jules nữa.
- 🟡 D3 Gen điều khiển mạng xã hội thay Boss (API trước, Playwright cho tài khoản cá nhân) — thiết kế:
  docs/design/gen-browser-agent.md. ✅ Lát đầu **v0.1.29**: Facebook cá nhân, đăng nhập + CHỈ ĐỌC (thông báo, hội thoại).
  ✅ **v0.1.47** ghi lát 1 (F-79): Trả lời bình luận + Nhắn tin có xác nhận (đề xuất Gen + PIN + permit + ảnh chụp bằng chứng);
  F-85 sandbox: bật bằng user namespace + seccomp riêng, tự lùi + trang đồng ý rủi ro khi máy chủ không cho (kết quả thật trên máy
  Boss xem ở `GET /social/write-gate`); F-83 phần mạng xã hội xong (kiểm phiên 09:10 + chuông + Telegram).
  Tiếp: **đăng bài = lát 2**; Trang FB/IG chuyên nghiệp qua API; nền tảng khác. Luật cứng giữ nguyên: không tài khoản giả, không lách chống bot (không stealth/proxy/giải CAPTCHA).
Thiết kế: docs/design/gen-hub-link.md (lát đầu v0.1.26 ✅ — Gen đọc Kho qua Gen-hub, chỉ-đọc).
