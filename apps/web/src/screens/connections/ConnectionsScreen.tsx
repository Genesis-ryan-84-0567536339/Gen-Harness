import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { SCREEN_BY_KEY } from '@gen-harness/contracts';
import { EmptyState, Icon } from '@gen-harness/ui';
import { FOLLOW_UP_KEY } from '../../guide/guideContent';
import { api } from '../../lib/api';
import { useChannels, useCliProfiles, useProviders } from '../../lib/dataQueries';
import { useCan } from '../../lib/permissions';
import { useMe } from '../../lib/queries';
import { CardError, Panel, ScreenHead, SkeletonLines } from '../common';
import { HubLinkCard } from '../mcp/HubLinkCard';
import { useMcpServers } from '../mcp/queries';
import { ChannelCard } from '../system/ChannelCard';
import { CliCard } from '../system/CliCard';
import { SocialEntryCard } from '../system/SocialEntryCard';
import { ConnectionStatusPill } from './ConnectionStatusPill';
import { activeCliState, brainStatus, mcpEnabledCount, mcpStatus, orderChannels } from './connectionsModel';

/**
 * v0.1.42 (F-7, F-61): Kết nối — một trang, mỗi thứ một thẻ, cùng một kiểu viên trạng thái (Đang chạy · Cần Sếp xử
 * lý · Chưa nối) và đúng một nút chính. Thứ tự: Bộ não AI · Zalo · WhatsApp · Telegram (· kênh khác) · Facebook ·
 * Gen-hub · MCP. Đây là nơi DUY NHẤT render thẻ tài khoản CLI (CliCard) và thẻ Gen-hub (HubLinkCard).
 */
export function ConnectionsScreen() {
  const meta = SCREEN_BY_KEY.connections;
  const canManage = useCan('system.manage');
  const { hash } = useLocation();

  // /connections#brain, #genhub (link từ Cài đặt › Bộ não AI, MCP Hub, chuông, Bản tin Gen) → cuộn tới thẻ. Cuộn lại khi
  // danh sách kênh tải xong (thẻ kênh nằm trên Gen-hub — khung chờ thấp hơn thẻ thật làm lệch vị trí).
  const channelsReady = !useChannels().isPending;
  useEffect(() => {
    if (!hash) return;
    const id = hash.slice(1);
    const t = window.setTimeout(() => document.getElementById(id)?.scrollIntoView?.({ block: 'start' }), 50);
    return () => window.clearTimeout(t);
  }, [hash, channelsReady]);

  return (
    <div className="screen">
      <ScreenHead title={meta.title} description={meta.description} maxWidth={meta.descMaxWidth} />

      <section id="brain" className="conn-section" aria-label="Nguồn AI và tài khoản CLI">
        <div className="conn-grid">
          <BrainCard />
          {/* Nơi DUY NHẤT render thẻ tài khoản CLI (v0.1.42, F-61). */}
          <CliCard canManage={canManage} kind="antigravity_cli" />
          <CliCard canManage={canManage} kind="claude_code_cli" showCredentials={false} />
        </div>
      </section>

      <section className="conn-section" aria-label="Kênh nhắn tin">
        <ChannelCards canManage={canManage} />
      </section>

      <section className="conn-section" aria-label="Mạng xã hội và công cụ ngoài">
        <div className="conn-grid">
          <SocialEntryCard />
          <div id="genhub" className="conn-anchor">
            <HubLinkCard />
          </div>
          <McpCard />
        </div>
      </section>
    </div>
  );
}

function BrainCard() {
  const isOwner = useMe().data?.role?.code === 'owner';
  const providers = useProviders();
  const agy = useCliProfiles('antigravity_cli');
  const claude = useCliProfiles('claude_code_cli');
  // "Chưa có model" — bước 4 chưa xong (API `GET /setup/follow-up` chỉ trả cho Owner).
  const followUp = useQuery({ queryKey: FOLLOW_UP_KEY, queryFn: ({ signal }) => api.setup.followUp(signal), enabled: isOwner });
  const step4 = Array.isArray(followUp.data) ? followUp.data.find((s) => s.n === 4) : undefined;
  const noModel = !!step4 && !step4.done;
  const gen = (providers.data ?? []).filter((p) => p.kind !== 'system_one');
  const enabled = gen.filter((p) => p.enabled).length;
  const status = providers.data
    ? brainStatus({ providers: providers.data, cliStatus: [activeCliState(agy.data), activeCliState(claude.data)], noModel })
    : null;
  return (
    <Panel
      title="Bộ não AI"
      genTarget="connections.brain"
      label="Bộ não AI"
      kicker={
        providers.data
          ? noModel
            ? 'Chưa chọn model cho Gen và Sàng lọc'
            : `${enabled}/${gen.length} nguồn khoá API đang bật · tài khoản CLI bên dưới`
          : 'Model, khoá API và tài khoản CLI'
      }
      aside={status ? <ConnectionStatusPill status={status} /> : undefined}
      bodyClass="conn-card__body"
    >
      {providers.isPending ? (
        <SkeletonLines rows={1} padding="0" />
      ) : providers.isError ? (
        <CardError error={providers.error} onRetry={() => void providers.refetch()} retrying={providers.isFetching} />
      ) : null}
      <div className="conn-card__actions">
        <Link to="/system?tab=brain" className="gh-btn gh-btn--secondary btn-27" data-main-action>
          <Icon name="ph ph-brain" size={13} />
          Mở Bộ não AI
        </Link>
        {isOwner ? (
          <Link to="/guide/4" className="conn-card__guide">
            Hướng dẫn
          </Link>
        ) : null}
      </div>
    </Panel>
  );
}

function ChannelCards({ canManage }: { canManage: boolean }) {
  const channels = useChannels();
  if (channels.isPending) {
    return (
      <div className="conn-grid" aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <div className="ch-card" key={i} aria-hidden>
            <SkeletonLines rows={2} padding="0" />
          </div>
        ))}
      </div>
    );
  }
  if (channels.isError) {
    return (
      <div className="gh-card" aria-label="Kênh">
        <CardError error={channels.error} onRetry={() => void channels.refetch()} retrying={channels.isFetching} />
      </div>
    );
  }
  if (channels.data.length === 0) {
    return (
      <div className="gh-card">
        <EmptyState icon="ph ph-plugs" title="Chưa có kênh nào" description="Bản đang chạy chưa có kênh nhắn tin nào." />
      </div>
    );
  }
  return (
    <div className="conn-grid" data-gen-target="system.channels.list">
      {orderChannels(channels.data).map((c) => (
        <ChannelCard key={c.type} channel={c} canManage={canManage} />
      ))}
    </div>
  );
}

function McpCard() {
  const servers = useMcpServers();
  const n = mcpEnabledCount(servers.data);
  return (
    <Panel
      title="MCP"
      label="MCP"
      kicker={servers.data ? (n ? `${n} máy chủ đang bật` : 'Chưa bật máy chủ MCP nào') : 'Máy chủ MCP cho agent gọi công cụ ngoài'}
      aside={servers.data ? <ConnectionStatusPill status={mcpStatus(servers.data)} /> : undefined}
      bodyClass="conn-card__body"
    >
      {servers.isPending ? (
        <SkeletonLines rows={1} padding="0" />
      ) : servers.isError ? (
        <CardError error={servers.error} onRetry={() => void servers.refetch()} retrying={servers.isFetching} />
      ) : null}
      <div className="conn-card__actions">
        <Link to="/mcp" className="gh-btn gh-btn--secondary btn-27" data-main-action>
          <Icon name="ph ph-plugs-connected" size={13} />
          Mở MCP Hub
        </Link>
      </div>
    </Panel>
  );
}
