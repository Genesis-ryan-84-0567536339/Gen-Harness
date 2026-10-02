import type { SocialAccount, SocialLiveInput } from '@gen-harness/contracts';
import type { Tone } from '@gen-harness/ui';

/** Khoá bộ đệm dùng chung — sự kiện WS `social.update` làm mới cả nhóm. */
export const SOCIAL_KEY = ['social'] as const;
export const qkSocial = {
  status: ['social', 'status'] as const,
  platforms: ['social', 'platforms'] as const,
  accounts: ['social', 'accounts'] as const,
  latest: (id: string) => ['social', 'latest', id] as const,
};

export interface StatusView {
  label: string;
  tone: Tone;
  hint: string;
}

/** Trạng thái tài khoản → nhãn tiếng Việt + việc Owner cần làm (một nguồn cho thẻ, test, e2e). */
/**
 * Nhãn nút đăng nhập (review F-17): tài khoản `needs_login` (phiên không mở được sau chuyển máy/đổi khoá ⇒ máy chủ xoá
 * phiên, `has_session=false`) vẫn là "Đăng nhập lại" — khớp gợi ý ở dòng trạng thái, chuông và hướng dẫn.
 */
export function loginLabel(a: Pick<SocialAccount, 'status' | 'has_session'>): 'Đăng nhập lại' | 'Đăng nhập' {
  return a.has_session || a.status === 'needs_login' ? 'Đăng nhập lại' : 'Đăng nhập';
}

export function accountStatus(a: Pick<SocialAccount, 'status' | 'pause_reason' | 'active_job'>): StatusView {
  if (a.active_job) {
    const what = a.active_job.kind === 'login' ? 'Đang mở cửa sổ đăng nhập' : a.active_job.kind === 'read' ? 'Đang đọc' : 'Đang kiểm phiên';
    return { label: what, tone: 'accent', hint: 'Mỗi tài khoản chỉ chạy một việc một lúc.' };
  }
  switch (a.status) {
    case 'active':
      return { label: 'Đang kết nối', tone: 'ok', hint: 'Gen đọc được khi Sếp hỏi hoặc theo lịch.' };
    case 'pending_login':
      return { label: 'Chưa đăng nhập', tone: 'neutral', hint: 'Bấm Đăng nhập — Sếp tự đăng nhập trong cửa sổ trình duyệt.' };
    case 'needs_login':
      // F-17 (v0.1.38): phiên đã lưu không mở được sau khi chuyển máy/đổi khoá.
      if (a.pause_reason === 'key_changed') {
        return {
          label: 'Cần đăng nhập lại',
          tone: 'warn',
          hint: 'Phiên đã lưu không mở được trên máy này (chuyển máy hoặc đổi khoá) — bấm Đăng nhập lại.',
        };
      }
      return { label: 'Cần đăng nhập lại', tone: 'warn', hint: 'Phiên đã hết hoặc bị đăng xuất — bấm Đăng nhập lại.' };
    case 'paused':
      return a.pause_reason === 'checkpoint' || a.pause_reason === 'captcha'
        ? {
            label: a.pause_reason === 'captcha' ? 'Dừng: CAPTCHA' : 'Dừng: cần xác minh',
            tone: 'bad',
            hint: 'Nền tảng đòi xác minh. Hệ thống không tự giải — bấm Đăng nhập lại để Sếp tự xử lý, rồi Tiếp tục.',
          }
        : a.pause_reason === 'errors'
          ? { label: 'Tạm dừng (lỗi)', tone: 'warn', hint: '3 lần lỗi liên tiếp — kiểm tra rồi bấm Tiếp tục.' }
          : { label: 'Tạm dừng', tone: 'neutral', hint: 'Sếp đã tạm dừng — bấm Tiếp tục khi muốn dùng lại.' };
    default:
      return { label: 'Đã gỡ', tone: 'neutral', hint: '' };
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "08:00, 17:00" → ['08:00','17:00']; lỗi → thông báo tiếng Việt (khớp kiểm của API). */
export function parseTimes(text: string): { times: string[]; error: string | null } {
  const parts = text
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (/^\d:\d\d$/.test(t) ? `0${t}` : t));
  if (parts.length > 4) return { times: [], error: 'Tối đa 4 mốc giờ mỗi ngày' };
  for (const t of parts) {
    if (!TIME_RE.test(t)) return { times: [], error: `"${t}" chưa đúng dạng HH:MM (vd 08:00)` };
    const h = Number(t.slice(0, 2));
    if (h >= 23 || h < 6) return { times: [], error: 'Không đặt lịch trong giờ nghỉ 23:00–06:00' };
  }
  return { times: [...new Set(parts)].sort(), error: null };
}

/** Phím đặc biệt gửi tới trình duyệt từ xa (máy chủ lọc lại theo đúng danh sách này). */
const SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End',
  'PageUp', 'PageDown',
]);

/** Sự kiện bàn phím của trình duyệt → sự kiện gửi đi (null = bỏ qua, vd phím tắt của chính trình duyệt Sếp). */
export function keyToInput(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): SocialLiveInput | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === ' ') return { type: 'text', text: ' ' };
  if (SPECIAL_KEYS.has(e.key)) return { type: 'key', action: 'press', key: e.key };
  if ([...e.key].length === 1) return { type: 'text', text: e.key };
  return null;
}

/** Toạ độ con trỏ trên khung hiển thị → toạ độ trang từ xa (khung hình có thể bị thu nhỏ). */
export function mapPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  remote: { w: number; h: number },
): { x: number; y: number } {
  const x = Math.round(((clientX - rect.left) / Math.max(1, rect.width)) * remote.w);
  const y = Math.round(((clientY - rect.top) / Math.max(1, rect.height)) * remote.h);
  return { x: Math.max(0, Math.min(remote.w, x)), y: Math.max(0, Math.min(remote.h, y)) };
}

export function liveUrl(ticket: string, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/v1/social/login/${encodeURIComponent(ticket)}`;
}
