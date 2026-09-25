import { SCREEN_BY_KEY } from '@gen-harness/contracts';
import { EmptyState, Tabs } from '@gen-harness/ui';
import { useChannels } from '../../lib/dataQueries';
import { useCan } from '../../lib/permissions';
import { useUrlState } from '../../lib/uiStore';
import { CardError, ScreenHead, SkeletonLines } from '../common';
import { ChannelCard } from './ChannelCard';
import { CliCard } from './CliCard';
import { PinCard } from './PinCard';

type SysTab = 'channels' | 'brain' | 'roles' | 'log';

/** Design `sysTabs` — counts are the design's static labels. */
const TABS: Array<{ key: SysTab; label: string; count: string }> = [
  { key: 'channels', label: 'Kênh & đăng nhập', count: 'QR · PIN' },
  { key: 'brain', label: 'Bộ não AI', count: '6 model' },
  { key: 'roles', label: 'Quyền hạn', count: '5 vai trò' },
  { key: 'log', label: 'Nhật ký', count: '30 ngày' },
];

const PLACEHOLDER: Record<Exclude<SysTab, 'channels'>, { icon: string; title: string; description: string }> = {
  brain: {
    icon: 'ph ph-brain',
    title: 'Bộ não AI — sắp có',
    description: 'Hạn mức theo model, chuỗi chuyển hướng và khoá API có màn cấu hình đầy đủ ở giai đoạn sau. Tài khoản CLI và khoá hiện ở tab Kênh & đăng nhập.',
  },
  roles: {
    icon: 'ph ph-shield-check',
    title: 'Quyền hạn — sắp có',
    description: 'Ma trận quyền theo vai trò và lời mời người dùng được dựng ở giai đoạn sau.',
  },
  log: {
    icon: 'ph ph-list-checks',
    title: 'Nhật ký — sắp có',
    description: 'Nhật ký hành động 30 ngày với kiểm chuỗi băm được dựng ở giai đoạn sau.',
  },
};

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
        ) : (
          <div className="gh-card">
            <EmptyState {...PLACEHOLDER[current]} />
          </div>
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
