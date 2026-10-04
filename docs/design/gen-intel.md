# Gen Tình báo (Intel) — thiết kế nghiên cứu

> Trạng thái: **nghiên cứu / đề xuất**, chưa code. Nhánh: `claude/elegant-cori-1ex7dn`. Ngày: 2026-10-04.
> **Trạng thái (Boss, 04/10): Ý TƯỞNG ĐỂ SAU cho Gen-Harness.** Trước mắt làm bản độc lập ở phiên/repo khác theo `docs/design/gen-intel-standalone-spec.md`; gộp vào đây sau. Mục 7 = đích gộp, 7b = bản độc lập.

## 1. Bài toán thật (không phải "đọc tin")

Owner không thiếu tin — Owner thiếu **thời gian và bộ lọc**. Một hệ thống tình báo đúng nghĩa trả lời 4 câu, theo thứ tự:

1. **Có gì mới đáng chú ý?** (tín hiệu, không phải tin) — lọc từ hàng nghìn mục còn 5–10 mục/ngày.
2. **Nó ảnh hưởng tới Sếp thế nào?** — tới tài sản (vàng, cổ phiếu, BĐS, tiền mặt), tới công việc kinh doanh hiện có (ngành hàng trong `biz.*`), tới kỹ năng/sự nghiệp (AI thay đổi cách làm).
3. **Nên làm gì / theo dõi gì?** — hành động gợi ý có thời hạn, hoặc "chưa cần làm gì".
4. **Học được gì?** — mỗi ngày 1 khái niệm ngắn, ghi vào Kho thành Bài học, để Sếp không lạc hậu.

Nguyên tắc: **"Vậy thì sao với tôi?"** là cột quan trọng nhất của mỗi thẻ. Tin không trả lời được câu đó thì không lên màn chính.

## 2. Vòng tình báo (intelligence cycle) áp vào Gen-Harness

```
Hồ sơ quan tâm ─► Thu thập ─► Khử trùng/gom cụm ─► Chấm điểm ─► Phân tích tác động ─► Trình bày/Báo ─► Phản hồi
   (Owner)        (collector)   (story cluster)      (rẻ, không LLM)  (LLM, chỉ top-N)   (màn + Telegram)  (Hữu ích/Bỏ qua)
       ▲                                                                                                    │
       └──────────────────────────── học khẩu vị (trọng số chủ đề) ◄────────────────────────────────────────┘
```

- **Thu thập** chỉ lưu: link gốc, tiêu đề, đoạn trích ngắn, số đo (sao, điểm, giá), thời gian, nguồn. Không lưu toàn văn (bản quyền).
- **Chấm điểm rẻ trước, LLM sau**: điểm heuristic (độ mới, tốc độ tăng, số nguồn cùng nói, khớp hồ sơ) loại 95% rác; chỉ ~20–40 mục/ngày tới LLM → chi phí nằm gọn trong trần VND/ngày (`gh/ai_cost.py`).
- **Hội tụ đa nguồn** là tín hiệu mạnh nhất: cùng một chuyện xuất hiện ở GitHub + HN + Reddit trong 24h = "đang bùng".
- Nội dung ngoài luôn bọc `wrap_untrusted`, đánh dấu tainted như `briefing.sources` (chống prompt injection từ bài viết/README).

## 3. Sáu mảng radar (mặc định, Owner bật/tắt)

| Mảng | Câu hỏi nó trả lời | Nguồn đợt đầu (rủi ro thấp) | Để sau |
|---|---|---|---|
| **AI & Công nghệ** | Công cụ/mô hình nào mới, dùng được ngay không? | GitHub Search API (repo mới tăng sao nhanh, releases.atom), Hacker News (Firebase/Algolia), arXiv cs.AI/cs.CL, Hugging Face trending + daily papers, RSS blog OpenAI/DeepMind | Reddit (r/LocalLLaMA, r/MachineLearning qua `.rss`/OAuth), Product Hunt |
| **Thị trường tài chính** | Tài sản của tôi đang thế nào, có biến động bất thường? | FRED/EIA (dầu, vàng thế giới), Vietcombank XML (USD/VND), CoinGecko | vnstock (VN-Index, mã theo dõi), giá vàng SJC/PNJ/DOJI (scrape, dễ hỏng → cần fallback) |
| **Bất động sản** | Chu kỳ đang ở đâu, chính sách nào đổi? | Tin CafeF/Vietstock RSS, chinhphu.vn (luật đất đai, tín dụng) | Báo cáo quý CBRE/Savills/VARS (tóm tắt link) |
| **Thế giới & Địa chính trị** | Biến động nào lan tới VN / ngành của tôi? | GDELT (sự kiện + tone, lọc VN/ASEAN), RSS BBC/Guardian/Al Jazeera, Google News RSS theo từ khoá | — |
| **Chính sách VN** | Nghị định/thông tư nào chạm tới tôi? | chinhphu.vn RSS, vbpl.vn | congbao |
| **Xu hướng & Cơ hội** | Ngách mới nổi nào khớp năng lực của tôi? | Hội tụ từ các mảng trên + từ khoá ngành của doanh nghiệp | Google Trends (pytrends đã chết 4/2025; API chính thức đang alpha) |

**Dự báo**: Polymarket/Kalshi/Metaculus (đọc công khai) cho xác suất sự kiện lớn — dùng làm *mốc khách quan*, không tự bịa xác suất.

## 4. Hồ sơ quan tâm (thứ hiện chưa có)

Onboarding hiện chỉ có trường vận hành. Cần thêm `core.organizations.settings->'intel'` (hoặc bảng `intel.profile`):

- `domains`: 6 mảng trên + trọng số.
- `holdings`: loại tài sản đang nắm (vàng, cổ phiếu [mã], BĐS [khu vực], USD, crypto) — **chỉ loại và mã, không số tiền** trừ khi Sếp muốn.
- `business`: tự gợi ý từ `category` ngành hàng và `product` trong `clean.meaning_units.entities`, Sếp xác nhận.
- `watch`: repo GitHub, subreddit, từ khoá, đối thủ, mã CK.
- `career`: kỹ năng đang học / muốn học (để chọn "Bài học hôm nay").
- `noise`: chủ đề không muốn thấy.

Trọng số tự điều chỉnh nhẹ theo "Hữu ích / Bỏ qua" từng thẻ (giới hạn biên độ để không tự nhốt mình trong bong bóng; luôn chừa 10% "ngoài vùng quen").

## 5. Thẻ tín hiệu (đơn vị hiển thị)

```
[AI & Công nghệ] ▲ Bùng — 3 nguồn trong 18h            Tin cậy: Cao   Hạn: 7 ngày
<Tiêu đề 1 dòng>
Vậy thì sao với Sếp: <1–2 câu, gắn vào hồ sơ: tài sản/kinh doanh/kỹ năng>
Gợi ý: <hành động cụ thể> | hoặc "Chỉ cần biết"
Nguồn: github ↗  hn ↗  reddit ↗          [Hữu ích] [Bỏ qua] [Theo dõi tiếp] [Ghi vào Kho]
```

- **Tin cậy** = số nguồn độc lập + chất lượng nguồn, không phải LLM tự khai (Spec C3: điểm phải giải thích được → có `GET /explain` như cụm market).
- **Phân biệt rõ**: *Sự kiện* (đã xảy ra) / *Phân tích* (suy luận của Gen) / *Dự báo* (có xác suất + nguồn mốc). Không trộn.
- Tài chính: luôn ghi "tham khảo, không phải khuyến nghị đầu tư"; nói theo kịch bản (nếu… thì…), không phán mua/bán.

## 6. Màn hình

Menu Boss hiện có 6 mục. Đề xuất **mục cấp 1 mới "Tình báo"** (icon `ph-radar`), Owner-only (giống Gen), 5 tab:

1. **Hôm nay** — Bản tin 3 phút: 5 thẻ quan trọng nhất + dải chỉ số (VN-Index, vàng SJC & chênh lệch với thế giới, Brent, USD/VND, BTC) có sparkline 30 ngày, đánh dấu biến động bất thường (> 2σ).
2. **Radar** — lưới 6 mảng, mỗi mảng 3–5 thẻ; lọc theo mức tác động / thời hạn.
3. **Dự báo** — sự kiện đang theo dõi + xác suất thị trường dự báo; *Sổ dự đoán* của Sếp & Gen, chấm điểm Brier theo thời gian → biết ai đoán giỏi, tránh tự tin mù.
4. **Học** — "1 khái niệm/ngày" + chuỗi ngày học; bấm "Đã hiểu" → tạo Bài học trong Kho.
5. **Kho tình báo** — tìm kiếm mọi tín hiệu cũ, dòng thời gian một câu chuyện (story) phát triển.

Đồng thời: thêm mục **"Tình báo"** vào Bản tin Gen 07:30 (`SECTION_META`) và kiểu Telegram mới `intel.alert` chỉ cho tín hiệu mức **Khẩn** (tối đa 2/ngày, có dedupe) — tránh thành máy spam.

Tinh thần Spec K: không làm dashboard cho đẹp; mọi biểu đồ phải dẫn tới một quyết định hoặc bị bỏ.

## 7. Kiến trúc trong repo hiện tại

- **Cụm mới** `apps/api/gh/biz/intel/` (`routes.py`, `service.py`, `jobs.py`, `collectors/`), thêm `intel` vào `CLUSTERS`.
- **Fetch**: dùng `pinned_client` (`gh/chassis/mcp_client.py`) — chặn SSRF, không redirect. Lưu ý nó bỏ qua `HTTPS_PROXY`; máy có proxy cần cờ cấu hình.
- **LLM**: qua `ModelRouter` với `purpose="intel.analyze"` / `"intel.digest"` → tự tính chi phí vào trần ngày. Có trần riêng cho intel (vd 30% trần chung).
- **Worker cron** (`_tracked`): thu thập theo nhịp nguồn (HN/GitHub 30 phút, arXiv 1 lần/ngày, giá 15 phút giờ giao dịch, GDELT 1 giờ); `intel_digest` 07:00 (trước Bản tin Gen 07:30).
- **DB** (schema mới `intel`, có `org_id`, RLS, GRANT `gh_app`, vào backup + retention):
  - `intel.sources` (loại, url, nhịp, trạng thái sức khoẻ, lỗi gần nhất)
  - `intel.items` (thô, chỉ INSERT; link, tiêu đề, trích, số đo, hash khử trùng)
  - `intel.stories` (cụm các item cùng chuyện, dùng pgvector có sẵn)
  - `intel.signals` (điểm, mảng, tác động, tin cậy, hạn, phân tích LLM, bằng chứng)
  - `intel.series` (chuỗi giá: mã, thời điểm, giá trị) — có thể partition bằng pg_partman
  - `intel.forecasts` (câu hỏi, xác suất, người dự, hạn, kết quả, Brier)
  - `intel.feedback` (user, signal, hữu ích/bỏ qua/theo dõi)
- **Màn mới**: sửa đúng 5 chỗ — `navigation.py`, `packages/contracts/src/screens.ts`, `rbac.py`, `docs/design/screens.json`, `gen/registry.json` + mock + test.
- **Sức khoẻ nguồn**: nguồn không chính thức (vnstock, giá vàng, Google News) hỏng → sự cố mức nhẹ trên `/system/health`, không làm chết cả hệ.

## 7b. Bản độc lập (giai đoạn đầu)

Lý do: ý tưởng còn mới, cần thử nhanh; không vướng quy trình phát hành/CI/RBAC của Gen-Harness (tăng `VERSION` là tự phát hành); không giẫm chân phiên đang làm main.

- **Dáng**: 1 app nhỏ gồm API (FastAPI) + worker định kỳ + Postgres (hoặc SQLite lúc thử) + web React. Một `docker compose` riêng.
- **Login**: 1 người dùng (Owner). Mật khẩu/passkey đơn + phiên cookie; khuyến nghị chỉ mở qua mạng riêng (Tailscale) hoặc sau Caddy. Không RBAC, không đa tổ chức.
- **AI**: khoá OpenRouter/Gemini trực tiếp, có trần chi phí VND/ngày riêng.

**Mối nối để gộp sau (giữ từ ngày đầu, gần như không tốn công):**
1. **Cùng công nghệ** với Gen-Harness (FastAPI, SQLAlchemy async, React + TanStack Query, token màu Nocturne) → bê code sang thành cụm `gh/biz/intel/` được.
2. **Hợp đồng dữ liệu** `Signal` (JSON schema cố định: mảng, tiêu đề, vậy-thì-sao, tin cậy, hạn, nguồn[]) — sau này Gen-Harness chỉ việc đọc qua API/MCP, giống cách Gen đọc Kho.
3. **Auth sau một cổng duy nhất** (`current_owner()`), lúc gộp thay bằng phiên Gen-Harness, không sửa nghiệp vụ.
4. **Bảng theo quy ước Gen-Harness** (có `org_id`, schema `intel`, chỉ INSERT với dữ liệu thô) → migration chép sang được.
5. **Gọi AI qua 1 lớp `llm.call(purpose, …)`**, lúc gộp đổi sang `ModelRouter` để tính chung trần chi phí.

Khi gộp: dữ liệu chuyển bằng script export/import; màn "Tình báo" thành mục menu Owner-only.

## 8. Lộ trình đề xuất

| Đợt | Nội dung | Kết quả Sếp thấy |
|---|---|---|
| **I-0** | Hồ sơ quan tâm + 5 nguồn AI (GitHub, HN, arXiv, HF, blog RSS) + chấm điểm + tab Hôm nay/Radar (chỉ mảng AI) | Mỗi sáng 5 thẻ AI đáng giá |
| **I-1** | Dải chỉ số tài chính (FRED/EIA/VCB/CoinGecko → rồi vnstock, vàng VN) + phát hiện biến động bất thường | Biết tài sản biến động gì trong 10 giây |
| **I-2** | Thế giới (GDELT + RSS) + Chính sách VN + phân tích tác động theo hồ sơ | "Chuyện này chạm tới mình thế nào" |
| **I-3** | Dự báo + Sổ dự đoán (Brier) + tab Học → Kho | Tiến bộ đo được, không chỉ đọc |
| **I-4** | Telegram khẩn, cầu nối "Cơ hội" → Bảng cơ hội bán hàng (qua Bàn làm việc, không tự hành động) | Tín hiệu biến thành việc |

## 9. Rủi ro & cách chặn

- **Quá tải tin** → trần cứng 5 thẻ/Hôm nay, 2 Telegram/ngày; mặc định ẩn mục điểm thấp.
- **Ảo giác / phân tích sai** → mọi thẻ có nguồn bấm được; tách Sự kiện/Phân tích/Dự báo; tin cậy tính từ nguồn, không từ LLM.
- **Prompt injection từ nội dung ngoài** → `wrap_untrusted`, không cho tín hiệu kích hoạt công cụ/hành động.
- **Nguồn không chính thức gãy** → fallback giữa provider + cảnh báo sức khoẻ nguồn.
- **ToS/bản quyền** → chỉ link + tóm tắt tự viết; Reddit/Product Hunt chỉ dùng nội bộ, không thương mại.
- **Chi phí AI** → lọc heuristic trước; trần riêng cho intel; tóm tắt theo lô.
- **Bong bóng sở thích** → 10% ngoài vùng quen; tab Radar luôn đủ 6 mảng.
- **Lời khuyên tài chính** → chỉ kịch bản + nguồn; không mua/bán thay; mọi hành động tiền qua Bàn làm việc (ngưỡng 50 triệu ₫).

## 10. Câu hỏi cần Sếp chốt trước khi code

1. "Tình báo" là **mục menu riêng** hay **tab trong Hôm nay**?
2. Đợt đầu ưu tiên mảng nào: AI (dễ, nguồn sạch) hay Tài chính (giá trị cao, nguồn dễ gãy)?
3. Sếp có muốn khai báo tài sản (loại/mã) để phân tích tác động sát hơn không?
4. Ngân sách AI riêng cho tình báo mỗi ngày (gợi ý 10–20 nghìn ₫)?

## Phụ lục — tham khảo

- WorldMonitor (AGPL-3.0): dashboard tình báo toàn cầu, 150+ RSS, tóm tắt cục bộ qua Ollama — học bố cục & tương quan tín hiệu, **không chép mã** (AGPL).
- auto-news: pipeline thu thập → chấm điểm → tóm tắt bằng LLM — đúng mô hình mục 2.
- Miniflux/FreshRSS + LLM: lõi RSS ổn định, gắn LLM bằng script.
