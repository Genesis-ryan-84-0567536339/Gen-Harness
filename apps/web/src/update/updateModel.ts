import type { SystemUpdate } from '@gen-harness/contracts';

export const UPDATE_COMMAND = '~/.gen-harness/bin/genh update';
export const UPDATE_KEY = ['system', 'update'] as const;

type StepState = 'done' | 'active' | 'todo';
export type UpdateView =
  | { kind: 'hidden' }
  | {
      kind: 'available' | 'working' | 'finished' | 'failed' | 'stalled';
      tone: 'accent' | 'ok' | 'warn' | 'bad';
      title: string;
      kicker: string;
      body?: string;
      showCommand?: boolean;
      steps: Array<{ label: string; state: StepState }>;
    };

const RECENT_MS = 24 * 3600 * 1000;
/** Thời gian chín của lịch tự cập nhật đêm (genh `selfupdate.NightlyMinAge`): chỉ cài bản đã là bản chính thức ≥ 24 giờ. */
export const NIGHTLY_MIN_AGE_MS = 24 * 3600 * 1000;

/** Giờ lịch đêm chạy (genh `internal/autoupdate`: ~03:00 giờ máy). */
export const NIGHTLY_HOUR = 3;

/**
 * v0.1.33: lịch đêm (~03:00) tự cài bản mới vào đêm nào — `published_at` là lúc bản đó thành bản chính thức
 * (gh/system_api/update.py official_since); cài ở lần ~03:00 đầu tiên sau khi bản đủ 24 giờ (và sau `now`). Tính theo
 * giờ trình duyệt, dạng "Tự cài đêm 30/09 (~03:00)" (ngày của chính mốc 03:00). null khi không biết lúc phát hành.
 */
export function autoInstallHint(publishedAt: string | null | undefined, now: number): string | null {
  if (!publishedAt) return null;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return null;
  const from = new Date(Math.max(t + NIGHTLY_MIN_AGE_MS, now));
  const run = new Date(from);
  run.setHours(NIGHTLY_HOUR, 0, 0, 0);
  if (run.getTime() < from.getTime()) run.setDate(run.getDate() + 1);
  const dd = String(run.getDate()).padStart(2, '0');
  const mm = String(run.getMonth() + 1).padStart(2, '0');
  return `Tự cài đêm ${dd}/${mm} (~03:00)`;
}

function recent(iso: string | null, now: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && now - t < RECENT_MS;
}

/**
 * Trạng thái thẻ cập nhật từ `GET /system/update` + việc Owner vừa bấm (waitingFor) + api đang tắt để khởi động lại
 * (offline). Hàm thuần để test đủ các nhánh.
 */
export function updateView(
  d: SystemUpdate | undefined,
  opts: { waitingFor: string | null; offline: boolean; now?: number },
): UpdateView {
  const now = opts.now ?? Date.now();
  const target = d?.latest ?? opts.waitingFor ?? 'bản mới';
  const steps = (active: number) =>
    ['Nhận yêu cầu', 'Sao lưu dữ liệu, tải bản mới', 'Khởi động lại & kiểm tra'].map((label, i) => ({
      label,
      state: (i < active ? 'done' : i === active ? 'active' : 'todo') as StepState,
    }));

  if (opts.offline) {
    return { kind: 'working', tone: 'accent', title: `Đang cập nhật lên ${opts.waitingFor}`, kicker: 'Hệ thống đang khởi động lại — trang tự tải lại khi xong', steps: steps(2) };
  }
  if (!d) return { kind: 'hidden' };
  if (d.state === 'requested') {
    return { kind: 'working', tone: 'accent', title: `Đang cập nhật lên ${target}`, kicker: 'Đã gửi yêu cầu, máy chủ sẽ bắt đầu trong vòng 1 phút', steps: steps(0) };
  }
  if (d.state === 'running') {
    return { kind: 'working', tone: 'accent', title: `Đang cập nhật lên ${target}`, kicker: 'Mất khoảng 2–5 phút — trang tự tải lại khi xong', steps: steps(1) };
  }
  if (d.state === 'stalled') {
    return {
      kind: 'stalled', tone: 'warn', title: 'Máy chủ chưa nhận yêu cầu cập nhật',
      kicker: 'Đã quá 15 phút mà chưa bắt đầu — có thể máy chủ đang tắt tiến trình nhận yêu cầu',
      body: 'Bấm Thử lại, hoặc chạy lệnh dưới đây trên máy chủ.', showCommand: true, steps: [],
    };
  }
  if (d.state === 'failed' && recent(d.finished_at, now)) {
    return {
      kind: 'failed', tone: 'bad', title: `Cập nhật lên ${target} chưa thành công`,
      kicker: 'Hệ thống đã tự quay về bản đang dùng — dữ liệu giữ nguyên',
      body: d.message ?? 'Xem chi tiết trong logs/auto-update.log trên máy chủ.', steps: [],
    };
  }
  if (opts.waitingFor && !d.update_available && (d.state === 'done' || d.state === 'idle')) {
    return { kind: 'finished', tone: 'ok', title: `Đã cập nhật lên ${d.current ?? target}`, kicker: 'Đang tải lại trang để dùng bản mới…', steps: [] };
  }
  if (d.update_available) {
    // Lịch đêm đợi bản ra đủ 24 giờ: nói rõ khi nào tự cài, kẻo Owner thấy "Có bản mới" tới 2 đêm mà không hiểu.
    // Chỉ nói khi genh báo lịch đêm đang BẬT (genh.json auto_update_enabled === true) — tắt/không rõ thì không hứa.
    const hint = d.auto_update_enabled === true ? autoInstallHint(d.published_at, now) : null;
    const action = d.can_request ? 'bấm Cập nhật ngay' : 'chạy lệnh bên dưới';
    return {
      kind: 'available', tone: 'accent', title: `Có bản mới ${d.latest}`,
      kicker: hint
        ? `Đang dùng ${d.current} · ${hint} — hoặc ${action}`
        : `Đang dùng ${d.current} · ${action} (mất khoảng 2–5 phút, tự sao lưu trước)`,
      body: d.can_request ? undefined : 'Máy chủ chưa bật cập nhật bằng nút bấm.',
      showCommand: !d.can_request, steps: [],
    };
  }
  return { kind: 'hidden' };
}

/**
 * v0.1.28 (UX V11): ghi chú phát hành lấy từ GitHub có phần tự sinh bằng tiếng Anh ("What's Changed", "Full
 * Changelog", "by @x in https://…/pull/12") — bỏ phần đó, giữ phần mô tả; dịch tiêu đề thường gặp.
 */
export function readableNotes(md: string | null | undefined): string {
  if (!md) return '';
  const out: string[] = [];
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    if (/full changelog/i.test(raw) || /^#+\s*new contributors/i.test(raw) || /made their first contribution/i.test(raw)) continue;
    // Chú thích HTML (vd dấu `<!-- genh:promoted_at=… -->` của job promote) — GitHub không hiện, Console cũng không.
    if (/^\s*<!--.*-->\s*$/.test(raw)) continue;
    const l = raw
      .replace(/^(#+)\s*what'?s changed\s*$/i, '$1 Điểm mới')
      .replace(/\s+by @[\w-]+(\[bot\])?\s+in\s+https?:\/\/\S+/gi, '')
      .replace(/\s*\(#\d+\)\s*$/, '')
      .replace(/https?:\/\/github\.com\/\S+/gi, '')
      .trimEnd();
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Khoá sessionStorage: bản vừa cập nhật lên — sau khi trang tự tải lại thì báo "Đã cập nhật lên vX" một lần. */
export const UPDATED_FLAG = 'gh_updated_to';
