/**
 * v0.1.55 (G5) — mảnh dùng chung của 5 màn Mặt tiền: trạng thái tải (Skeleton), rỗng (EmptyState chữ đời thường), lỗi
 * (ErrorState: câu thân thiện + "Chi tiết kỹ thuật" — không bao giờ render object) và dòng danh sách bấm được.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, Icon, Skeleton, cx } from '@gen-harness/ui';
import { CardError } from '../screens/common';
import { asText, avatarText, safeLink } from './ownerModel';

/** Khung chờ cùng hình với danh sách thật: `rows` dòng (ô tròn + hai dòng chữ). */
export function ListSkeleton({ rows = 4, label = 'Đang tải' }: { rows?: number; label?: string }) {
  return (
    <div className="owner-skel" aria-busy="true" aria-label={label} data-testid="owner-loading">
      {Array.from({ length: rows }, (_, i) => (
        <div className="owner-skel__row" key={i}>
          <Skeleton width={34} height={34} radius="50%" />
          <div className="owner-skel__text">
            <Skeleton width={`${55 + ((i * 17) % 35)}%`} height={11} />
            <Skeleton width={`${30 + ((i * 13) % 30)}%`} height={9} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Lỗi tải: câu thân thiện + "Chi tiết kỹ thuật" (mã HTTP/mã lỗi, chuỗi) + nút Thử lại. */
export function OwnerError({ error, onRetry, retrying }: { error: unknown; onRetry?: () => void; retrying?: boolean }) {
  return (
    <div className="owner-error" data-testid="owner-error">
      <CardError error={error} onRetry={onRetry} retrying={retrying} />
    </div>
  );
}

export function OwnerEmpty({ icon, title, hint, actions }: { icon: string; title: string; hint?: string; actions?: ReactNode }) {
  return (
    <div className="owner-empty" data-testid="owner-empty">
      <EmptyState icon={icon} title={title} description={hint} actions={actions} />
    </div>
  );
}

/** Một dòng danh sách là một liên kết (cả dòng bấm được). `to` đi qua `safeLink` — máy chủ lạ trả link ngoài thì về Hôm nay. */
export function RowLink({
  to,
  title,
  meta,
  right,
  lead,
  tone,
  testId,
}: {
  to: unknown;
  title: unknown;
  meta?: unknown;
  right?: unknown;
  lead?: ReactNode;
  tone?: 'accent' | 'warn' | 'bad' | 'ok';
  testId?: string;
}) {
  const metaText = asText(meta);
  const rightText = asText(right);
  return (
    <Link to={safeLink(to)} className={cx('owner-row', tone && `owner-row--${tone}`)} data-testid={testId}>
      {lead ?? null}
      <span className="owner-row__body">
        <span className="owner-row__title">{asText(title)}</span>
        {metaText ? <span className="owner-row__meta">{metaText}</span> : null}
      </span>
      {rightText ? <span className="owner-row__right">{rightText}</span> : null}
      <Icon className="owner-row__go" name="ph ph-caret-right" size={14} />
    </Link>
  );
}

export function IconTile({ icon, tone }: { icon: string; tone?: 'accent' | 'warn' | 'bad' | 'ok' }) {
  return (
    <span className={cx('owner-tile', tone && `owner-tile--${tone}`)} aria-hidden>
      <Icon name={icon} size={16} />
    </span>
  );
}

export function Avatar({ name }: { name: unknown }) {
  return (
    <span className="owner-avatar" aria-hidden>
      {avatarText(name)}
    </span>
  );
}
