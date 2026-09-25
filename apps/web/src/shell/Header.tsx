import type { HeaderStatus } from '@gen-harness/contracts';
import { Icon, IconButton, Pill, Skeleton, Tooltip } from '@gen-harness/ui';
import { useHeaderStatus } from '../lib/queries';
import { useUiStore } from '../lib/uiStore';
import { autonomyTooltip, confidencePercent } from './headerModel';

export interface Crumbs {
  /** Domain chip, e.g. "KINH DOANH". */
  domain: string;
  /** Parent group name when the screen is a child. */
  group: string | null;
  title: string;
  /** English subtitle (TITLES[1]). */
  subtitle: string;
}

export function Header({ crumbs }: { crumbs: Crumbs | null }) {
  const showEnglish = useUiStore((s) => s.showEnglish);
  const status = useHeaderStatus();
  const hasSub = !!crumbs && showEnglish && !crumbs.group && !!crumbs.subtitle;

  return (
    <header className="hd">
      <div className="hd-left">
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
              {hasSub ? <div className="hd-sub">{crumbs.subtitle}</div> : null}
            </div>
          </>
        ) : null}
      </div>
      <div className="hd-right">
        {status.isPending ? (
          <>
            <Skeleton width={118} height={28} radius={999} />
            <Skeleton width={78} height={28} radius={999} />
            <Skeleton width={62} height={28} radius={999} />
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
          <StatusPills s={status.data} />
        )}
        <IconButton icon="ph ph-bookmark-simple" label="Góc nhìn đã lưu" variant="secondary" />
        <IconButton icon="ph ph-magnifying-glass" label="Tìm theo ý định" variant="primary" />
      </div>
    </header>
  );
}

function StatusPills({ s }: { s: HeaderStatus }) {
  const pct = confidencePercent(s.data_confidence);
  return (
    <>
      <Tooltip content={`${s.channels_live} kênh đang sống, ${s.groups_listening} nhóm đang lắng nghe`}>
        <div tabIndex={0} className="hd-pill-focus">
          <Pill live={s.channels_live > 0}>
            {s.channels_live} kênh · {s.groups_listening} nhóm
          </Pill>
        </div>
      </Tooltip>
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
