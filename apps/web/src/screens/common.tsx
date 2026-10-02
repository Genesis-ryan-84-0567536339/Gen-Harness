import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ErrorState, Icon, Skeleton, cx } from '@gen-harness/ui';
import { errorDetail, errorReasons, errorText, isAgyOnlyUnavailable, isModelUnavailable } from '../lib/errorText';
import { AGY_ONLY_TEXT, MODEL_UNAVAILABLE_TEXT, agyOnlyReasons, friendlyError, isAgyOnlyText } from '../lib/friendlyError';

/** Mô tả chung: thao tác nhà cung cấp AI nào cần phiên PIN `ai.route_change` (v0.1.35, F-20). */
export const PIN_ROUTE_CHANGE_TITLE = 'cần mã PIN 6 số (bật/tắt, thêm/sửa nhà cung cấp AI, khoá API, chuỗi ưu tiên)';

/** v0.1.35 (F-20): thêm / sửa / bật-tắt nhà cung cấp AI, khoá API, chuỗi ưu tiên cần phiên PIN `ai.route_change`
 * — hộp PIN tự mở khi máy chủ trả 423 (lib/api.ts + PinDialogHost); ở đây chỉ báo trước. Dùng chung cho Agent & Model
 * thẻ Jev (Điều khiển hệ thống) và Hướng dẫn bước 4 — một nguồn chữ duy nhất. */
export function PinHint() {
  return (
    <span className="muted-note" title="Thêm / sửa nhà cung cấp AI, khoá API, chuỗi ưu tiên cần mã PIN">
      <Icon name="ph ph-lock-simple" size={11} /> Cần mã PIN 6 số
    </span>
  );
}

/**
 * Screen-title row (docs/01 "Quy ước chung"): text block left, controls
 * right, bottom-aligned. With controls the block is `flex: 1 1 320px`; alone
 * it only gets its max-width (no flex-basis, so it is not stretched).
 */
export function ScreenHead({
  title,
  description,
  maxWidth,
  actions,
}: {
  title: string;
  description: string;
  maxWidth: number;
  actions?: ReactNode;
}) {
  if (!actions) {
    return (
      <div className="screen-head-solo" style={{ maxWidth }}>
        <h2 className="screen-title">{title}</h2>
        <p className="screen-desc">{description}</p>
      </div>
    );
  }
  return (
    <div className="screen-title-row">
      <div className="screen-head-block" style={{ maxWidth }}>
        <h2 className="screen-title">{title}</h2>
        <p className="screen-desc">{description}</p>
      </div>
      <div className="screen-head-actions">{actions}</div>
    </div>
  );
}

/** Surface card with the standard header; `bodyClass` sets the body padding of each design card. */
export function Panel({
  title,
  kicker,
  aside,
  bodyClass,
  className,
  style,
  children,
  label,
  genTarget,
}: {
  title: ReactNode;
  kicker?: ReactNode;
  aside?: ReactNode;
  bodyClass?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  label?: string;
  /** Gen v1: `data-gen-target` (id trong packages/contracts/src/genTargets.ts). */
  genTarget?: string;
}) {
  return (
    <section className={cx('gh-card', className)} style={style} aria-label={label} data-gen-target={genTarget}>
      <div className="gh-card__header">
        <div style={{ minWidth: 0 }}>
          <div className="gh-card__title">{title}</div>
          {kicker !== undefined ? <div className="gh-card__kicker">{kicker}</div> : null}
        </div>
        {aside}
      </div>
      {bodyClass !== undefined ? <div className={bodyClass}>{children}</div> : children}
    </section>
  );
}

/** Outline chip `font-size:10.5px; padding:2px 8px; radius 999` (design stateStyle). */
export function StateChip({
  color,
  border,
  children,
  size = 'sm',
  dot,
  className,
}: {
  color: string;
  border?: string;
  children: ReactNode;
  size?: 'sm' | 'md';
  dot?: boolean;
  className?: string;
}) {
  return (
    <span className={cx('state-chip', size === 'md' && 'state-chip--md', className)} style={{ color, borderColor: border ?? color }}>
      {dot ? <span className="state-chip__dot" style={{ background: color }} aria-hidden /> : null}
      {children}
    </span>
  );
}

/** Progress bar: track in divider, fill in `tone` at .85 opacity. */
export function Bar({ pct, tone, height = 5, width, className }: { pct: number; tone: string; height?: 4 | 5; width?: number; className?: string }) {
  return (
    <span className={cx('gh-bar', height === 4 && 'gh-bar--4', className)} style={width ? { width, flex: 'none' } : undefined} aria-hidden>
      <span style={{ width: `${Math.max(0, Math.min(100, pct))}%`, ['--bar-tone' as string]: tone } as CSSProperties} />
    </span>
  );
}

export function SkeletonLines({ rows = 4, padding = '14px 16px', gap = 12 }: { rows?: number; padding?: string; gap?: number }) {
  return (
    <div style={{ padding, display: 'flex', flexDirection: 'column', gap }} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Skeleton width={`${55 + ((i * 17) % 35)}%`} height={10} />
          <Skeleton width="100%" height={5} />
        </div>
      ))}
    </div>
  );
}

export function CardError({ error, onRetry, retrying }: { error: unknown; onRetry?: () => void; retrying?: boolean }) {
  if (isAgyOnlyUnavailable(error)) return <ModelUnavailableNotice reasons={errorReasons(error)} message={errorText(error)} agyOnly />;
  if (isModelUnavailable(error)) return <ModelUnavailableNotice reasons={errorReasons(error)} />;
  return <ErrorState message={errorText(error)} detail={errorDetail(error)} onRetry={onRetry} retrying={retrying} />;
}

/**
 * v0.1.30: "chưa có model AI hoạt động" — trạng thái tại chỗ có nút "Chọn model" (→ /guide/4, bước chọn model),
 * lý do kỹ thuật từng nhà cung cấp ẩn trong "Chi tiết kỹ thuật". Dùng thay cho việc vẽ lỗi thô.
 */
export function ModelUnavailableNotice({
  reasons,
  message,
  className,
  agyOnly,
}: {
  reasons?: string | string[] | null;
  message?: string;
  className?: string;
  /** v0.1.38 (F-22): chuỗi chỉ có Antigravity CLI — nút dẫn tới Agent & Model (/api), không về bước 4 (agy hiện "sẵn sàng"). */
  agyOnly?: boolean;
}) {
  const tech = Array.isArray(reasons) ? reasons.filter(Boolean).join('; ') : reasons;
  const agy = agyOnly ?? (isAgyOnlyText(message) || agyOnlyReasons(Array.isArray(reasons) ? reasons : reasons ? [reasons] : null));
  return (
    <div className={cx('model-down', className)} role="status" data-testid="model-unavailable">
      <Icon name="ph ph-warning-circle" size={16} />
      <div className="model-down__body">
        <div className="model-down__msg">{message || (agy ? AGY_ONLY_TEXT : MODEL_UNAVAILABLE_TEXT)}</div>
        {tech ? (
          <details className="tech-detail">
            <summary>Chi tiết kỹ thuật</summary>
            <code>{tech}</code>
          </details>
        ) : null}
      </div>
      {agy ? (
        <Link to="/api" className="gh-btn gh-btn--secondary gh-btn--sm model-down__cta">
          <Icon name="ph ph-plugs" size={14} /> Thêm nguồn AI
        </Link>
      ) : (
        <Link to="/guide/4" className="gh-btn gh-btn--secondary gh-btn--sm model-down__cta">
          <Icon name="ph ph-plugs" size={14} /> Chọn model
        </Link>
      )}
    </div>
  );
}

/**
 * v0.1.38 (F-22): lỗi của một thao tác AI (dịch, tạo lại bản nháp…): không có model chạy được ⇒ thẻ "Chọn model"/"Thêm
 * nguồn AI" kèm "Chi tiết kỹ thuật"; lỗi khác ⇒ dòng InlineError.
 */
export function ActionError({ error }: { error: unknown }) {
  if (isAgyOnlyUnavailable(error)) return <ModelUnavailableNotice reasons={errorReasons(error)} message={errorText(error)} agyOnly />;
  if (isModelUnavailable(error)) return <ModelUnavailableNotice reasons={errorReasons(error)} />;
  return <InlineError>{errorText(error)}</InlineError>;
}

/** Inline form/action error line (11px BAD). */
export function InlineError({ children, detail }: { children?: ReactNode; detail?: string | null }) {
  return (
    <div className="inline-error" role="alert" aria-live="assertive">
      {children}
      {typeof detail === 'string' && detail ? (
        <details className="tech-detail">
          <summary>Chi tiết kỹ thuật</summary>
          <code>{detail}</code>
        </details>
      ) : null}
    </div>
  );
}

/**
 * v0.1.28 (UX N2): lỗi từ máy chủ/nhà cung cấp viết lại bằng câu dễ hiểu; chuỗi gốc nằm trong "Chi tiết kỹ thuật"
 * (đóng sẵn) cho người hỗ trợ.
 */
export function FriendlyErrorText({ raw, fallback, prefix, className }: { raw: unknown; fallback?: string; prefix?: string; className?: string }) {
  const f = friendlyError(raw, fallback);
  return (
    <span className={cx('friendly-error', className)}>
      {prefix ?? ''}
      {f.message}
      {f.detail ? (
        <details className="tech-detail">
          <summary>Chi tiết kỹ thuật</summary>
          <code>{f.detail}</code>
        </details>
      ) : null}
    </span>
  );
}
