import type { CSSProperties, ReactNode } from 'react';
import { ErrorState, Skeleton, cx } from '@gen-harness/ui';
import { errorText } from '../lib/errorText';

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
}: {
  title: ReactNode;
  kicker?: ReactNode;
  aside?: ReactNode;
  bodyClass?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  label?: string;
}) {
  return (
    <section className={cx('gh-card', className)} style={style} aria-label={label}>
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
  return <ErrorState message={errorText(error)} onRetry={onRetry} retrying={retrying} />;
}

/** Inline form/action error line (11px BAD). */
export function InlineError({ children }: { children?: ReactNode }) {
  return (
    <div className="inline-error" role="alert" aria-live="assertive">
      {children}
    </div>
  );
}
