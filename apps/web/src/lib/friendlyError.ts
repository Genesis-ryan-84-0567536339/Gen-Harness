/**
 * v0.1.28 (UX N2): lỗi kỹ thuật thô từ máy chủ ("mạng: All connection attempts failed", "[Errno 2] No such file or
 * directory", "HTTP 401 …") → câu tiếng Việt có việc cần làm tiếp. Chuỗi gốc giữ lại làm "chi tiết kỹ thuật" (ẩn,
 * bấm mới hiện) để người hỗ trợ vẫn đọc được.
 */
export interface FriendlyError {
  message: string;
  /** Chuỗi gốc khi nó khác câu hiển thị; null = không có gì thêm để xem. */
  detail: string | null;
}

const RULES: Array<[RegExp, string]> = [
  [
    /errno 2|no such file|chưa cài antigravity|chưa cài công cụ đăng nhập|command not found/i,
    'Máy chủ chưa cài công cụ đăng nhập Google (Antigravity CLI) — dùng khoá API thay thế.',
  ],
  [
    /connection attempts failed|connecterror|connection refused|name or service not known|getaddrinfo|nodename|no route to host|network is unreachable|^mạng:/i,
    'Không gọi được địa chỉ này — kiểm tra lại Địa chỉ gọi (Endpoint) hoặc mạng của máy chủ.',
  ],
  [/timed? ?out|timeout|quá \d+ ?s\b/i, 'Nguồn này trả lời quá chậm — thử lại sau ít phút.'],
  [
    /\b401\b|\b403\b|xác thực|unauthori[sz]ed|invalid api key|api key not valid|permission denied|forbidden/i,
    'Khoá API không đúng hoặc đã bị thu hồi — kiểm tra lại khoá.',
  ],
  [/\b429\b|quota|rate.?limit|resource_exhausted|hết hạn mức/i, 'Khoá này đang hết hạn mức — thử lại sau hoặc thêm khoá khác.'],
  [/\b404\b|not found/i, 'Không tìm thấy dịch vụ ở địa chỉ này — kiểm tra lại Endpoint (thường kết thúc bằng /v1).'],
  [/\bssl\b|certificate|\btls\b/i, 'Kết nối bảo mật tới địa chỉ này bị lỗi — kiểm tra lại Endpoint (https).'],
  [/\b5\d\d\b|internal server error|bad gateway|service unavailable/i, 'Nhà cung cấp đang gặp sự cố — thử lại sau.'],
];

/** Dấu hiệu chuỗi là lỗi kỹ thuật (tiếng Anh / mã lỗi) chứ không phải câu đã viết cho người dùng. */
const TECHNICAL = /[[\]{}]|errno|exception|traceback|error:|http\s?\d{3}|\b[a-z]+error\b|failed|refused|not found|https?:\/\//i;

export function friendlyError(raw: string | null | undefined, fallback = 'Không kiểm tra được nguồn này — thử lại sau.'): FriendlyError {
  const text = (raw ?? '').trim();
  if (!text) return { message: fallback, detail: null };
  for (const [re, message] of RULES) if (re.test(text)) return { message, detail: text === message ? null : text };
  if (TECHNICAL.test(text)) return { message: fallback, detail: text };
  return { message: text, detail: null };
}
