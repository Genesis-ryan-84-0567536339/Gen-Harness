/**
 * Hướng dẫn thiết lập: các việc tuỳ chọn 5–11 của trình thiết lập + (v0.1.39) 13 Kết nối Facebook, 14 Nối Gen-hub. Chữ viết cho Owner không rành kỹ
 * thuật: vì sao cần, chuẩn bị gì, bấm gì theo đúng nhãn nút trên màn hình, và làm sao biết đã xong. Nút "Làm bước
 * này" mở đúng form của trình thiết lập ngay trong Console (`/guide/:n`), kể cả sau khi đã bấm Hoàn tất.
 */
/** Khoá cache của `GET /setup/follow-up` — dùng chung cho thẻ Tổng quan và trang Hướng dẫn thiết lập. */
export const FOLLOW_UP_KEY = ['setup', 'follow-up'] as const;

export interface GuideItem {
  n: number;
  title: string;
  /** Một câu: làm việc này để được gì. */
  why: string;
  /** Cần chuẩn bị trước khi bắt đầu. */
  prepare: string[];
  /** Các bước bấm theo thứ tự, dùng đúng nhãn nút trên màn hình. */
  steps: string[];
  /** Dấu hiệu đã xong (hệ thống tự nhận ra, không cần bấm tay). */
  doneWhen: string;
  /** Làm ở màn Console đầy đủ (chỉnh chi tiết hơn form hướng dẫn). */
  console: { label: string; to: string };
  /** Việc nên làm trước (số bước). */
  after?: number;
  /** v0.1.39: việc không có form trình thiết lập — nút chính mở thẳng màn này (không mở `/guide/:n`). */
  doTo?: string;
  /** Nhãn nút chính khi có `doTo`. */
  doLabel?: string;
}

export const GUIDE: GuideItem[] = [
  {
    n: 5,
    title: 'Kết nối Zalo / WhatsApp',
    why: 'Để agent đọc được tin nhắn trong các nhóm chat của Sếp — không có kênh thì hệ thống chưa có dữ liệu để làm việc.',
    prepare: ['Điện thoại đang đăng nhập Zalo hoặc WhatsApp của chính Sếp.', 'Máy tính và điện thoại đều có mạng.'],
    steps: [
      'Bấm "Làm bước này" bên dưới.',
      'Ở thẻ Zalo (hoặc WhatsApp), bấm "Tạo mã QR".',
      'Đọc cảnh báo, tích "Tôi hiểu rủi ro…" rồi bấm "Tôi hiểu, hiện mã QR".',
      'Trên điện thoại: Zalo → biểu tượng quét QR (góc trên) · WhatsApp → Cài đặt → Thiết bị đã liên kết → Liên kết thiết bị. Quét mã trên màn hình.',
      'Chờ thẻ chuyển sang "Đang kết nối" và đồng bộ xong danh sách nhóm (mã QR tự làm mới mỗi 60 giây nếu chưa kịp quét).',
      'Bấm "Tiếp tục" để lưu.',
    ],
    doneWhen: 'Có ít nhất một kênh ở trạng thái Đang kết nối.',
    console: { label: 'Kết nối', to: '/connections' },
  },
  {
    n: 6,
    title: 'Chọn nhóm cho agent lắng nghe',
    why: 'Mọi nhóm mới đều ở chế độ Không nghe để bảo vệ riêng tư — Sếp chọn nhóm nào agent được nghe.',
    prepare: ['Đã kết nối ít nhất một kênh (việc 01) và đồng bộ xong danh sách nhóm.'],
    steps: [
      'Bấm "Làm bước này".',
      'Trong bảng nhóm, ở cột "Chế độ lắng nghe" của nhóm muốn theo dõi, chọn một chế độ: "Chỉ khi được tag" (an toàn nhất), "Lắng nghe im lặng" (ghi nhận, không trả lời) hoặc "Chủ động bắt tín hiệu".',
      'Ở cột "Phạm vi xem", chọn ai được xem dữ liệu nhóm đó (mặc định "Chỉ Sếp").',
      'Bấm "Tiếp tục".',
    ],
    doneWhen: 'Có ít nhất một nhóm không còn ở chế độ Không nghe.',
    console: { label: 'Khách & Cơ hội › Khách & Nhóm', to: '/directory' },
    after: 5,
  },
  {
    n: 7,
    title: 'Bật sàng lọc dữ liệu',
    why: 'Tin nhắn thô được lọc, phân loại và chấm điểm trước khi vào kho sạch — agent chỉ dùng dữ liệu đã lọc.',
    prepare: ['Không cần chuẩn bị gì — để mặc định là dùng được ngay.'],
    steps: [
      'Bấm "Làm bước này".',
      'Giữ mặc định "Chu kỳ thời gian" và "Ngưỡng số lượng" (lọc khi đủ thời gian hoặc đủ số tin, cái nào đến trước).',
      'Ở "Bộ quy tắc khởi đầu", tích các quy tắc hợp với việc kinh doanh của Sếp (xem điều kiện và đầu ra ngay trên từng dòng).',
      'Bấm "Tiếp tục".',
    ],
    doneWhen: 'Có ít nhất một quy tắc sàng lọc đang bật.',
    console: { label: 'Quy tắc sàng lọc', to: '/rules' },
  },
  {
    n: 8,
    title: 'Tạo agent đầu tiên',
    why: 'Agent là "nhân viên AI" làm việc thay Sếp trên các kênh — có tên, vai trò và giọng nói riêng.',
    prepare: ['Bộ não AI đã chạy (bước 4 của trình thiết lập — đã xong nếu Sếp đang ở Console).'],
    steps: [
      'Bấm "Làm bước này".',
      'Chọn một "Mẫu" (ví dụ Trợ lý thương mại, CSKH, Thư ký cá nhân) — tên và vai trò được điền sẵn.',
      'Sửa "Tên agent" và "Vai trò — agent làm gì cho Sếp" nếu muốn.',
      'Gõ một "Câu thử trò chuyện", ví dụ "Chào em, hôm nay có khách nào hỏi hàng không?".',
      'Bấm "Tiếp tục" rồi đọc câu trả lời thử của agent; bấm "Tiếp tục" lần nữa để lưu.',
    ],
    doneWhen: 'Có ít nhất một agent.',
    console: { label: 'Danh tính Agent', to: '/agents' },
  },
  {
    n: 9,
    title: 'Đặt mức tự trị cho agent',
    why: 'Quyết định agent được tự làm tới đâu: chỉ gợi ý, hay soạn sẵn chờ Sếp duyệt rồi mới gửi.',
    prepare: ['Đã có agent (việc 04).'],
    steps: [
      'Bấm "Làm bước này".',
      'Ở "Mức tự trị", chọn 4 (agent soạn sẵn, Sếp duyệt rồi mới gửi — khuyên dùng) hoặc 3 (agent chỉ gợi ý).',
      'Đọc danh sách "Ranh giới khoá cứng" — các việc agent không bao giờ được tự làm.',
      'Tích "Tôi đã đọc các ranh giới trên" rồi bấm "Tiếp tục".',
    ],
    doneWhen: 'Agent đã có mức tự trị (tạo agent là có mức mặc định; bước này để Sếp chọn lại cho chắc).',
    console: { label: 'Danh tính Agent', to: '/agents' },
    after: 8,
  },
  {
    n: 10,
    title: 'Mời người trong đội',
    why: 'Cho quản lý, nhân viên cùng dùng Console với quyền hạn riêng — mỗi người chỉ thấy phần được giao.',
    prepare: ['Tên và email của từng người.'],
    steps: [
      'Bấm "Làm bước này".',
      'Bấm "Thêm người", điền "Tên hiển thị", "Email" và chọn "Vai trò" (Quản lý, Vận hành, Nhân viên phụ trách, Kiểm soát).',
      'Thêm đủ người rồi bấm "Tiếp tục".',
      'Hệ thống hiện mật khẩu tạm của từng người — chép lại và tự gửi cho họ qua Zalo/email riêng (chưa có gửi thư tự động).',
      'Nhân viên ở máy khác hoặc dùng điện thoại cần Truy cập từ xa: Sếp chạy genh remote tailscale (khuyên dùng) trên máy chủ trước khi gửi. Lời nhắn kèm địa chỉ đăng nhập có ở Đội ngũ › Người dùng (nút "Mời người dùng" hoặc "Đặt lại mật khẩu") — hộp đó cảnh báo đỏ nếu địa chỉ chỉ mở được trên máy chủ.',
      'Bấm "Đã lưu, sang bước sau".',
    ],
    doneWhen: 'Có thêm ít nhất một tài khoản ngoài Sếp.',
    console: { label: 'Đội ngũ › Người dùng', to: '/team' },
  },
  {
    n: 11,
    title: 'Đặt lịch sao lưu',
    why: 'Máy hỏng hay lỡ tay xoá vẫn khôi phục được dữ liệu — bản sao lưu được mã hoá và giữ ngay trong máy.',
    prepare: ['Chọn giờ máy thường rảnh (mặc định 02:00 sáng).'],
    steps: [
      'Bấm "Làm bước này".',
      'Chọn "Tần suất" (khuyên dùng "Hằng ngày").',
      'Nhập "Giờ chạy (HH:MM)", ví dụ 02:00.',
      'Bấm "Tiếp tục".',
    ],
    doneWhen: 'Đã có lịch sao lưu.',
    console: { label: 'Cài đặt › Sao lưu & cập nhật', to: '/system?tab=storage' },
  },
  {
    n: 13,
    title: 'Kết nối Facebook',
    why: 'Để Gen đọc thông báo, tin nhắn và — khi Sếp bấm Xác nhận + nhập PIN — trả lời bình luận / nhắn tin thay Sếp; không đăng bài.',
    prepare: ['Tài khoản Facebook thật của chính Sếp (không dùng tài khoản phụ hay nick ảo).', 'Điện thoại để nhận mã xác minh nếu Facebook hỏi.'],
    steps: [
      'Bấm "Mở trang Tài khoản mạng xã hội" bên dưới.',
      'Bấm "Thêm tài khoản", đặt tên dễ nhận ra.',
      'Đọc kỹ cảnh báo rủi ro, tích hai ô xác nhận rồi lưu.',
      'Bấm "Đăng nhập" — Sếp tự đăng nhập ngay trong app (mật khẩu, mã 2FA không lưu lại).',
      'Khi tài khoản báo Đang kết nối, bấm "Đọc ngay" để thử đọc thông báo.',
    ],
    doneWhen: 'Đã đăng nhập Facebook ít nhất một lần.',
    console: { label: 'Tài khoản mạng xã hội', to: '/social' },
    doTo: '/social',
    doLabel: 'Mở trang Tài khoản mạng xã hội',
  },
  {
    n: 14,
    title: 'Nối Gen-hub',
    why: 'Để Gen đọc Kho tri thức của Sếp trên Gen-hub (chỉ đọc) — trả lời có căn cứ từ việc, quyết định, bài học đã ghi.',
    prepare: ['Tài khoản Gen-hub của Sếp.', 'Địa chỉ Gen-hub (ví dụ https://hub.genos.top/mcp).'],
    steps: [
      'Trong Gen-hub: tạo trợ lý mới, chọn thẻ truy cập (token) 90 ngày, chỉ bật quyền ĐỌC Kho.',
      'Tuỳ chọn: tick thêm quyền ĐỌC lịch, đọc mail, đọc việc (Google Tasks) và tìm Drive để bản tin Gen có lịch hôm nay, mail cần trả lời, việc đang mở — KHÔNG bật quyền ghi.',
      'Chép token vừa tạo.',
      'Bấm "Mở thẻ Gen-hub" bên dưới, dán địa chỉ và token vào thẻ Gen-hub.',
      'Bấm "Lưu & kiểm tra" (nhập PIN khi được hỏi) và chờ báo Đã nối Kho.',
    ],
    doneWhen: 'Kiểm tra xanh ít nhất một lần.',
    console: { label: 'Kết nối › Gen-hub', to: '/connections#genhub' },
    doTo: '/connections#genhub',
    doLabel: 'Mở thẻ Gen-hub',
  },
];

/**
 * v0.1.29: bước 4 "Để sau" được. Không nằm trong danh sách 5–11 của trang Hướng dẫn — Tổng quan có dải "Chưa có model"
 * riêng mở thẳng `/guide/4` (cùng form bước 4 của trình thiết lập, lưu được cả sau Hoàn tất).
 */
export const MODEL_GUIDE: GuideItem = {
  n: 4,
  title: 'Chọn model AI (bộ não)',
  why: 'Chưa có model thì Gen không trả lời được và tin nhắn chưa được sàng lọc — chỉ được gom về kho thô.',
  prepare: ['Tài khoản Google (đăng nhập Antigravity CLI) hoặc một khoá API (Gemini, DeepSeek, tương thích OpenAI).'],
  steps: [
    'Đăng nhập Google, hoặc dán khoá API rồi bấm "Thêm & kiểm tra".',
    'Khi nguồn báo Hoạt động, chọn model rồi bấm "Dùng model này" (không chọn thì hệ thống dùng model đầu tiên).',
    'Bấm "Tiếp tục".',
  ],
  doneWhen: 'Gen hoặc Sàng lọc đã được gán một model.',
  console: { label: 'API & Model', to: '/api' },
};

export const GUIDE_BY_N: Record<number, GuideItem> = Object.fromEntries([MODEL_GUIDE, ...GUIDE].map((g) => [g.n, g]));

/** v0.1.39: số thứ tự hiển thị (01, 02…) của việc n trong danh sách Hướng dẫn thiết lập — không phải số bước. */
export function guideOrdinal(n: number): string {
  const i = GUIDE.findIndex((g) => g.n === n);
  return String(i >= 0 ? i + 1 : n).padStart(2, '0');
}

/** v0.1.30: thẻ ẩn khi người dùng đã bấm "Ẩn" và KHÔNG có bước dở nào mới so với lúc ẩn. */
export function followUpHidden(pending: number[], hidden: number[] | undefined): boolean {
  if (!hidden) return false;
  return pending.every((n) => hidden.includes(n));
}
