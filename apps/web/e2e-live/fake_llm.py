"""Model giả tương thích OpenAI: tin có 'container'/'tấn'/'giá' → unit, còn lại → noise."""
import json, re
from http.server import BaseHTTPRequestHandler, HTTPServer

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
        lines = user.split("Tin nhắn (mỗi dòng một JSON):\n", 1)[-1].splitlines()
        units, noise = [], []
        for l in lines:
            if not l.strip(): continue
            d = json.loads(l); t = d["text"].lower()
            if "container" in t or "giá" in t:
                units.append({"evidence": [d["ref"]], "event_type": "AskedPrice", "side": "demand",
                              "conclusion": "Hỏi giá: " + d["text"][:80], "entities": {"product": "thép"},
                              "confidence": 0.88, "rules": {"R-01": 0.9}, "signals": {"heat": 72, "potential": 60}})
            elif "tồn" in t or "sẵn" in t:
                units.append({"evidence": [d["ref"]], "event_type": "OfferedSupply", "side": "supply",
                              "conclusion": "Chào bán: " + d["text"][:80], "entities": {},
                              "confidence": 0.55, "rules": {"R-02": 0.8}, "signals": {"potential": 40}})
            else:
                noise.append(d["ref"])
        self._send({"choices": [{"message": {"content": json.dumps({"units": units, "noise": noise},
                                                                     ensure_ascii=False)}}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 50}})
    def log_message(self, *a): pass

HTTPServer(("127.0.0.1", 9911), H).serve_forever()
