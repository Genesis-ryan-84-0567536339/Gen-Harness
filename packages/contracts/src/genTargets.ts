/**
 * Gen v1 (docs/design/gen-v1.md §3.5) — nguồn sự thật cho màn Gen được mở và phần tử Gen được làm sáng.
 *
 * - `GEN_SCREENS`: khoá màn Gen được `navigate` tới (khoá screens.ts + trang `guide`, `account`) → đường dẫn.
 * - `GEN_TARGETS`: mỗi mục tiêu gắn bằng `data-gen-target="<id>"` trên đúng một phần tử React của màn `screen`.
 *   `dynamic: 'row'` = mục tiêu theo dòng, id thật là `<id>:<row id>`; row id PHẢI đến từ kết quả tool của chính lượt
 *   đó (server kiểm, chống bịa). `params` = trạng thái URL cần có để phần tử hiện ra (vd tab của Điều khiển hệ thống).
 *
 * Kiểm chéo: `apps/web/test/unit/gen-targets.test.ts` quét `apps/web/src` (mỗi id có chỗ gắn và ngược lại) và so
 * với bản xuất cho API `apps/api/gh/gen/registry.json` (chạy `GEN_WRITE=1 npx vitest run gen-targets` để ghi lại).
 */
import { SCREENS } from './screens';

export interface GenTarget {
  id: string;
  /** Khoá màn (GenScreenKey). */
  screen: string;
  /** Nhãn ngắn Gen dùng khi nói với Sếp. */
  label: string;
  /** Mô tả cho model: phần tử này làm gì. */
  description: string;
  dynamic?: 'row';
  /** Tham số URL cần có để phần tử hiện ra (vd `{ tab: 'brain' }`). */
  params?: Record<string, string>;
}

export interface GenScreen {
  key: string;
  path: string;
  title: string;
}

/** Trang ngoài screens.ts mà Gen cũng mở được. */
const EXTRA_SCREENS: GenScreen[] = [
  { key: 'guide', path: '/guide', title: 'Hướng dẫn kết nối' },
  { key: 'account', path: '/account', title: 'Tài khoản của tôi' },
];

export const GEN_SCREENS: GenScreen[] = [
  ...SCREENS.map((s) => ({ key: s.key, path: `/${s.key}`, title: s.title })),
  ...EXTRA_SCREENS,
];

export const GEN_SCREEN_BY_KEY: Record<string, GenScreen> = Object.fromEntries(GEN_SCREENS.map((s) => [s.key, s]));

export const GEN_TARGETS: GenTarget[] = [
  // ── Tổng quan ──
  { id: 'overview.kpis', screen: 'overview', label: 'Hàng chỉ số chính', description: 'Các ô số liệu đầu trang Tổng quan (cơ hội, cảnh báo, chờ duyệt…)' },
  { id: 'overview.queue', screen: 'overview', label: 'Hàng đợi cần xử lý', description: 'Khung liệt kê cơ hội, cảnh báo, bản nháp chờ duyệt, việc đến hạn' },
  { id: 'overview.queue.row', screen: 'overview', label: 'Một dòng hàng đợi', description: 'Một mục cụ thể trong Hàng đợi cần xử lý', dynamic: 'row' },
  { id: 'overview.queue.open_inbox', screen: 'overview', label: 'Nút "Mở hộp thư ý nghĩa"', description: 'Mở Hộp thư ý nghĩa để xem toàn bộ hàng đợi' },
  { id: 'overview.spotlight', screen: 'overview', label: '5 đối tượng đáng chú ý', description: 'Năm người/khách nổi bật nhất hôm nay' },
  { id: 'overview.health', screen: 'overview', label: 'Sức khoẻ hệ thống', description: 'Tình trạng kênh và backlog sàng lọc' },
  // ── Hướng dẫn kết nối ──
  { id: 'guide.progress', screen: 'guide', label: 'Thanh tiến độ', description: 'Bao nhiêu việc thiết lập đã xong' },
  { id: 'guide.item', screen: 'guide', label: 'Một việc thiết lập', description: 'Thẻ một việc thiết lập (theo số việc n)', dynamic: 'row' },
  { id: 'guide.item.do', screen: 'guide', label: 'Nút "Làm bước này"', description: 'Mở form làm việc thiết lập n', dynamic: 'row' },
  // ── Điều khiển hệ thống ──
  { id: 'system.tab.channels', screen: 'system', label: 'Tab "Kênh & đăng nhập"', description: 'Chuyển sang tab kênh Zalo/WhatsApp, PIN, CLI' },
  { id: 'system.tab.brain', screen: 'system', label: 'Tab "Bộ não AI"', description: 'Chuyển sang tab nhà cung cấp model, hạn mức, Jev' },
  { id: 'system.tab.storage', screen: 'system', label: 'Tab "Dữ liệu & lưu trữ"', description: 'Chuyển sang tab hạn lưu, sao lưu & khôi phục' },
  { id: 'system.channels.list', screen: 'system', label: 'Danh sách kênh', description: 'Thẻ các kênh Zalo/WhatsApp và nút tạo mã QR', params: { tab: 'channels' } },
  { id: 'system.channels.pin', screen: 'system', label: 'Thẻ mã PIN', description: 'Đổi mã PIN, xem lịch sử nhập PIN', params: { tab: 'channels' } },
  { id: 'system.brain.quota', screen: 'system', label: 'Hạn mức theo model', description: 'Bảng dùng trong ngày / còn lại của từng model', params: { tab: 'brain' } },
  { id: 'system.brain.chain', screen: 'system', label: 'Chuỗi chuyển hướng', description: 'Thứ tự nhà cung cấp model khi một nơi lỗi', params: { tab: 'brain' } },
  { id: 'system.brain.open_api', screen: 'system', label: 'Nút "Mở API & Model"', description: 'Sang màn thêm nhà cung cấp, khoá API, gán model', params: { tab: 'brain' } },
  { id: 'system.brain.jev', screen: 'system', label: 'Thẻ Jev (System One)', description: 'Cấu hình nguồn model quyết định nhanh Jev', params: { tab: 'brain' } },
  { id: 'system.brain.jev.test', screen: 'system', label: 'Nút "Kiểm tra" Jev', description: 'Gọi thử Jev để biết khoá và địa chỉ đúng chưa', params: { tab: 'brain' } },
  { id: 'system.storage.retention', screen: 'system', label: 'Hạn lưu dữ liệu', description: 'Mỗi tập dữ liệu giữ bao lâu', params: { tab: 'storage' } },
  { id: 'system.backup.panel', screen: 'system', label: 'Sao lưu & khôi phục', description: 'Danh sách bản sao lưu, tải về, khôi phục', params: { tab: 'storage' } },
  { id: 'system.backup.now', screen: 'system', label: 'Nút "Sao lưu ngay"', description: 'Tạo bản sao lưu ngay lúc này', params: { tab: 'storage' } },
  { id: 'system.backup.schedule', screen: 'system', label: 'Lịch sao lưu tự động', description: 'Đổi tần suất và giờ sao lưu tự động', params: { tab: 'storage' } },
  // ── API & Model ──
  { id: 'api.add_provider', screen: 'api', label: 'Nút "Thêm nhà cung cấp"', description: 'Thêm Gemini/DeepSeek/API tương thích OpenAI' },
  { id: 'api.bindings', screen: 'api', label: 'Gán model cho từng agent', description: 'Chọn model cho từng mục đích, gồm core.gen của Gen' },
  // ── Tài khoản của tôi ──
  { id: 'account.profile', screen: 'account', label: 'Hồ sơ', description: 'Đổi tên hiển thị, email' },
  { id: 'account.password', screen: 'account', label: 'Đổi mật khẩu', description: 'Đặt mật khẩu mới' },
  { id: 'account.pin', screen: 'account', label: 'Đổi mã PIN', description: 'Đặt mã PIN 6 số mới' },
  { id: 'account.sessions', screen: 'account', label: 'Phiên đăng nhập', description: 'Thiết bị đang đăng nhập, đăng xuất thiết bị khác' },
  // ── Quy tắc sàng lọc ──
  { id: 'rules.add', screen: 'rules', label: 'Nút "Thêm quy tắc"', description: 'Tạo quy tắc sàng lọc mới' },
  { id: 'rules.batch', screen: 'rules', label: 'Nút "Chạy thử trên 100 bản ghi"', description: 'Thử bộ quy tắc trên dữ liệu gần nhất' },
  { id: 'rules.list', screen: 'rules', label: 'Danh sách quy tắc', description: 'Các quy tắc sàng lọc đang có' },
  { id: 'rules.weights', screen: 'rules', label: 'Trọng số chấm điểm', description: 'Kéo thanh để đổi trọng số các chiều chấm điểm' },
  { id: 'rules.tryone', screen: 'rules', label: 'Chạy thử một bản ghi', description: 'Dán một tin để xem quy tắc nào khớp' },
  // ── Danh tính agent ──
  { id: 'agents.add', screen: 'agents', label: 'Nút "Tạo agent mới"', description: 'Tạo danh tính agent mới' },
  { id: 'agents.clone', screen: 'agents', label: 'Nút "Nhân bản"', description: 'Nhân bản một agent có sẵn' },
  { id: 'agents.list', screen: 'agents', label: 'Danh sách agent', description: 'Các agent đang có, mức tự trị, kênh' },
  { id: 'agents.decisions', screen: 'agents', label: 'Agent đã nói gì', description: 'Nhật ký quyết định của agent' },
  { id: 'agents.templates', screen: 'agents', label: 'Mẫu có sẵn', description: 'Mẫu agent tạo nhanh' },
];

export const GEN_TARGET_BY_ID: Record<string, GenTarget> = Object.fromEntries(GEN_TARGETS.map((t) => [t.id, t]));

/** `overview.queue.row:0192…` → { base: 'overview.queue.row', row: '0192…' }; id tĩnh → row null. */
export function splitTargetId(id: string): { base: string; row: string | null } {
  const i = id.indexOf(':');
  return i < 0 ? { base: id, row: null } : { base: id.slice(0, i), row: id.slice(i + 1) };
}

/** Mục tiêu (tĩnh hoặc động) có trong registry không. */
export function resolveTarget(id: string): GenTarget | null {
  const { base, row } = splitTargetId(id);
  const t = GEN_TARGET_BY_ID[base];
  if (!t) return null;
  if ((t.dynamic === 'row') !== (row !== null)) return null;
  return t;
}
