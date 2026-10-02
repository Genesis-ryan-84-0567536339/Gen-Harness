/**
 * v0.1.36 (F-6): đổi `GET /system/health` (`SystemHealth`) thành các dòng chữ đã định dạng cho thẻ "Sức khoẻ hệ thống"
 * (Điều khiển hệ thống › Dữ liệu & lưu trữ) và sắp sự cố cho dải "Cần Sếp xử lý" (đầu Tổng quan). Hàm thuần — test được,
 * mọi giá trị trả ra là chuỗi (không bao giờ đưa object vào JSX).
 */
import type { HealthIssue, SystemHealth } from '@gen-harness/contracts';
import { DEFAULT_TZ, fmtAgo, fmtDMClock, fmtDec, fmtInt } from '../../lib/format';

export type HealthTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface HealthRow {
  key: 'worker' | 'browser' | 'dlq' | 'backup' | 'update' | 'disk';
  label: string;
  value: string;
  tone: HealthTone;
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
        ? { key: 'worker', label: 'Bộ xử lý nền', value: w.silent_minutes != null ? `Im ${fmtInt(w.silent_minutes)} phút` : 'Đang im — chưa thấy chạy lại', tone: 'bad' }
        : { key: 'worker', label: 'Bộ xử lý nền', value: 'Chưa có tín hiệu', tone: 'warn' },
  );

  const b = h.browser;
  rows.push(
    b.state === 'ok'
      ? { key: 'browser', label: 'Trình duyệt nền', value: b.last_heartbeat_at ? `Đang chạy · lần cuối ${fmtAgo(b.last_heartbeat_at, now, tz)}` : 'Đang chạy', tone: 'ok' }
      : b.state === 'silent'
        ? { key: 'browser', label: 'Trình duyệt nền', value: b.last_heartbeat_at ? `Im từ ${fmtAgo(b.last_heartbeat_at, now, tz)}` : 'Đang im', tone: 'warn' }
        : { key: 'browser', label: 'Trình duyệt nền', value: 'Chưa bật', tone: 'muted' },
  );

  const dlq = h.queues.reduce((sum, q) => sum + (Number.isFinite(q.dlq) ? q.dlq : 0), 0);
  rows.push({ key: 'dlq', label: 'Hàng lỗi (DLQ)', value: dlq > 0 ? `${fmtInt(dlq)} việc lỗi chờ xem` : 'Không có', tone: dlq > 0 ? 'warn' : 'ok' });

  const bk = h.backup;
  rows.push(
    !bk.configured
      ? { key: 'backup', label: 'Sao lưu', value: 'Chưa cấu hình', tone: 'warn' }
      : bk.stale
        ? { key: 'backup', label: 'Sao lưu', value: 'Quá 36 giờ chưa sao lưu', tone: 'bad' }
        : bk.latest_at
          ? { key: 'backup', label: 'Sao lưu', value: `Bản mới nhất ${fmtAgo(bk.latest_at, now, tz)}`, tone: 'ok' }
          : { key: 'backup', label: 'Sao lưu', value: 'Chưa có bản nào', tone: 'warn' },
  );

  const u = h.update;
  rows.push(
    u.failed || u.state === 'failed'
      ? { key: 'update', label: 'Cập nhật', value: u.blocked_version ? `Lần cập nhật gần nhất lỗi (${u.blocked_version})` : 'Lần cập nhật gần nhất lỗi', tone: 'bad' }
      : u.state === 'stalled'
        ? { key: 'update', label: 'Cập nhật', value: 'Máy chủ chưa nhận yêu cầu cập nhật', tone: 'warn' }
        : u.state === 'requested' || u.state === 'running'
          ? { key: 'update', label: 'Cập nhật', value: 'Đang cập nhật', tone: 'muted' }
          : u.state === 'unknown'
            ? { key: 'update', label: 'Cập nhật', value: 'Chưa rõ', tone: 'muted' }
            : { key: 'update', label: 'Cập nhật', value: 'Bình thường', tone: 'ok' },
  );

  const d = h.disk;
  rows.push(
    d.state === 'low'
      ? { key: 'disk', label: 'Ổ đĩa', value: d.free_bytes != null ? `Sắp hết chỗ — còn ${fmtGb(d.free_bytes)}` : 'Sắp hết chỗ', tone: 'bad' }
      : d.state === 'ok' && d.free_bytes != null
        ? { key: 'disk', label: 'Ổ đĩa', value: `Còn ${fmtGb(d.free_bytes)} trống`, tone: 'ok' }
        : { key: 'disk', label: 'Ổ đĩa', value: 'Chưa đo', tone: 'muted' },
  );
  return rows;
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
