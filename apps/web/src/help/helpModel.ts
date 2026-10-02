/** Trợ giúp / Giới thiệu (v0.1.22, Đợt B3) — nội dung tĩnh + "Báo lỗi". */
import type { AboutInfo, Me } from '@gen-harness/contracts';

/** Lệnh genh Sếp hay cần — chạy trên máy chủ cài Gen-Harness (cửa sổ dòng lệnh). */
export const GENH_COMMANDS: Array<{ cmd: string; what: string }> = [
  { cmd: 'genh update', what: 'Cập nhật lên bản mới nhất (tự sao lưu trước, lỗi thì tự quay lại). Trong Console có nút "Cập nhật ngay".' },
  { cmd: 'genh reset-password', what: 'Quên mật khẩu Owner: in ra mật khẩu tạm, đăng nhập rồi đặt mật khẩu mới.' },
  { cmd: 'genh trust-ca', what: 'Trình duyệt báo "không an toàn": cho máy này tin chứng chỉ HTTPS nội bộ.' },
  { cmd: 'genh backup', what: 'Sao lưu ngay (thêm --to <thư mục> để chép ra ngoài). Trong Console: Dữ liệu & lưu trữ › Sao lưu ngay.' },
  { cmd: 'genh status', what: 'Xem các dịch vụ đang chạy, phiên bản và dung lượng dữ liệu đang dùng.' },
  { cmd: 'genh stop', what: 'Dừng toàn bộ dịch vụ (không mất dữ liệu). Chạy tiếp genh start để khởi động lại (vd. khi Bộ xử lý nền đã ngừng).' },
  { cmd: 'genh start', what: 'Bật lại toàn bộ dịch vụ sau genh stop.' },
  { cmd: 'genh logs worker', what: 'Xem lỗi gần nhất của Bộ xử lý nền (đổi "worker" thành api, bridge… cho dịch vụ khác).' },
];

/** Nội dung "Báo lỗi" — không có bí mật (không cookie, không khoá), chỉ đủ để dev tái hiện. */
export function diagnosticText(about: AboutInfo | undefined, me: Me | undefined, now = new Date()): string {
  const w = typeof window !== 'undefined' ? window : undefined;
  return [
    'Gen-Harness — thông tin báo lỗi',
    `Phiên bản: ${about?.version ?? 'bản phát triển (không rõ)'}`,
    `Tổ chức: ${about?.org_name ?? me?.org.name ?? '—'} · múi giờ ${about?.timezone ?? me?.org.timezone ?? '—'}`,
    `Vai trò: ${me?.role.name ?? about?.role.name ?? '—'}`,
    `Trang: ${w ? w.location.pathname + w.location.search : '—'}`,
    `Thời điểm: ${now.toISOString()}`,
    `Trình duyệt: ${typeof navigator !== 'undefined' ? navigator.userAgent : '—'}`,
    `Màn hình: ${w ? `${w.innerWidth}×${w.innerHeight}` : '—'} · ngôn ngữ ${typeof navigator !== 'undefined' ? navigator.language : '—'}`,
    'Mô tả lỗi (Sếp ghi thêm): ',
  ].join('\n');
}

/**
 * v0.1.36 (F-46): thêm phiên bản máy chủ + phiên bản công cụ cài đặt (genh) vào thông tin báo lỗi (ngay sau dòng
 * "Phiên bản:" của `diagnosticText`) — hai số có thể lệch nhau (genh cũ, máy chủ mới) và người hỗ trợ cần cả hai. Cùng
 * chữ với thẻ "Giới thiệu".
 */
export const SERVER_VERSION_LABEL = 'phiên bản máy chủ';
export const GENH_VERSION_LABEL = 'phiên bản công cụ cài đặt (genh)';

export function withVersions(text: string, about: AboutInfo | undefined): string {
  const extra = `Phiên bản máy chủ: ${about?.image_version || '—'} · ${GENH_VERSION_LABEL}: ${about?.genh_version ?? '—'}`;
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith('Phiên bản:'));
  lines.splice(i < 0 ? 1 : i + 1, 0, extra);
  return lines.join('\n');
}
