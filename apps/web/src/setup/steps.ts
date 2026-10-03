/** The 12 setup steps — docs/handoff/06 "12 bước". */
export interface StepMeta {
  n: number;
  key: string;
  title: string;
  required: boolean;
  /** Nội dung (what the step asks for). */
  content: string;
  /** Hoàn thành khi (completion condition). */
  doneWhen: string;
  /** Implemented in the web (phase 1: 1–3, phase 2: 4–7 and 12). */
  built: boolean;
}

export const SETUP_STEPS: StepMeta[] = [
  {
    n: 1, key: 'welcome', title: 'Chào mừng', required: true, built: true,
    content: 'Nhập mã thiết lập từ trình cài (tự điền nếu có trong đường dẫn).',
    doneWhen: 'Mã hợp lệ',
  },
  {
    n: 2, key: 'owner', title: 'Tài khoản Owner', required: true, built: true,
    content: 'Tên hiển thị, email, mật khẩu (ít nhất 12 ký tự) và mã PIN 6 số nhập hai lần. PIN bảo vệ mọi thao tác nhạy cảm.',
    doneWhen: 'Tài khoản tạo xong, đăng nhập tự động',
  },
  {
    n: 3, key: 'org', title: 'Tổ chức & xưng hô', required: true, built: true,
    content: 'Tên tổ chức, múi giờ, tiền tệ và cách xưng hô giữa Sếp với agent — xem trước một câu trả lời mẫu cập nhật trực tiếp.',
    doneWhen: 'Lưu',
  },
  {
    n: 4, key: 'brain', title: 'Bộ não AI', required: false, built: true,
    content: 'Chọn nguồn AI cho hệ thống: Antigravity CLI (đăng nhập Google rồi dán mã xác thực) và/hoặc khoá API (Gemini, DeepSeek, tương thích OpenAI). Mỗi khoá có nút Kiểm tra gọi thử một lượt, hiện độ trễ và model khả dụng. Sắp thứ tự chuỗi chuyển hướng.',
    doneWhen: 'Ít nhất một provider kiểm tra OK',
  },
  {
    n: 5, key: 'channels', title: 'Kết nối kênh', required: false, built: true,
    content: 'Thẻ từng kênh. Zalo/WhatsApp: tạo mã QR, đếm ngược 60 giây tự làm mới, chờ quét → đã quét → đồng bộ danh sách nhóm. Cảnh báo rủi ro tài khoản cá nhân trước khi hiện QR. Telegram và kênh khác chưa có trong bản này — thẻ ghi rõ, không có nút cài.',
    doneWhen: 'Ít nhất một kênh đang hoạt động · hoặc Để sau (hiện ở "Việc thiết lập tiếp" trên Hôm nay)',
  },
  {
    n: 6, key: 'groups', title: 'Chọn nhóm lắng nghe', required: false, built: true,
    content: 'Bảng nhóm vừa đồng bộ. Mỗi nhóm chọn chế độ: Không nghe · Chỉ khi được tag · Nghe im lặng · Chủ động bắt tín hiệu, và phạm vi xem. Mặc định Không nghe cho mọi nhóm — Sếp bật từng nhóm.',
    doneWhen: 'Ít nhất một nhóm được bật · hoặc Để sau (hiện ở "Việc thiết lập tiếp" trên Hôm nay)',
  },
  {
    n: 7, key: 'refinery', title: 'Sàng lọc dữ liệu', required: false, built: true,
    content: 'Chu kỳ thời gian, ngưỡng số lượng và ngưỡng tin cậy vào kho sạch. Chọn bộ quy tắc khởi đầu theo ngành, xem trước điều kiện và đầu ra. Bảng trọng số chấm điểm tổng 100%.',
    doneWhen: 'Lưu · hoặc Để sau (hiện ở "Việc thiết lập tiếp" trên Hôm nay)',
  },
  {
    n: 8, key: 'agent', title: 'Agent đầu tiên', required: false, built: true,
    content: 'Chọn mẫu (Trợ lý thương mại, Khách hàng lớn, Hậu cần, Chăm sóc khách hàng, Tuyển dụng, Thư ký cá nhân) hoặc tạo trống. Sửa tên, xưng hô, giọng, được nói khi, cấm. Gán kênh/nhóm và thử trò chuyện ba lượt.',
    doneWhen: 'Agent được lưu, có ít nhất một phạm vi kênh · hoặc Để sau (hiện ở "Việc thiết lập tiếp" trên Hôm nay)',
  },
  {
    n: 9, key: 'autonomy', title: 'Tự trị & ranh giới', required: false, built: true,
    content: 'Thang tự trị 0–6, mặc định 4. Ngưỡng tiền phải duyệt (mặc định 50.000.000 ₫). Danh sách ranh giới có trách nhiệm; mục khoá hiện công tắc mờ kèm lý do không tắt được.',
    doneWhen: 'Lưu · hoặc Để sau (hiện ở "Việc thiết lập tiếp" trên Hôm nay)',
  },
  {
    n: 10, key: 'team', title: 'Mời đội ngũ', required: false, built: true,
    content: 'Thêm email và vai trò (Quản lý, Vận hành, Nhân viên phụ trách, Kiểm soát), xem trước ma trận quyền của vai trò đã chọn. Sinh liên kết mời.',
    doneWhen: 'Để sau được — hiện ở "Việc thiết lập tiếp" trên Hôm nay',
  },
  {
    n: 11, key: 'backup', title: 'Sao lưu', required: false, built: true,
    content: 'Lịch sao lưu (mặc định hằng ngày 02:00), nơi lưu trên máy chủ (bản sao ra ổ USB/NAS chọn ở Cài đặt › Sao lưu & cập nhật), giữ bao lâu. Nút Sao lưu thử ngay với tiến độ %.',
    doneWhen: 'Để sau được (có cảnh báo) — hiện ở "Việc thiết lập tiếp" trên Hôm nay',
  },
  {
    n: 12, key: 'finish', title: 'Hoàn tất', required: true, built: true,
    content: 'Tóm tắt những gì đã bật. Tiến độ lần sàng lọc đầu tiên theo thời gian thực: bản ghi thô đã gom · đang phân loại · đã vào kho sạch. Nút Vào Console (mở trang chủ theo vai trò — Owner là Hôm nay).',
    doneWhen: 'Bấm nút',
  },
];

/** Description line under each step title (right pane). */
export const STEP_DESCRIPTIONS: Record<number, string> = {
  1: 'Mã thiết lập chứng minh Sếp là người vừa chạy trình cài trên máy này. Chọn ngôn ngữ và cách bắt đầu.',
  2: 'Tài khoản Owner thấy toàn cảnh. Mật khẩu để đăng nhập, mã PIN để xác nhận thao tác nhạy cảm.',
  3: 'Thông tin tổ chức và cách agent xưng hô với Sếp trong mọi tin nhắn.',
  4: 'Hệ thống cần ít nhất một nguồn AI để đọc và hiểu tin nhắn: đăng nhập tài khoản Google (Antigravity CLI) hoặc dán khoá API. Bấm Kiểm tra, chọn model, rồi xếp thứ tự dùng khi một nguồn hết hạn mức. Để sau được, nhưng khi chưa có model thì Gen và sàng lọc tin chưa chạy.',
  5: 'Kết nối ít nhất một kênh để hệ thống bắt đầu gom tin. Zalo và WhatsApp đăng nhập bằng mã QR trên điện thoại của Sếp.',
  6: 'Mọi nhóm vừa đồng bộ đều ở chế độ Không nghe. Sếp bật từng nhóm muốn agent lắng nghe và chọn ai được xem dữ liệu của nhóm.',
  7: 'Bao lâu hệ thống lọc tin một lần, những loại tin cần bắt, và cách chấm điểm. Bấm Để sau thì dùng sẵn bộ quy tắc khởi đầu — chỉnh lại được ở Quy tắc sàng lọc.',
  8: 'Tạo trợ lý AI đầu tiên: chọn một mẫu hoặc tự đặt tên, vai trò và giọng nói, rồi nhắn thử một câu để nghe trợ lý trả lời.',
  9: 'Chọn mức trợ lý được tự làm. Những giới hạn bên dưới luôn bật để bảo vệ Sếp và nhân viên — không ai tắt được.',
  10: 'Tuỳ chọn — để sau thì mời ở Đội ngũ › Người dùng. Hệ thống chưa tự gửi email mời: mật khẩu tạm hiện ngay ở đây, Sếp tự gửi qua Zalo hoặc email cá nhân.',
  11: 'Chọn giờ hệ thống tự sao lưu mỗi ngày. Bấm Để sau thì hệ thống vẫn tự sao lưu hằng ngày lúc 02:00, giữ 7 bản gần nhất.',
  12: 'Kiểm tra lại những gì đã bật. Việc còn thiếu có liên kết để làm tiếp — làm ngay hoặc sau ở Hôm nay.',
};

/** When the PIN is asked for — design `pinRules` (Tài khoản của tôi › Mã PIN). */
export const PIN_RULES: Array<[string, string]> = [
  ['yêu cầu PIN khi', 'đăng xuất kênh, đổi tài khoản CLI, cài plugin, đổi quyền'],
  ['hết hạn phiên PIN', 'sau 30 phút không thao tác'],
  ['nhập sai 5 lần', 'khoá Console 15 phút và báo qua kênh chat khi đã kết nối'],
  ['ghi nhật ký', 'mọi lần nhập, kể cả sai, đều vào Nhật ký hành động'],
];

export const TIMEZONES = [
  { value: 'Asia/Ho_Chi_Minh', label: 'Asia/Ho_Chi_Minh (GMT+7)' },
  { value: 'Asia/Bangkok', label: 'Asia/Bangkok (GMT+7)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (GMT+8)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (GMT+9)' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney (GMT+10/11)' },
  { value: 'Europe/London', label: 'Europe/London (GMT+0/1)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (GMT−8/−7)' },
  { value: 'UTC', label: 'UTC' },
];

export const CURRENCIES = [
  { value: 'VND', label: 'VND — Đồng Việt Nam (₫)' },
  { value: 'USD', label: 'USD — Đô la Mỹ ($)' },
  { value: 'EUR', label: 'EUR — Euro (€)' },
  // v0.1.28 (UX V13): đủ 8 loại máy chủ nhận (gh.setup.routes.CURRENCIES) — bước 3 và tab Tổ chức dùng chung danh sách.
  { value: 'JPY', label: 'JPY — Yên Nhật (¥)' },
  { value: 'SGD', label: 'SGD — Đô la Singapore (S$)' },
  { value: 'THB', label: 'THB — Baht Thái (฿)' },
  { value: 'CNY', label: 'CNY — Nhân dân tệ (¥)' },
  { value: 'KRW', label: 'KRW — Won Hàn Quốc (₩)' },
];
