import type { HeaderStatus } from '@gen-harness/contracts';
import { Icon, IconButton, Pill, Skeleton, Tooltip } from '@gen-harness/ui';
import { useNavigate } from 'react-router-dom';
import { useHeaderStatus } from '../lib/queries';
import { SavedViewsButton } from '../screens/core/SavedViews';
import { useUiStore } from '../lib/uiStore';
import { autonomyTooltip, confidencePercent } from './headerModel';
import { GenToggle } from '../gen/GenToggle';
import { NotificationBell } from './NotificationBell';
import { ThemeToggle } from './ThemeToggle';

export interface Crumbs {
  /** Domain chip, e.g. "KINH DOANH". */
  domain: string;
  /** Parent group name when the screen is a child. */
  group: string | null;
  title: string;
  /** English subtitle (TITLES[1]). */
  subtitle: string;
}

/**
 * v0.1.42 (F-67): viên "tự trị", khiên độ tin cậy và nút "Góc nhìn đã lưu" chỉ hiện khi màn đang mở thuộc Nâng cao
 * (`advanced`); viên "N kênh · M nhóm" luôn hiện. F-63: bỏ dòng phụ đề tiếng Anh.
 */
export function Header({ crumbs, advanced = false }: { crumbs: Crumbs | null; advanced?: boolean }) {
  const status = useHeaderStatus();
  const navigate = useNavigate();
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);

  return (
    <header className="hd">
      <div className="hd-left">
        {/* B4: chỉ hiện trên điện thoại (shell.css) — mở ngăn kéo danh mục. */}
        <IconButton
          icon="ph ph-list"
          label={drawerOpen ? 'Đóng danh mục' : 'Mở danh mục'}
          tooltip={false}
          className="hd-menu"
          aria-controls="app-sidebar"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(!drawerOpen)}
        />
        {crumbs ? (
          <>
            <span className="hd-chip">{crumbs.domain}</span>
            {crumbs.group ? (
              <>
                <Icon className="hd-caret" name="ph ph-caret-right" size={11} />
                <span className="hd-group">{crumbs.group}</span>
              </>
            ) : null}
            <Icon className="hd-caret" name="ph ph-caret-right" size={11} />
            <div className="hd-titles">
              <h1 className="hd-title">{crumbs.title}</h1>
            </div>
          </>
        ) : null}
      </div>
      <div className="hd-right">
        {/* display: contents trên máy tính (bố cục y như thiết kế); ẩn trên điện thoại hẹp. */}
        <div className="hd-status">
          {status.isPending ? (
            <>
              <Skeleton width={118} height={28} radius={999} />
              {advanced ? (
                <>
                  <Skeleton width={78} height={28} radius={999} />
                  <Skeleton width={62} height={28} radius={999} />
                </>
              ) : null}
            </>
          ) : status.isError ? (
            <Tooltip content="Không tải được trạng thái — bấm để thử lại">
              <button type="button" className="hd-pill-btn" onClick={() => void status.refetch()}>
                <Pill icon="ph ph-warning-circle" iconColor="var(--color-bad)">
                  mất trạng thái
                </Pill>
              </button>
            </Tooltip>
          ) : (
            <StatusPills s={status.data} advanced={advanced} />
          )}
        </div>
        {advanced ? <SavedViewsButton /> : null}
        <GenToggle />
        <NotificationBell />
        <ThemeToggle />
        <IconButton icon="ph ph-magnifying-glass" label="Tìm theo ý định" variant="primary" onClick={() => navigate('/search')} />
      </div>
    </header>
  );
}

function StatusPills({ s, advanced }: { s: HeaderStatus; advanced: boolean }) {
  const pct = confidencePercent(s.data_confidence);
  const live = (
    <Tooltip content={`${s.channels_live} kênh đang sống, ${s.groups_listening} nhóm đang lắng nghe`}>
      <div tabIndex={0} className="hd-pill-focus">
        <Pill live={s.channels_live > 0}>
          {s.channels_live} kênh · {s.groups_listening} nhóm
        </Pill>
      </div>
    </Tooltip>
  );
  if (!advanced) return live;
  return (
    <>
      {live}
      <Tooltip content={autonomyTooltip(s.autonomy_level)}>
        <div tabIndex={0} className="hd-pill-focus">
          <Pill icon="ph ph-sliders" iconColor="var(--color-accent-300)" mono>
            tự trị {s.autonomy_level}
          </Pill>
        </div>
      </Tooltip>
      <Tooltip
        content={
          pct === null
            ? 'Độ tin cậy dữ liệu hôm nay — chưa đủ dữ liệu để tính'
            : `Độ tin cậy dữ liệu hôm nay — ${pct}%`
        }
      >
        <div tabIndex={0} className="hd-pill-focus">
          <Pill icon="ph ph-shield-check" iconColor="var(--color-warn-icon)" mono>
            {pct === null ? '—' : `${pct}%`}
          </Pill>
        </div>
      </Tooltip>
    </>
  );
}
