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
      /** Nguyên văn thông điệp genh (mã lỗi, lệnh, bản sao lưu) — hiện trong "Chi tiết kỹ thuật". */
      detail?: string;
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

/** Mã lỗi genh (GH-E9xx) cuối thông điệp hộp thư — genh ≥ v0.1.34 ghi "<việc> — <cách xử lý> (GH-E9xx)". */
export function updateErrorCode(message: string | null | undefined): string | null {
  const m = message?.match(/GH-E[0-9A-F]{3}/g);
  return m ? m[m.length - 1] : null;
}

/**
 * Lời dẫn thẻ "chưa thành công" theo mã lỗi genh — mỗi mã nghĩa khác nhau: chưa đụng gì (tải/sao lưu/ổ đĩa/cấu hình),
 * đã tự quay về bản cũ, bản mới đã chạy nhưng còn bước chép dữ liệu, hay quay về CŨNG thất bại (cần xử lý tay).
 * `rollbackFailed`: trường có cấu trúc từ api (run/update-blocked.json) — ưu tiên; dò chữ chỉ để đỡ genh cũ/nhánh
 * không ghi update-blocked. `canRequest=false` (máy chủ chưa nhận yêu cầu từ nút bấm): không có nút Thử lại — hướng
 * dẫn chạy lệnh bên dưới (thẻ hiện lệnh).
 */
function failedCopy(
  message: string | null,
  opts: { canRequest: boolean; rollbackFailed: boolean },
): { tone: 'warn' | 'bad'; kicker: string; body: string } {
  const code = updateErrorCode(message);
  const msg = message ?? '';
  const retry = opts.canRequest ? 'bấm Thử lại' : 'chạy lệnh bên dưới trên máy chủ';
  const Retry = retry.charAt(0).toUpperCase() + retry.slice(1);
  if (opts.rollbackFailed || /CŨNG THẤT BẠI|chưa trọn|can thiệp tay|xử lý tay/i.test(msg)) {
    return {
      tone: 'bad', kicker: 'Cần xử lý tay — tự quay về bản cũ chưa trọn',
      body: 'Hệ thống chưa tự đưa máy về trạng thái chạy ổn. Cần người quản trị máy chủ làm theo hướng dẫn trong Chi tiết kỹ thuật.',
    };
  }
  if (code === 'GH-E948') {
    return {
      tone: 'warn', kicker: 'Ổ đĩa máy chủ sắp đầy — chưa đụng gì, bản đang dùng vẫn chạy bình thường',
      body: `Cần giải phóng ổ đĩa trên máy chủ (ảnh Docker cũ, tệp lớn), rồi ${retry} — lịch đêm cũng sẽ tự thử lại.`,
    };
  }
  if (code === 'GH-E941' || code === 'GH-E940') {
    return {
      tone: 'warn', kicker: 'Chưa đụng gì — bản đang dùng vẫn chạy bình thường',
      body: code === 'GH-E941'
        ? `Chưa tải được bản mới (thường do mạng). Lịch đêm sẽ tự thử lại, hoặc ${retry}.`
        : `Chưa sao lưu được trước khi cập nhật nên hệ thống dừng lại. ${Retry}; nếu vẫn lỗi, chạy genh doctor trên máy chủ.`,
    };
  }
  if (code === 'GH-E900' || code === 'GH-E901') {
    return {
      tone: 'warn', kicker: 'Chưa đụng gì — bản đang dùng vẫn chạy bình thường',
      body: 'genh trên máy chủ chưa đọc được cấu hình cài đặt nên dừng lại trước khi làm gì. Chạy genh doctor trên máy chủ và xem Chi tiết kỹ thuật.',
    };
  }
  if (code === 'GH-E946' && /Cập nhật xong/i.test(msg)) {
    return {
      tone: 'warn', kicker: 'Bản mới đã chạy — còn bước chép dữ liệu cũ chưa xong',
      body: 'Dịch vụ đã lên bản mới, nhưng chép dữ liệu tệp cũ sang chỗ lưu mới chưa xong. Dữ liệu gốc vẫn còn trên máy chủ — làm theo Chi tiết kỹ thuật để chép nốt.',
    };
  }
  const rolledBack = /đã tự quay về/i.test(msg);
  if (code === 'GH-E94B') {
    // v0.1.37: genh nhận tín hiệu dừng (SIGINT/SIGTERM — máy tắt, bị kill) giữa chừng — không phải bản mới hỏng. Lịch
    // đêm CHỈ tự thử lại khi đã dừng gọn (chưa đụng gì / đã tự quay về); quay về chưa trọn thì genh chặn lịch đêm
    // (update-blocked.json) — không hứa tự thử lại (nhánh đó thường đã rơi vào "Cần xử lý tay" ở trên).
    if (rolledBack) {
      return {
        tone: 'warn', kicker: 'Cập nhật bị dừng giữa chừng',
        body: `Hệ thống đã tự quay về bản đang dùng, dữ liệu giữ nguyên. Đây không phải lỗi của bản mới — ${retry} để chạy lại từ đầu, hoặc đợi lịch đêm tự thử lại.`,
      };
    }
    if (/chưa đụng gì/i.test(msg)) {
      return {
        tone: 'warn', kicker: 'Cập nhật bị dừng giữa chừng — chưa đụng gì, bản đang dùng vẫn chạy bình thường',
        body: `Đây không phải lỗi của bản mới — ${retry} để chạy lại, hoặc đợi lịch đêm tự thử lại.`,
      };
    }
    return {
      tone: 'warn', kicker: 'Cập nhật bị dừng giữa chừng',
      body: `Đây không phải lỗi của bản mới. Xem Chi tiết kỹ thuật (hoặc logs/auto-update.log trên máy chủ) để biết máy đang ở bản nào, rồi ${retry}.`,
    };
  }
  if (code === 'GH-E94A') {
    return {
      tone: 'warn', kicker: 'Đang có một lần cập nhật/khôi phục khác chạy — chờ xong rồi thử lại',
      body: `Chưa đụng gì — bản đang dùng vẫn chạy bình thường. Đợi lần đang chạy xong (vài phút), rồi ${retry}.`,
    };
  }
  if ((code === 'GH-E945' || code === 'GH-E949') && rolledBack) {
    return {
      tone: 'bad', kicker: 'Hệ thống đã tự quay về bản đang dùng — dữ liệu giữ nguyên',
      body: `Bản mới lỗi khi khởi động nên lịch đêm sẽ không tự cài lại bản này. ${Retry} nếu muốn thử ngay, hoặc đợi bản mới hơn.`,
    };
  }
  if ((code === 'GH-E946' || code === 'GH-E947') && rolledBack) {
    return {
      tone: 'bad', kicker: 'Hệ thống đã tự quay về bản đang dùng — dữ liệu giữ nguyên',
      body: `${Retry}, hoặc xem logs/auto-update.log trên máy chủ.`,
    };
  }
  if (code === null) {
    // genh cũ (≤ v0.1.33, không có mã) luôn tự quay về khi lỗi — giữ lời dẫn như trước; thân thẻ là thông điệp genh.
    return { tone: 'bad', kicker: 'Hệ thống đã tự quay về bản đang dùng — dữ liệu giữ nguyên', body: msg };
  }
  return {
    tone: 'warn', kicker: 'Cập nhật chưa xong — xem Chi tiết kỹ thuật',
    body: `Xem Chi tiết kỹ thuật (hoặc logs/auto-update.log trên máy chủ) để biết máy đang ở bản nào, rồi ${retry}.`,
  };
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
    // v0.1.37: máy chủ đang chạy một lần cập nhật/khôi phục khác (vd lịch đêm) — yêu cầu xếp hàng, làm ngay sau đó.
    const kicker = d.host_busy
      ? 'Máy chủ đang chạy một lần cập nhật/khôi phục khác — sẽ làm yêu cầu này ngay khi lần đó xong'
      : 'Đã gửi yêu cầu, máy chủ sẽ bắt đầu trong vòng 1 phút';
    return { kind: 'working', tone: 'accent', title: `Đang cập nhật lên ${target}`, kicker, steps: steps(0) };
  }
  if (d.state === 'running') {
    return { kind: 'working', tone: 'accent', title: `Đang cập nhật lên ${target}`, kicker: 'Mất khoảng 2–5 phút — trang tự tải lại khi xong', steps: steps(1) };
  }
  if (d.state === 'stalled' && d.stalled_reason === 'process_gone') {
    // v0.1.37 (F-34): 'running' mà tiến trình genh trên máy chủ không còn (máy tắt/khởi động lại, bị dừng).
    return {
      kind: 'stalled', tone: 'warn', title: `Cập nhật lên ${target} bị dừng giữa chừng`,
      kicker: 'Tiến trình cập nhật trên máy chủ không còn chạy — có thể máy vừa tắt hoặc khởi động lại',
      body: `${d.can_request ? 'Bấm Thử lại' : 'Chạy lệnh dưới đây trên máy chủ'} để chạy lại từ đầu (hệ thống tự sao lưu trước khi làm). Lỗi lặp lại thì xem logs/auto-update.log trên máy chủ.`,
      showCommand: !d.can_request, steps: [],
    };
  }
  if (d.state === 'stalled') {
    return {
      kind: 'stalled', tone: 'warn', title: 'Máy chủ chưa nhận yêu cầu cập nhật',
      kicker: 'Đã quá 15 phút mà chưa bắt đầu — có thể máy chủ đang tắt tiến trình nhận yêu cầu',
      body: 'Bấm Thử lại, hoặc chạy lệnh dưới đây trên máy chủ.', showCommand: true, steps: [],
    };
  }
  if (d.state === 'failed' && recent(d.finished_at, now)) {
    // Tiêu đề theo bản ĐÃ THỬ (`to` genh ghi), không theo bản mới nhất — v0.1.35 ra rồi thì lỗi đêm qua vẫn là của v0.1.34.
    const tried = d.to && d.to !== d.current ? d.to : target;
    const rollbackFailed = d.blocked_rollback_failed === true && !!d.blocked_version && d.blocked_version === tried;
    const copy = failedCopy(d.message, { canRequest: d.can_request, rollbackFailed });
    const coded = updateErrorCode(d.message) !== null;
    return {
      kind: 'failed', tone: copy.tone, title: `Cập nhật lên ${tried} chưa thành công`, kicker: copy.kicker,
      // genh cũ (không có mã): thông điệp đã là câu thân thiện — hiện thẳng như trước.
      body: coded ? copy.body : (d.message ?? 'Xem chi tiết trong logs/auto-update.log trên máy chủ.'),
      detail: coded ? (d.message ?? undefined) : undefined,
      // Không có nút Thử lại (máy chủ chưa nhận yêu cầu từ nút bấm) → hiện lệnh chạy tay như thẻ "Có bản mới".
      showCommand: !d.can_request,
      steps: [],
    };
  }
  if (opts.waitingFor && !d.update_available && (d.state === 'done' || d.state === 'idle')) {
    return { kind: 'finished', tone: 'ok', title: `Đã cập nhật lên ${d.current ?? target}`, kicker: 'Đang tải lại trang để dùng bản mới…', steps: [] };
  }
  if (d.update_available) {
    // Lịch đêm đợi bản ra đủ 24 giờ: nói rõ khi nào tự cài, kẻo Owner thấy "Có bản mới" tới 2 đêm mà không hiểu.
    // Chỉ nói khi genh báo lịch đêm đang BẬT (genh.json auto_update_enabled === true) — tắt/không rõ thì không hứa.
    // Bản mới nhất đã lỗi lần trước (genh ghi run/update-blocked.json): lịch đêm KHÔNG tự cài lại — không hứa "Tự cài".
    const blocked = !!d.blocked_version && d.blocked_version === d.latest;
    const hint = d.auto_update_enabled === true && !blocked ? autoInstallHint(d.published_at, now) : null;
    const action = d.can_request ? 'bấm Cập nhật ngay' : 'chạy lệnh bên dưới';
    return {
      kind: 'available', tone: 'accent', title: `Có bản mới ${d.latest}`,
      kicker: blocked
        ? `Đang dùng ${d.current} · bản này đã lỗi ở lần cập nhật trước nên lịch đêm không tự cài lại — ${action} để thử lại`
        : hint
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
