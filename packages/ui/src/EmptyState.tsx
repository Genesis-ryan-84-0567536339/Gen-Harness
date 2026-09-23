import type { ReactNode } from 'react';
import { Icon } from './Icon';

export interface EmptyStateProps {
  icon?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function EmptyState({ icon = 'ph ph-hourglass-medium', title, description, actions }: EmptyStateProps) {
  return (
    <div className="gh-state gh-state--empty">
      <div className="gh-state__tile">
        <Icon name={icon} size={17} />
      </div>
      <div className="gh-state__text">
        <div className="gh-state__title">{title}</div>
        {description ? <div className="gh-state__desc">{description}</div> : null}
        {actions ? <div className="gh-state__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
