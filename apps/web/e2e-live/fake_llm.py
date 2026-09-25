"""Model giả tương thích OpenAI:
- Lời nhắc sàng lọc (`gh.refinery`, có "Tin nhắn (mỗi dòng một JSON):"): tin có 'container'/'giá' → unit cầu
  (demand); 'còn hàng' → unit cung (supply) độ tin ĐỦ qua ngưỡng `min_confidence` mặc định của bước 7 thiết lập
  (0.6 — dùng cho giai đoạn 5.3 luồng 4, `live-phase3.spec.ts`, cần tín hiệu cung thật vào được kho sạch để có
  cặp ghép Cung↔Cầu); 'tồn'/'sẵn' → unit cung độ tin THẤP hơn ngưỡng đó có chủ đích (live-phase2.spec.ts dựa vào
  đúng việc nó bị lọc — "Đã vào kho sạch: 1" — để kiểm bộ lọc `min_confidence`; ĐỪNG đổi số này); còn lại → noise.
- Lời nhắc agent trực kênh (`gh.biz.duty.engine.messages`, có "Ngữ cảnh (mỗi dòng: mã rồi JSON):"): tin được TAG
  → "draft" (soạn sẵn một câu trả lời ngắn, chỉ trích C1, không bịa số/ID ngoài ngữ cảnh); còn lại → "silent".
  Dùng cho giai đoạn 5.3 luồng 5 (`live-phase3.spec.ts`) — agent đọc ngữ cảnh thật, soạn nháp thật.
"""
import json, re
from http.server import BaseHTTPRequestHandler, HTTPServer

DUTY_MARK = "Ngữ cảnh (mỗi dòng: mã rồi JSON):"
REFINERY_MARK = "Tin nhắn (mỗi dòng một JSON):\n"


class H(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        self._send({"data": [{"id": "fake-flash"}, {"id": "fake-pro"}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        user = body["messages"][-1]["content"]
        if DUTY_MARK in user:
            self._send(self._duty_decide(user))
        else:
            self._send(self._refine(user))

    def _refine(self, user: str) -> dict:
        lines = user.split(REFINERY_MARK, 1)[-1].splitlines()
        units, noise = [], []
        for l in lines:
            if not l.strip(): continue
            d = json.loads(l); t = d["text"].lower()
            if "container" in t or "giá" in t:
                units.append({"evidence": [d["ref"]], "event_type": "AskedPrice", "side": "demand",
                              "conclusion": "Hỏi giá: " + d["text"][:80], "entities": {"product": "thép"},
                              "confidence": 0.88, "rules": {"R-01": 0.9}, "signals": {"heat": 72, "potential": 60}})
            elif "còn hàng" in t:
                units.append({"evidence": [d["ref"]], "event_type": "OfferedSupply", "side": "supply",
                              "conclusion": "Chào bán: " + d["text"][:80], "entities": {"product": "thép cuộn"},
                              "confidence": 0.75, "rules": {"R-02": 0.85}, "signals": {"potential": 55}})
            elif "tồn" in t or "sẵn" in t:
                units.append({"evidence": [d["ref"]], "event_type": "OfferedSupply", "side": "supply",
                              "conclusion": "Chào bán: " + d["text"][:80], "entities": {},
                              "confidence": 0.55, "rules": {"R-02": 0.8}, "signals": {"potential": 40}})
            else:
                noise.append(d["ref"])
        return {"choices": [{"message": {"content": json.dumps({"units": units, "noise": noise},
                                                                 ensure_ascii=False)}}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 50}}

    def _duty_decide(self, user: str) -> dict:
        """Trả JSON đúng khuôn `gh.biz.duty.engine.parse`: chỉ trích C1 (đơn vị kích hoạt), không bịa ID/mã
        không có trong ngữ cảnh. Được tag → soạn nháp trả lời; không tag → im lặng (mặc định an toàn)."""
        tagged = "Bạn được TAG trực tiếp" in user
        if tagged:
            decision = {"decision": "draft", "rationale": "Khách hỏi giá trực tiếp, tag agent — soạn nháp chờ duyệt.",
                        "context_refs": ["C1"],
                        "text": "Dạ em ghi nhận yêu cầu của anh/chị, em kiểm tra rồi báo giá sớm nhất ạ."}
        else:
            decision = {"decision": "silent", "rationale": "Không được tag, chưa cần phản hồi.", "context_refs": []}
        return {"choices": [{"message": {"content": json.dumps(decision, ensure_ascii=False)}}],
                "usage": {"prompt_tokens": 120, "completion_tokens": 40}}

    def log_message(self, *a): pass


HTTPServer(("127.0.0.1", 9911), H).serve_forever()
