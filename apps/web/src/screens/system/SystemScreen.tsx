import { SCREEN_BY_KEY } from '@gen-harness/contracts';
import { EmptyState, Tabs } from '@gen-harness/ui';
import { useChannels } from '../../lib/dataQueries';
import { useCan } from '../../lib/permissions';
import { useUrlState } from '../../lib/uiStore';
import { CardError, ScreenHead, SkeletonLines } from '../common';
import { BrainTab } from './BrainTab';
import { ChannelCard } from './ChannelCard';
import { CliCard } from './CliCard';
import { LogTab } from './LogTab';
import { PinCard } from './PinCard';
import { RolesTab } from './RolesTab';
import { StorageTab } from './StorageTab';

type SysTab = 'channels' | 'brain' | 'roles' | 'log' | 'storage';

/** Design `sysTabs` (4 tab) + `storage` (PLAN 4.5, spec I — thêm ngoài thiết kế gốc). */
const TABS: Array<{ key: SysTab; label: string; count: string }> = [
  { key: 'channels', label: 'Kênh & đăng nhập', count: 'QR · PIN' },
  { key: 'brain', label: 'Bộ não AI', count: '6 model' },
  { key: 'roles', label: 'Quyền hạn', count: '5 vai trò' },
  { key: 'log', label: 'Nhật ký', count: '30 ngày' },
  { key: 'storage', label: 'Dữ liệu & lưu trữ', count: 'spec I' },
];

export function SystemScreen() {
  const meta = SCREEN_BY_KEY.system;
  const [tab, setTab] = useUrlState<SysTab>('tab', 'channels');
  const current = TABS.some((t) => t.key === tab) ? tab : 'channels';
  return (
    <div className="screen">
      <ScreenHead title={meta.title} description={meta.description} maxWidth={700} />
      <Tabs items={TABS} value={current} onChange={setTab} label="Điều khiển hệ thống" idPrefix="sys" />
      <div role="tabpanel" id={`sys-panel-${current}`} aria-labelledby={`sys-${current}`} className="sys-tabs-panel">
        {current === 'channels' ? (
          <ChannelsTab />
        ) : current === 'brain' ? (
          <BrainTab />
        ) : current === 'roles' ? (
          <RolesTab />
        ) : current === 'log' ? (
          <LogTab />
        ) : (
          <StorageTab />
        )}
      </div>
    </div>
  );
}

function ChannelsTab() {
  const canRead = useCan('system.read');
  // The System screen is open to audit.read too (a Manager sees only the log); channels need system.read.
  if (!canRead) {
    return (
      <div className="sys-grid">
        <div className="gh-card">
          <EmptyState
            icon="ph ph-lock-simple"
            title="Vai trò của bạn không xem được kênh"
            description="Kênh, phiên đăng nhập và khoá chỉ hiện với vai trò có quyền xem hệ thống. Nhật ký hành động ở tab Nhật ký."
          />
        </div>
        <div className="side-col">
          <PinCard />
        </div>
      </div>
    );
  }
  return <ChannelsTabBody />;
}

function ChannelsTabBody() {
  const canManage = useCan('system.manage');
  const channels = useChannels();
  return (
    <div className="sys-grid">
      <div className="ch-list" aria-label="Kênh" aria-busy={channels.isFetching || undefined}>
        {channels.isPending ? (
          Array.from({ length: 4 }, (_, i) => (
            <div className="ch-card" key={i} aria-hidden>
              <SkeletonLines rows={2} padding="0" />
            </div>
          ))
        ) : channels.isError ? (
          <div className="gh-card">
            <CardError error={channels.error} onRetry={() => void channels.refetch()} retrying={channels.isFetching} />
          </div>
        ) : channels.data.length === 0 ? (
          <div className="gh-card">
            <EmptyState icon="ph ph-plugs" title="Chưa có kênh nào" description="Cài plugin kênh ở Plugin & Tiện ích." />
          </div>
        ) : (
          channels.data.map((c) => <ChannelCard key={c.type} channel={c} canManage={canManage} />)
        )}
      </div>
      <div className="side-col">
        <PinCard />
        <CliCard canManage={canManage} />
      </div>
    </div>
  );
}
