import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { ChannelGroup } from '@gen-harness/contracts';
import { EmptyState, Icon } from '@gen-harness/ui';
import { api } from '../lib/api';
import { qk2, useChannels } from '../lib/dataQueries';
import { fmtInt } from '../lib/format';
import { CardError, SkeletonLines } from '../screens/common';
import { channelIcon, channelName, channelTone } from '../screens/data/dataModel';
import { GroupsTable } from '../screens/system/ChannelCard';
import { anyListening, applyGroupDraft, type GroupDraft } from './phase2Model';
import { StepFrame } from './StepFrame';
import { describeError, type StepProps } from './types';

/** Bước 6 — every synced group starts at "Không nghe"; the owner turns groups on one by one. */
export function Step6Groups({ meta, description, onBack, onSaved, formRef }: StepProps) {
  const channels = useChannels();
  const types = (channels.data ?? []).filter((c) => c.state !== 'not_installed' && c.state !== 'identity_only').map((c) => c.type);
  const groupQueries = useQueries({
    queries: types.map((t) => ({ queryKey: qk2.channelGroups(t), queryFn: ({ signal }: { signal: AbortSignal }) => api.channels.groups(t, signal) })),
  });
  const [draft, setDraft] = useState<GroupDraft>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loaded: Array<{ type: string; groups: ChannelGroup[] }> = types.map((t, i) => ({
    type: t,
    groups: applyGroupDraft(groupQueries[i]?.data ?? [], draft),
  }));
  const all = loaded.flatMap((l) => l.groups);
  const listening = all.filter((g) => g.listen_mode !== 'off').length;
  const pending = channels.isPending || groupQueries.some((q) => q.isPending);
  const failed = channels.error ?? groupQueries.find((q) => q.isError)?.error;

  const onLocalChange = (id: string, patch: Partial<GroupDraft[string]>) => {
    const g = all.find((x) => x.id === id);
    if (!g) return;
    setDraft((d) => ({ ...d, [id]: { listen_mode: g.listen_mode, view_scope: g.view_scope, ...patch } }));
  };

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      onSaved(await api.setup.step6({ groups: all.map((g) => ({ id: g.id, listen_mode: g.listen_mode, view_scope: g.view_scope })) }));
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepFrame
      n={meta.n}
      title={meta.title}
      description={description}
      formRef={formRef}
      canContinue={anyListening(all)}
      busy={busy}
      onContinue={() => void save()}
      onBack={onBack}
      formError={formError}
    >
      {pending ? (
        <SkeletonLines rows={5} />
      ) : failed ? (
        <CardError
          error={failed}
          onRetry={() => {
            void channels.refetch();
            groupQueries.forEach((q) => void q.refetch());
          }}
        />
      ) : all.length === 0 ? (
        <EmptyState
          icon="ph ph-users-three"
          title="Chưa có nhóm nào được đồng bộ"
          description="Quay lại bước Kết nối kênh và chờ bridge đồng bộ danh sách nhóm sau khi quét mã."
        />
      ) : (
        <>
          <div className="setup-section" style={{ paddingBottom: 0, borderBottom: 'none' }}>
            <p className="setup-section__hint" role="status">
              {listening > 0 ? `${fmtInt(listening)} / ${fmtInt(all.length)} nhóm được bật.` : `Chưa bật nhóm nào trong ${fmtInt(all.length)} nhóm — bật ít nhất một nhóm để tiếp tục.`}
            </p>
          </div>
          {loaded
            .filter((l) => l.groups.length > 0)
            .map((l) => (
              <div className="setup-section" key={l.type} style={{ paddingLeft: 0, paddingRight: 0 }}>
                <div className="setup-section__title" style={{ padding: '0 16px', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Icon name={channelIcon(l.type)} size={13} color={channelTone(l.type)} />
                  {channelName(l.type)} · {fmtInt(l.groups.length)} nhóm
                </div>
                <div className="gh-table-scroll">
                  <GroupsTable groups={l.groups} type={l.type} canManage onLocalChange={onLocalChange} />
                </div>
              </div>
            ))}
        </>
      )}
    </StepFrame>
  );
}
