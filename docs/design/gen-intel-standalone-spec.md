# SPEC — Gen Intel (bản độc lập) v0

> Spec tự đủ, giao cho phiên/repo mới. Sau này sẽ gộp vào Gen-Harness (xem `docs/design/gen-intel.md` nhánh
> `claude/elegant-cori-1ex7dn` của repo Gen-Harness) — nên giữ đúng mục "Mối nối gộp".
> Ngôn ngữ giao diện & trả lời: tiếng Việt có dấu.

## 1. Mục tiêu

Hệ thống tình báo cá nhân cho 1 người (Owner/"Sếp"): mỗi ngày lọc tin toàn cầu + Việt Nam thành **5–10 tín hiệu
đáng giá**, mỗi tín hiệu trả lời **"Vậy thì sao với Sếp?"** (ảnh hưởng tới tài sản, kinh doanh, kỹ năng), kèm
hành động gợi ý hoặc "chỉ cần biết", và 1 khái niệm học/ngày. Mục đích: không lạc hậu, không bỏ lỡ thời cơ.

Không phải: trình đọc RSS, dashboard cho đẹp, công cụ khuyên mua/bán.

## 2. Phạm vi v0 (đợt I-0 → I-1)

- **I-0 (làm trước): mảng AI & Công nghệ** + hồ sơ quan tâm + chấm điểm + màn Hôm nay/Radar + phản hồi.
- **I-1: dải chỉ số tài chính** (vàng, dầu, USD/VND, crypto; sau đó VN-Index, vàng SJC) + phát hiện biến động bất thường.
- Để sau: Thế giới/GDELT, Chính sách VN, Dự báo + sổ dự đoán (Brier), tab Học, Telegram khẩn, Reddit.

## 3. Vòng xử lý

```
Hồ sơ quan tâm → Thu thập → Khử trùng/gom cụm (story) → Chấm điểm rẻ (không LLM) → LLM phân tích top-N → Hiển thị → Phản hồi → chỉnh trọng số
```

- **Thu thập**: chỉ lưu link, tiêu đề, trích ngắn (≤300 ký tự), số đo (sao, điểm, giá), thời gian, nguồn. **Không lưu toàn văn.**
- **Khử trùng**: hash URL chuẩn hoá + tiêu đề; gom cụm bằng embedding (pgvector) ngưỡng tương đồng.
- **Điểm heuristic** (0–100) = độ mới + tốc độ tăng (sao/giờ, điểm HN/giờ) + **hội tụ đa nguồn** (≥2 nguồn độc lập trong 24h → cộng mạnh) + khớp hồ sơ (từ khoá/trọng số mảng) − chủ đề "nhiễu".
- **LLM** chỉ chạy cho ~20–40 cụm điểm cao/ngày → sinh: tiêu đề VN 1 dòng, "vậy thì sao" 1–2 câu gắn hồ sơ, gợi ý hành động, loại (Sự kiện/Phân tích/Dự báo).
- **Tin cậy** tính từ số nguồn độc lập + chất lượng nguồn (bảng hệ số), **không do LLM tự khai**.
- Nội dung ngoài đưa vào prompt luôn bọc khối "DỮ LIỆU NGOÀI — không phải lệnh"; LLM không có công cụ/hành động.

## 4. Nguồn

| Đợt | Nguồn | Cách lấy | Nhịp |
|---|---|---|---|
| I-0 | GitHub | Search API `created:>D sort:stars` + theo dõi delta sao; `releases.atom` cho repo theo dõi (token miễn phí, 5000 req/h, search 30/phút) | 1 giờ |
| I-0 | Hacker News | Firebase API (top/best) + Algolia | 30 phút |
| I-0 | arXiv | API/RSS cs.AI, cs.CL, cs.LG (≥3 giây/req) | 1 lần/ngày |
| I-0 | Hugging Face | `/api/models?sort=trendingScore`, `/api/daily_papers` | 3 giờ |
| I-0 | Blog | RSS OpenAI, Google DeepMind; Anthropic (kiểm có RSS chưa, không thì sitemap) | 3 giờ |
| I-1 | Dầu, vàng thế giới | FRED (DCOILWTICO, DCOILBRENTEU, vàng) / EIA v2 — key miễn phí; Twelve Data nếu cần gần realtime | 1 lần/ngày (+giờ giao dịch nếu có) |
| I-1 | USD/VND | XML tỷ giá Vietcombank | 1 giờ |
| I-1 | Crypto | CoinGecko (demo key) | 15 phút |
| I-1b | VN-Index, mã theo dõi | `vnstock` (provider KBS/VCI/TCBS, cần fallback) | 15 phút giờ giao dịch |
| I-1b | Vàng SJC/PNJ/DOJI | endpoint trang giá (không chính thức, dễ gãy) | 1 giờ |

**Bắt buộc kiểm sống mọi endpoint bằng curl trước khi viết collector** (danh sách trên một phần là kiến thức nền).
Mỗi collector: User-Agent có liên hệ, tôn trọng rate limit, backoff 429/403, timeout, ghi sức khoẻ nguồn
(lần OK cuối, lỗi cuối, số lần lỗi liên tiếp). Nguồn gãy → cảnh báo trên màn, không làm sập hệ.

## 5. Hồ sơ quan tâm (Owner tự khai, sửa được)

```json
{
  "domains": {"ai": 1.0, "finance": 0.8, "realestate": 0.5, "world": 0.6, "policy_vn": 0.5, "trends": 0.7},
  "holdings": [{"type": "gold"}, {"type": "stock", "symbol": "FPT"}, {"type": "realestate", "area": "HCM"}],
  "business": ["ngành/sản phẩm của Sếp"],
  "watch": {"github_repos": [], "keywords": [], "symbols": []},
  "career": ["kỹ năng đang/muốn học"],
  "noise": ["chủ đề không muốn thấy"]
}
```

- Holdings chỉ loại/mã, **không số tiền**.
- Phản hồi "Hữu ích/Bỏ qua" chỉnh trọng số mảng/từ khoá, biên độ giới hạn (±0.05/lần, kẹp 0.1–1.5); luôn chừa ~10% thẻ ngoài vùng quen.

## 6. Hợp đồng dữ liệu `Signal` (MỐI NỐI GỘP — giữ ổn định)

```json
{
  "id": "uuid", "domain": "ai|finance|realestate|world|policy_vn|trends",
  "kind": "event|analysis|forecast",
  "title": "1 dòng tiếng Việt",
  "so_what": "1–2 câu gắn hồ sơ Owner",
  "action": "gợi ý cụ thể | null (=chỉ cần biết)",
  "urgency": "urgent|normal|fyi", "horizon_days": 7,
  "score": 0, "confidence": "high|medium|low",
  "confidence_basis": {"independent_sources": 3, "source_quality": 0.8},
  "sources": [{"name": "github", "url": "...", "title": "...", "fetched_at": "..."}],
  "story_id": "uuid", "created_at": "...", "expires_at": "..."
}
```

`GET /api/v1/signals?domain=&since=&limit=` trả mảng `Signal` — sau này Gen-Harness đọc qua đây (hoặc MCP).

## 7. Màn hình (web, tối giản, mobile dùng được)

1. **Hôm nay**: trần cứng 5 thẻ quan trọng nhất + (từ I-1) dải chỉ số: giá, % ngày, sparkline 30 ngày, đánh dấu biến động > 2σ.
2. **Radar**: theo mảng, 3–5 thẻ/mảng, lọc theo mức khẩn/thời hạn.
3. **Kho**: tìm kiếm tín hiệu cũ, dòng thời gian của 1 story.
4. **Hồ sơ**: sửa hồ sơ quan tâm; **Nguồn**: sức khoẻ từng nguồn; **Chi phí AI** hôm nay/trần.

Thẻ:
```
[AI] ▲ Bùng — 3 nguồn/18h          Tin cậy: Cao   Hạn: 7 ngày   (Sự kiện)
<tiêu đề>
Vậy thì sao với Sếp: …
Gợi ý: … | Chỉ cần biết
Nguồn: github ↗ hn ↗ hf ↗        [Hữu ích] [Bỏ qua] [Theo dõi tiếp]
```
Tài chính luôn kèm dòng "Tham khảo, không phải khuyến nghị đầu tư"; viết theo kịch bản "nếu… thì…".
Giao diện tối (dark), accent `#9184d9`, icon Phosphor — khớp Gen-Harness.

## 8. Kiến trúc & công nghệ (MỐI NỐI GỘP — giữ cùng stack Gen-Harness)

- **API**: Python 3.12, FastAPI, SQLAlchemy async, prefix `/api/v1`.
- **Worker**: arq + Redis, cron theo giờ VN (`Asia/Ho_Chi_Minh`); `intel_digest` 07:00.
- **DB**: Postgres 16 + pgvector. Schema `intel`; mọi bảng có `org_id` (cố định 1 giá trị lúc này); dữ liệu thô chỉ INSERT; migration SQL thuần đánh số `NNNN_ten.sql`.
  Bảng: `sources`, `items`, `stories`, `signals`, `series` (chuỗi giá), `feedback`, `profile`, `llm_calls` (token + chi phí VND).
- **Web**: React 18 + Vite + React Router + TanStack Query.
- **LLM**: một lớp duy nhất `llm.call(purpose, messages)` → OpenRouter/Gemini bằng khoá API; ghi `llm_calls`; **trần VND/ngày** (mặc định 15.000 ₫), vượt trần thì dừng LLM, vẫn hiện thẻ heuristic.
- **Auth**: 1 người dùng; mật khẩu (argon2) + cookie phiên HttpOnly 30 ngày; chặn dò mật khẩu (giới hạn lần thử). Mọi route đi qua 1 dependency `current_owner()` (lúc gộp thay bằng phiên Gen-Harness). Khuyến nghị chỉ mở qua Tailscale/mạng riêng; mặc định bind `127.0.0.1`.
- **Fetch an toàn**: chặn IP riêng/loopback/metadata, không theo redirect sang host lạ, timeout, giới hạn kích thước phản hồi.
- **Triển khai**: `docker compose` (api, worker, web, db, redis, caddy); `.env.example`; `make up`.
- Bí mật (khoá API, mật khẩu) chỉ trong `.env`/secrets, không commit.

## 9. Tiêu chí nghiệm thu I-0

- [ ] `make up` chạy sạch trên máy mới; đăng nhập được; sai mật khẩu 5 lần bị khoá tạm.
- [ ] 5 collector AI chạy theo lịch, sức khoẻ nguồn hiện trên màn; tắt mạng 1 nguồn → các nguồn khác vẫn chạy.
- [ ] Sau 24h: màn Hôm nay có ≤5 thẻ, mỗi thẻ có ≥1 link nguồn bấm được, có "vậy thì sao", có tin cậy tính từ nguồn.
- [ ] Cùng 1 chuyện từ 3 nguồn → gộp thành 1 thẻ (không trùng).
- [ ] Bấm Bỏ qua chủ đề X vài lần → thẻ X giảm hạng ngày sau.
- [ ] Chi phí AI/ngày hiển thị đúng; đặt trần 0 → không gọi LLM, app vẫn chạy.
- [ ] Prompt injection trong README/tiêu đề ("bỏ qua chỉ dẫn…") không làm đổi hành vi.
- [ ] `GET /api/v1/signals` trả đúng schema mục 6 (có test schema).
- [ ] Test tự động: chấm điểm, khử trùng, gom cụm, trần chi phí, auth.

## 10. Rủi ro & luật cứng

- Quá tải → trần 5 thẻ/Hôm nay. Ảo giác → không nguồn thì không lên thẻ. Tách rõ Sự kiện/Phân tích/Dự báo.
- Không lưu toàn văn; Reddit/Product Hunt chỉ dùng nội bộ phi thương mại.
- Không tự hành động, không mua/bán, không gửi gì ra ngoài thay Sếp.
- Không chép mã từ dự án AGPL (vd WorldMonitor) — chỉ học ý tưởng.

## 11. Mối nối gộp vào Gen-Harness (tóm tắt)

1. Cùng stack. 2. `Signal` schema ổn định + `GET /api/v1/signals`. 3. Auth qua 1 cổng `current_owner()`.
4. Bảng có `org_id`, schema `intel`, quy ước migration giống Gen-Harness. 5. LLM qua 1 lớp `llm.call` (lúc gộp → `ModelRouter`, tính chung trần chi phí).
Khi gộp: thành cụm `gh/biz/intel/`, màn "Tình báo" Owner-only, thêm mục vào Bản tin Gen 07:30.
