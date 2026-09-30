import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { NotificationItem, NotificationsPage } from '@gen-harness/contracts';
import { Icon, Skeleton, Tooltip } from '@gen-harness/ui';
import { api } from '../lib/api';
import { errorText } from '../lib/errorText';
import { fmtAgo } from '../lib/format';
import { qk, useNotifications } from '../lib/queries';
import { toast } from '../lib/toast';
import { useNow } from '../lib/useNow';
import { badgeText } from './headerModel';

const KIND_ICON: Record<string, string> = {
  'user.role_changed': 'ph ph-user-switch',
  'user.password_reset': 'ph ph-key',
  'user.reactivated': 'ph ph-lock-open',
  'backup.done': 'ph ph-database',
  'backup.failed': 'ph ph-warning-circle',
  'task.reminder': 'ph ph-alarm',
  'hub.token_expiring': 'ph ph-key',
  'social.read': 'ph ph-facebook-logo',
  'social.paused': 'ph ph-shield-warning',
};

/**
 * v0.1.23 (Đợt B6) — chuông thông báo ở header: số chưa đọc, danh sách 20 thông báo gần nhất của CHÍNH người đang
 * đăng nhập, cập nhật ngay qua WebSocket (`notification.new`). Bấm một thông báo → đánh dấu đã đọc + mở trang liên quan.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const q = useNotifications();
  const unread = q.data?.unread ?? 0;
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // Esc đóng cả khi tiêu điểm đã rời bảng (vd nút vừa bị vô hiệu sau "Đánh dấu đã đọc hết").
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = unread ? `Thông báo — ${unread} chưa đọc` : 'Thông báo';
  return (
    <div className="hd-bell-wrap" ref={wrap}>
      <Tooltip content={label} disabled={open}>
        <button
          ref={trigger}
          type="button"
          className="gh-btn gh-btn--secondary gh-btn--icon hd-bell"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name={unread ? 'ph ph-bell-ringing' : 'ph ph-bell'} size={15} />
          {unread ? (
            <span className="hd-bell__badge" aria-hidden>
              {badgeText(unread)}
            </span>
          ) : null}
        </button>
      </Tooltip>
      {open ? (
        <NotificationPanel
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) trigger.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function NotificationPanel({ onClose }: { onClose: (refocus: boolean) => void }) {
  const q = useNotifications();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const now = useNow(30_000);
  const panel = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  const markRead = async (ids?: string[]) => {
    const prev = qc.getQueryData<NotificationsPage>(qk.notifications);
    if (prev) {
      const hit = (n: NotificationItem) => !ids || ids.includes(n.id);
      const items = prev.items.map((n) => (hit(n) ? { ...n, read: true } : n));
      const cleared = prev.items.filter((n) => hit(n) && !n.read).length;
      qc.setQueryData<NotificationsPage>(qk.notifications, { items, unread: Math.max(0, prev.unread - (ids ? cleared : prev.unread)) });
    }
    try {
      const r = await api.notifications.markRead(ids);
      qc.setQueryData<NotificationsPage>(qk.notifications, (old) => (old ? { ...old, unread: r.unread } : old));
    } catch (e) {
      if (prev) qc.setQueryData(qk.notifications, prev);
      toast(errorText(e), 'bad');
    }
  };

  const openItem = (n: NotificationItem) => {
    if (!n.read) void markRead([n.id]);
    if (n.link) {
      onClose(false);
      navigate(n.link);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('.nt-item') ?? []);
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[i < 0 ? 0 : next]?.focus();
  };

  const unread = q.data?.unread ?? 0;
  return (
    <div className="nt-panel" role="dialog" aria-label="Thông báo" tabIndex={-1} ref={panel} onKeyDown={onKeyDown}>
      <div className="nt-head">
        <span className="nt-head__title">Thông báo</span>
        {unread ? <span className="nt-head__count">{unread} chưa đọc</span> : null}
        <button
          type="button"
          className="nt-head__all"
          disabled={!unread || busy}
          onClick={async () => {
            setBusy(true);
            await markRead();
            setBusy(false);
          }}
        >
          Đánh dấu đã đọc hết
        </button>
      </div>
      <div className="nt-list">
        {q.isPending ? (
          <div className="nt-state" aria-busy="true" aria-label="Đang tải thông báo">
            <Skeleton width="70%" height={11} />
            <Skeleton width="90%" height={9} style={{ marginTop: 8 }} />
          </div>
        ) : q.isError ? (
          <div className="nt-state">
            Không tải được thông báo.{' '}
            <button type="button" className="nt-link" onClick={() => void q.refetch()}>
              Thử lại
            </button>
          </div>
        ) : q.data.items.length === 0 ? (
          <div className="nt-state">
            <Icon name="ph ph-bell-slash" size={18} />
            <span>Chưa có thông báo nào.</span>
          </div>
        ) : (
          <ul className="nt-items">
            {q.data.items.map((n) => (
              <li key={n.id}>
                <button type="button" className="nt-item" data-unread={!n.read || undefined} onClick={() => openItem(n)}>
                  <span className="nt-item__icon" aria-hidden>
                    <Icon name={KIND_ICON[n.kind] ?? 'ph ph-bell'} size={14} />
                  </span>
                  <span className="nt-item__text">
                    <span className="nt-item__title">
                      {n.title}
                      {!n.read ? <span className="visually-hidden"> (chưa đọc)</span> : null}
                    </span>
                    {n.body ? <span className="nt-item__body">{n.body}</span> : null}
                    <span className="nt-item__time">{fmtAgo(n.created_at, now)}</span>
                  </span>
                  {!n.read ? <span className="nt-item__dot" aria-hidden /> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
