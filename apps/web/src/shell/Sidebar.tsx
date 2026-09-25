import type { CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { NavDomain, NavItem } from '@gen-harness/contracts';
import { ErrorState, Icon, Skeleton, Tooltip, toneColor, toneTint } from '@gen-harness/ui';
import { useNavigation } from '../lib/queries';
import { useUiStore } from '../lib/uiStore';
import { AccountFooter } from './AccountFooter';
import { Logo } from './Logo';
import { domainColor, groupAction, groupView, itemTitle } from './navModel';

export function Sidebar({ activeKey }: { activeKey: string | null }) {
  const mode = useUiStore((s) => s.sidebarMode);
  const wide = mode === 'full';
  const nav = useNavigation();

  return (
    <aside className="sb" data-mode={mode} aria-label="Thanh bên">
      <Logo wide={wide} />
      <div className="sb-rule" aria-hidden />
      <nav className="sb-nav" aria-label="Danh mục màn hình">
        {nav.isPending ? (
          <NavSkeleton wide={wide} />
        ) : nav.isError ? (
          wide ? (
            <div className="sb-error">
              <ErrorState
                title="Không tải được danh mục"
                onRetry={() => void nav.refetch()}
                retrying={nav.isFetching}
              />
            </div>
          ) : (
            <Tooltip content="Không tải được danh mục — bấm để thử lại" placement="right">
              <button type="button" className="sb-item sb-item--error" onClick={() => void nav.refetch()} aria-label="Thử lại tải danh mục">
                <Icon name="ph ph-warning-circle" size={16} />
              </button>
            </Tooltip>
          )
        ) : nav.data.length === 0 ? (
          wide ? <div className="sb-empty">Vai trò này chưa được cấp màn hình nào.</div> : null
        ) : (
          nav.data.map((dm, di) => <Domain key={dm.domain} dm={dm} index={di} wide={wide} activeKey={activeKey} />)
        )}
      </nav>
      <AccountFooter wide={wide} />
    </aside>
  );
}

function Domain({ dm, index, wide, activeKey }: { dm: NavDomain; index: number; wide: boolean; activeKey: string | null }) {
  const color = domainColor(dm.tone);
  return (
    <div className="sb-domain" role="group" aria-label={dm.label}>
      {wide ? (
        <div className="sb-domain__label">
          <Icon name={dm.icon} size={12} color={color} />
          <span className="sb-domain__name" style={{ color }}>
            {dm.label}
          </span>
          <span className="sb-domain__rule" aria-hidden />
          <span className="sb-domain__count">{dm.count} màn</span>
        </div>
      ) : index > 0 ? (
        <div className="sb-rail-rule" aria-hidden />
      ) : null}
      {dm.groups.map((g) => (
        <Group key={g.key ?? g.name} g={g} wide={wide} activeKey={activeKey} />
      ))}
    </div>
  );
}

function Badge({ it }: { it: NavItem }) {
  if (!it.badge) return null;
  const style = {
    '--badge-bg': toneTint(it.badge.tone),
    '--badge-tone': toneColor(it.badge.tone),
  } as CSSProperties;
  return (
    <span className="gh-badge" style={style}>
      {it.badge.value}
    </span>
  );
}

function Group({ g, wide, activeKey }: { g: NavItem; wide: boolean; activeKey: string | null }) {
  const navOpen = useUiStore((s) => s.navOpen);
  const setNavOpen = useUiStore((s) => s.setNavOpen);
  const navigate = useNavigate();
  const view = groupView(g, activeKey, navOpen, wide);
  const action = groupAction(g, activeKey, navOpen, wide);
  const isPureGroup = !g.key;
  const kids = g.children ?? [];

  const inner = (
    <>
      <span className="sb-item__bar" aria-hidden />
      <Icon name={g.icon} size={16} />
      {wide ? <span className="sb-item__name">{g.name}</span> : null}
      {wide ? <Badge it={g} /> : null}
      {view.showCaret ? (
        <Icon className="sb-item__caret" name={view.open ? 'ph ph-caret-down' : 'ph ph-caret-right'} size={12} />
      ) : null}
    </>
  );

  const common = {
    className: 'sb-item',
    'data-on': view.on || undefined,
    'data-self': view.self || undefined,
    title: wide ? (isPureGroup ? g.name : itemTitle(g)) : undefined,
  };

  let el;
  if (!isPureGroup && g.key) {
    el = (
      <Link
        to={`/${g.key}`}
        {...common}
        aria-current={view.self ? 'page' : undefined}
        aria-label={wide ? undefined : g.name}
        aria-expanded={view.showCaret ? view.open : undefined}
      >
        {inner}
      </Link>
    );
  } else {
    el = (
      <button
        type="button"
        {...common}
        aria-expanded={wide ? view.open : undefined}
        aria-label={wide ? undefined : g.name}
        onClick={() => {
          if (action.type === 'toggle') setNavOpen(action.group, action.open);
          else if (action.type === 'navigate') navigate(`/${action.key}`);
        }}
      >
        {inner}
      </button>
    );
  }

  return (
    <div className="sb-group" data-screen={g.key ?? undefined}>
      {wide ? (
        el
      ) : (
        <Tooltip content={g.name} sub={g.en ?? undefined} placement="right" delay={150}>
          {el}
        </Tooltip>
      )}
      {view.open ? (
        <div className="sb-children" role="group" aria-label={g.name}>
          {kids.map((c) =>
            c.key ? (
              <Link
                key={c.key}
                to={`/${c.key}`}
                className="sb-child"
                data-screen={c.key}
                data-on={c.key === activeKey || undefined}
                aria-current={c.key === activeKey ? 'page' : undefined}
                title={itemTitle(c)}
              >
                <span className="sb-child__dot" aria-hidden />
                <span className="sb-child__name">{c.name}</span>
                <Badge it={c} />
              </Link>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

function NavSkeleton({ wide }: { wide: boolean }) {
  const rows = [6, 4];
  return (
    <div aria-busy="true" aria-label="Đang tải danh mục">
      {rows.map((n, d) => (
        <div className="sb-domain" key={d}>
          {wide ? (
            <div className="sb-domain__label">
              <Skeleton width={90} height={9} />
            </div>
          ) : d > 0 ? (
            <div className="sb-rail-rule" />
          ) : null}
          {Array.from({ length: n }, (_, i) => (
            <div className="sb-item sb-item--skeleton" key={i}>
              <Skeleton width={16} height={16} radius={4} />
              {wide ? <Skeleton width={`${50 + ((i * 17) % 40)}%`} height={10} /> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
