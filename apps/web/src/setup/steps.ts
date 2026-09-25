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
    content: 'Nhập mã thiết lập từ trình cài (tự điền nếu có trong đường dẫn), chọn ngôn ngữ giao diện, và chọn bắt đầu trống hoặc dùng dữ liệu mẫu.',
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
    n: 4, key: 'brain', title: 'Bộ não AI', required: true, built: true,
    content: 'Chọn nguồn core agent: Antigravity CLI (đăng nhập Google rồi dán mã xác thực) và/hoặc khoá API (Gemini, DeepSeek, tương thích OpenAI). Mỗi khoá có nút Kiểm tra gọi thử một lượt, hiện độ trễ và model khả dụng. Sắp thứ tự chuỗi chuyển hướng.',
    doneWhen: 'Ít nhất một provider kiểm tra OK',
  },
  {
    n: 5, key: 'channels', title: 'Kết nối kênh', required: true, built: true,
    content: 'Thẻ từng kênh. Zalo/WhatsApp: tạo mã QR, đếm ngược 60 giây tự làm mới, chờ quét → đã quét → đồng bộ danh sách nhóm. Cảnh báo rủi ro tài khoản cá nhân trước khi hiện QR. Telegram và kênh khác: cài plugin từ chợ.',
    doneWhen: 'Ít nhất một kênh đang hoạt động',
  },
  {
    n: 6, key: 'groups', title: 'Chọn nhóm lắng nghe', required: true, built: true,
    content: 'Bảng nhóm vừa đồng bộ. Mỗi nhóm chọn chế độ: Không nghe · Chỉ khi được tag · Nghe im lặng · Chủ động bắt tín hiệu, và phạm vi xem. Mặc định Không nghe cho mọi nhóm — Sếp bật từng nhóm.',
    doneWhen: 'Ít nhất một nhóm được bật',
  },
  {
    n: 7, key: 'refinery', title: 'Sàng lọc dữ liệu', required: true, built: true,
    content: 'Chu kỳ thời gian, ngưỡng số lượng và ngưỡng tin cậy vào kho sạch. Chọn bộ quy tắc khởi đầu theo ngành, xem trước điều kiện và đầu ra. Bảng trọng số chấm điểm tổng 100%.',
    doneWhen: 'Lưu',
  },
  {
    n: 8, key: 'agent', title: 'Agent đầu tiên', required: true, built: false,
    content: 'Chọn mẫu (Trợ lý thương mại, Key Account, Admin hậu cần, CSKH, Recruiter, Thư ký cá nhân) hoặc tạo trống. Sửa tên, xưng hô, giọng, được nói khi, cấm. Gán kênh/nhóm và thử trò chuyện ba lượt.',
    doneWhen: 'Agent được lưu, có ít nhất một phạm vi kênh',
  },
  {
    n: 9, key: 'autonomy', title: 'Tự trị & ranh giới', required: true, built: false,
    content: 'Thang tự trị 0–6, mặc định 4. Ngưỡng tiền phải duyệt (mặc định 50.000.000 ₫). Danh sách ranh giới có trách nhiệm; mục khoá hiện công tắc mờ kèm lý do không tắt được.',
    doneWhen: 'Lưu',
  },
  {
    n: 10, key: 'team', title: 'Mời đội ngũ', required: false, built: false,
    content: 'Thêm email và vai trò (Manager, Operator, Agent nhân viên, Auditor), xem trước ma trận quyền của vai trò đã chọn. Sinh liên kết mời.',
    doneWhen: 'Bỏ qua được',
  },
  {
    n: 11, key: 'backup', title: 'Sao lưu', required: false, built: false,
    content: 'Lịch sao lưu (mặc định hằng ngày 02:00), nơi lưu (trong máy hoặc S3-compatible), giữ bao lâu. Nút Sao lưu thử ngay với tiến độ %.',
    doneWhen: 'Bỏ qua được (có cảnh báo)',
  },
  {
    n: 12, key: 'finish', title: 'Hoàn tất', required: true, built: true,
    content: 'Tóm tắt những gì đã bật. Tiến độ lần sàng lọc đầu tiên theo thời gian thực: bản ghi thô đã gom · đang phân loại · đã vào kho sạch. Nút Mở Tổng quan điều hành.',
    doneWhen: 'Bấm nút',
  },
];

/** Description line under each step title (right pane). */
export const STEP_DESCRIPTIONS: Record<number, string> = {
  1: 'Mã thiết lập chứng minh Sếp là người vừa chạy trình cài trên máy này. Chọn ngôn ngữ và cách bắt đầu.',
  2: 'Tài khoản Owner thấy toàn cảnh. Mật khẩu để đăng nhập, mã PIN để xác nhận thao tác nhạy cảm.',
  3: 'Thông tin tổ chức và cách agent xưng hô với Sếp trong mọi tin nhắn.',
  4: 'Core agent cần ít nhất một nguồn model: tài khoản Antigravity CLI hoặc khoá API. Kiểm tra từng nguồn rồi sắp thứ tự chuyển hướng khi một nguồn cạn hạn mức.',
  5: 'Kết nối ít nhất một kênh để bridge bắt đầu gom tin. Zalo và WhatsApp đăng nhập bằng mã QR trên điện thoại của Sếp.',
  6: 'Mọi nhóm vừa đồng bộ đều ở chế độ Không nghe. Sếp bật từng nhóm muốn agent lắng nghe và chọn ai được xem dữ liệu của nhóm.',
  7: 'Khi nào core agent sàng lọc kho thô, bộ quy tắc khởi đầu, và trọng số chấm điểm. Chỉnh lại được sau ở Quy tắc sàng lọc.',
  12: 'Mọi thứ đã sẵn sàng. Lần sàng lọc đầu tiên đang chạy — theo dõi ngay tại đây rồi mở Tổng quan điều hành.',
};

/** When the PIN is asked for — design `pinRules` (Điều khiển hệ thống › Mã PIN). */
export const PIN_RULES: Array<[string, string]> = [
  ['yêu cầu PIN khi', 'đăng xuất kênh, đổi tài khoản CLI, cài plugin, đổi quyền'],
  ['hết hạn phiên PIN', 'sau 30 phút không thao tác'],
  ['nhập sai 5 lần', 'khoá Console 15 phút và báo qua Zalo của Sếp'],
  ['ghi nhật ký', 'mọi lần nhập, kể cả sai, đều vào Action Log'],
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
];
