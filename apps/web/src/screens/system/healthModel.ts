/**
 * v0.1.36 (F-6): đổi `GET /system/health` (`SystemHealth`) thành các dòng chữ đã định dạng cho thẻ "Sức khoẻ hệ thống"
 * (Điều khiển hệ thống › Dữ liệu & lưu trữ) và sắp sự cố cho dải "Cần Sếp xử lý" (đầu Tổng quan). Hàm thuần — test được,
 * mọi giá trị trả ra là chuỗi (không bao giờ đưa object vào JSX).
 */
import type { HealthIssue, SystemHealth } from '@gen-harness/contracts';
import { DEFAULT_TZ, fmtAgo, fmtDM, fmtDMClock, fmtDec, fmtHM, fmtInt } from '../../lib/format';

export type HealthTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface HealthRow {
  key: 'worker' | 'browser' | 'dlq' | 'backup' | 'update' | 'disk' | 'autostart';
  label: string;
  value: string;
  tone: HealthTone;
  /** Câu ngắn dưới dòng: Sếp nên làm gì (hoặc không cần làm gì) khi dòng vàng/đỏ mà không có hướng dẫn riêng. */
  hint?: string;
}

export interface HealthTechRow {
  name: string;
  value: string;
  tone: HealthTone;
}

const GB = 1024 ** 3;

/** 12_884_901_888 → "12,0 GB". */
export function fmtGb(bytes: number): string {
  return `${fmtDec(bytes / GB, 1)} GB`;
}

/** Các dòng chính của thẻ "Sức khoẻ hệ thống" (theo đúng thứ tự hiển thị). */
export function healthRows(h: SystemHealth, now = Date.now(), tz = DEFAULT_TZ): HealthRow[] {
  const rows: HealthRow[] = [];

  const w = h.worker;
  rows.push(
    w.state === 'ok'
      ? { key: 'worker', label: 'Bộ xử lý nền', value: w.last_seen_at ? `Đang chạy · lần cuối ${fmtAgo(w.last_seen_at, now, tz)}` : 'Đang chạy', tone: 'ok' }
      : w.state === 'silent'
        ? { key: 'worker', label: 'Bộ xử lý nền', value: w.silent_minutes != null ? `Đã ngừng ${fmtInt(w.silent_minutes)} phút` : 'Đã ngừng — chưa thấy chạy lại', tone: 'bad' }
        : { key: 'worker', label: 'Bộ xử lý nền', value: 'Chưa có tín hiệu', tone: 'warn' },
  );

  const b = h.browser;
  rows.push(
    b.state === 'ok'
      ? { key: 'browser', label: 'Trình duyệt nền', value: b.last_heartbeat_at ? `Đang chạy · lần cuối ${fmtAgo(b.last_heartbeat_at, now, tz)}` : 'Đang chạy', tone: 'ok' }
      : b.state === 'silent'
        ? { key: 'browser', label: 'Trình duyệt nền', value: b.last_heartbeat_at ? `Ngừng từ ${fmtAgo(b.last_heartbeat_at, now, tz)}` : 'Đã ngừng', tone: 'warn' }
        : { key: 'browser', label: 'Trình duyệt nền', value: 'Chưa bật', tone: 'muted' },
  );

  const dlq = h.queues.reduce((sum, q) => sum + (Number.isFinite(q.dlq) ? q.dlq : 0), 0);
  // Thuật ngữ "DLQ" chỉ ở "Chi tiết kỹ thuật" (healthTechRows); chưa có màn xem từng việc lỗi ⇒ chỉ báo số lượng.
  rows.push(
    dlq > 0
      ? { key: 'dlq', label: 'Việc nền bị lỗi', value: `${fmtInt(dlq)} việc`, tone: 'warn', hint: 'Thường tự hết, chưa cần làm gì; kéo dài nhiều ngày thì gửi kèm khi báo lỗi (Trợ giúp › Báo lỗi).' }
      : { key: 'dlq', label: 'Việc nền bị lỗi', value: 'Không có', tone: 'ok' },
  );

  const bk = h.backup;
  rows.push(
    !bk.configured
      ? { key: 'backup', label: 'Sao lưu', value: 'Chưa cấu hình', tone: 'warn' }
      : bk.stale
        ? { key: 'backup', label: 'Sao lưu', value: `Quá ${bk.stale_after || '36 giờ'} chưa sao lưu`, tone: 'bad' }
        : bk.latest_at
          ? { key: 'backup', label: 'Sao lưu', value: `Bản mới nhất ${fmtAgo(bk.latest_at, now, tz)}`, tone: 'ok' }
          : { key: 'backup', label: 'Sao lưu', value: 'Chưa có bản nào', tone: 'warn' },
  );

  const u = h.update;
  rows.push(
    // `failed` = lỗi trong 24 giờ qua (cùng điều kiện thẻ cập nhật) — quá hạn thì API trả false dù state vẫn 'failed'.
    u.failed
      ? { key: 'update', label: 'Cập nhật', value: u.blocked_version ? `Lần cập nhật gần nhất lỗi (${u.blocked_version})` : 'Lần cập nhật gần nhất lỗi', tone: 'bad' }
      : u.state === 'stalled' && u.stalled_reason === 'process_gone'
        ? { key: 'update', label: 'Cập nhật', value: 'Cập nhật bị dừng giữa chừng', tone: 'warn' }
        : u.state === 'stalled'
          ? { key: 'update', label: 'Cập nhật', value: 'Máy chủ chưa nhận yêu cầu cập nhật', tone: 'warn' }
          : u.state === 'requested' || u.state === 'running'
            ? { key: 'update', label: 'Cập nhật', value: 'Đang cập nhật', tone: 'muted' }
            : u.state === 'unknown'
              ? { key: 'update', label: 'Cập nhật', value: 'Chưa rõ', tone: 'muted' }
              : { key: 'update', label: 'Cập nhật', value: 'Bình thường', tone: 'ok' },
  );

  // Ổ đĩa chỉ được đo khi genh chạy `genh update` (disk-status.json) — số có thể cũ cả ngày ⇒ luôn ghi giờ đo.
  const d = h.disk;
  const measured = d.checked_at ? ` · đo lúc ${fmtDM(d.checked_at, tz)} ${fmtHM(d.checked_at, tz)}` : '';
  rows.push(
    d.state === 'low'
      ? { key: 'disk', label: 'Ổ đĩa', value: `${d.free_bytes != null ? `Sắp hết chỗ — còn ${fmtGb(d.free_bytes)}` : 'Sắp hết chỗ'}${measured}`, tone: 'bad' }
      : d.state === 'ok' && d.free_bytes != null
        ? { key: 'disk', label: 'Ổ đĩa', value: `Còn ${fmtGb(d.free_bytes)} trống${measured}`, tone: 'ok' }
        : { key: 'disk', label: 'Ổ đĩa', value: 'Chưa đo', tone: 'muted' },
  );

  // v0.1.37 (F-73): máy chủ có tự chạy lại Gen-Harness khi bật máy không — genh chỉ kiểm khi chạy genh status/doctor
  // hoặc lần cập nhật kế tiếp ⇒ luôn ghi giờ kiểm. api cũ/không có hộp thư với genh ⇒ không có khối ⇒ không có dòng.
  const a = h.autostart;
  if (a) {
    const checked = a.checked_at ? ` · kiểm lúc ${fmtDM(a.checked_at, tz)} ${fmtHM(a.checked_at, tz)}` : '';
    rows.push(
      a.state === 'warn'
        ? { key: 'autostart', label: 'Tự chạy lại khi bật máy', value: `Chưa bật${checked}`, tone: 'warn' }
        : a.state === 'ok'
          ? { key: 'autostart', label: 'Tự chạy lại khi bật máy', value: `Có${checked}`, tone: 'ok' }
          : { key: 'autostart', label: 'Tự chạy lại khi bật máy', value: 'Chưa rõ', tone: 'muted' },
    );
  }
  return rows;
}

export interface HealthTipStep {
  text: string;
  /** Lệnh chạy trên máy chủ (cửa sổ dòng lệnh) — hiện dạng mã, có thể chép. */
  cmd?: string;
}
export interface HealthTip {
  key: 'disk' | 'worker' | 'autostart';
  title: string;
  steps: HealthTipStep[];
  /** Cảnh báo rủi ro (Sếp tự quyết, nhưng phải thấy rõ). */
  warning?: string;
}

/**
 * Hướng dẫn tự xử lý ngay trong thẻ — đích của nút "Xem cách giải phóng" (disk.low), "Xem sức khoẻ" (worker.silent) và
 * "Xem cách bật" (host.autostart, cả chuông) ở dải "Cần Sếp xử lý": nút hứa gì thì trang đích phải có đúng cái đó.
 */
export function healthTips(h: SystemHealth): HealthTip[] {
  const tips: HealthTip[] = [];
  if (h.disk.state === 'low') {
    const need = h.disk.min_bytes != null ? fmtGb(h.disk.min_bytes) : null;
    tips.push({
      key: 'disk',
      title: 'Cách giải phóng chỗ trống',
      steps: [
        { text: 'Trên máy chủ, xem dịch vụ và dung lượng đang dùng:', cmd: 'genh status' },
        { text: 'Xoá container đã dừng, ảnh Docker không gắn tên và bộ nhớ đệm build không còn dùng (không đụng dữ liệu Gen-Harness):', cmd: 'docker system prune' },
        { text: 'Chép bản sao lưu cũ, video, tệp tải về… sang ổ khác rồi xoá khỏi máy chủ.' },
        // Ổ đĩa chỉ được đo lại khi genh cập nhật (apps/genh/internal/ops/update.go ensureDiskSpace), không phải mỗi phút.
        {
          text: `${need ? `Còn trống từ ${need} trở lên thì` : 'Đủ chỗ trống thì'} chạy lệnh dưới để đo lại ổ đĩa và cập nhật luôn (hoặc chờ lần cập nhật tự động đêm nay) — cảnh báo sẽ tự hết:`,
          cmd: 'genh update',
        },
      ],
      warning: 'Không xoá thư mục cài Gen-Harness hay volume Docker (không dùng "docker volume prune" hoặc cờ --volumes) — đó là dữ liệu của Sếp.',
    });
  }
  if (h.worker.state === 'silent') {
    tips.push({
      key: 'worker',
      title: 'Cách khởi động lại Bộ xử lý nền',
      steps: [
        { text: 'Trên máy chủ, dừng rồi bật lại toàn bộ dịch vụ (không mất dữ liệu, Console tạm gián đoạn khoảng 1 phút):', cmd: 'genh stop' },
        { text: 'Rồi:', cmd: 'genh start' },
        { text: 'Vẫn ngừng thì xem lỗi của Bộ xử lý nền và gửi kèm khi báo lỗi (Trợ giúp › Báo lỗi):', cmd: 'genh logs worker' },
      ],
    });
  }
  const a = h.autostart;
  if (a && a.state === 'warn') {
    // Lệnh cố định (cùng chuỗi genh/API in) — dựng từ giá trị đã lọc của API, không lấy chữ nào từ tệp trên máy chủ.
    const steps: HealthTipStep[] = [];
    if (a.docker_enabled === 'no') {
      steps.push(
        a.docker_mode === 'rootless'
          ? { text: 'Trên máy chủ, bật Docker (rootless) tự chạy khi mở máy — chạy một lần:', cmd: 'systemctl --user enable docker' }
          : { text: 'Trên máy chủ, bật Docker tự chạy khi mở máy — chạy một lần (máy hỏi mật khẩu đăng nhập máy):', cmd: 'sudo systemctl enable docker' },
      );
    }
    if (a.linger_required === true && a.linger === 'no') {
      steps.push({
        text: a.docker_mode === 'rootless'
          ? 'Cho Docker rootless, lịch tự cập nhật và nút Cập nhật ngay chạy cả khi không ai đăng nhập — chạy một lần:'
          : 'Cho lịch tự cập nhật và nút Cập nhật ngay chạy cả khi không ai đăng nhập — chạy một lần:',
        cmd: 'sudo loginctl enable-linger $USER',
      });
    }
    steps.push({ text: 'Chạy xong thì kiểm lại để cảnh báo tự hết (hoặc đợi tới đêm, lần cập nhật tự động sẽ kiểm lại):', cmd: 'genh status' });
    tips.push({ key: 'autostart', title: 'Cách bật tự chạy lại khi bật máy', steps });
  }
  return tips;
}

/** "Chi tiết kỹ thuật": lịch chạy (tên hàm + giờ chạy cuối theo múi giờ tổ chức) và từng hàng lỗi `<stream>.dlq`. */
export function healthTechRows(h: SystemHealth, tz = DEFAULT_TZ): { crons: HealthTechRow[]; queues: HealthTechRow[] } {
  const crons = h.crons.map((c) => ({
    name: c.name,
    value: c.last_at ? `${fmtDMClock(c.last_at, tz)} · ${c.ok === false ? 'lỗi' : c.ok === true ? 'ok' : '—'}` : 'chưa chạy',
    tone: (c.ok === false ? 'bad' : c.ok === true ? 'ok' : 'muted') as HealthTone,
  }));
  const queues = h.queues.map((q) => ({ name: `${q.stream}.dlq`, value: fmtInt(q.dlq), tone: (q.dlq > 0 ? 'warn' : 'ok') as HealthTone }));
  return { crons, queues };
}

/** Sự cố cho dải "Cần Sếp xử lý": 'bad' trước 'warn', cùng mức thì mới nhất trước. */
export function sortIssues(issues: readonly HealthIssue[]): HealthIssue[] {
  const rank = (s: HealthIssue['severity']) => (s === 'bad' ? 0 : 1);
  return [...issues].sort((a, b) => rank(a.severity) - rank(b.severity) || String(b.raised_at).localeCompare(String(a.raised_at)));
}

/** Màu theo tông (token sẵn có — tự đổi theo theme sáng/tối). */
export const TONE_COLOR: Record<HealthTone, string> = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  bad: 'var(--color-bad)',
  muted: 'var(--color-neutral-500)',
};
