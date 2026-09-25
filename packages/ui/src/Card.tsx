import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  /** 10px uppercase sublabel under the title. */
  kicker?: ReactNode;
  /** Right side of the header (buttons, chips). */
  actions?: ReactNode;
  /** Wrap children in the default 15px 16px body padding (default true). */
  padded?: boolean;
  as?: 'section' | 'div' | 'article';
}

/** Surface card: header 12px 16px (title 13px/600 + kicker), divider under it. */
export function Card({ title, kicker, actions, padded = true, as: Tag = 'section', className, children, ...rest }: CardProps) {
  return (
    <Tag className={cx('gh-card', className)} {...rest}>
      {title !== undefined || actions ? (
        <div className="gh-card__header">
          <div style={{ minWidth: 0 }}>
            {title !== undefined ? <div className="gh-card__title">{title}</div> : null}
            {kicker !== undefined ? <div className="gh-card__kicker">{kicker}</div> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {padded ? <div className="gh-card__body">{children}</div> : children}
    </Tag>
  );
}
