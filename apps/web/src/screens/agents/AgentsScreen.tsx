import { useMemo, useState } from 'react';
import type { AgentDecision, AgentIdentity, AgentTemplate } from '@gen-harness/contracts';
import { SCREEN_BY_KEY } from '@gen-harness/contracts';
import { Button, Dialog, EmptyState, Icon, SelectField, Switch, TextField } from '@gen-harness/ui';
import { useChannels } from '../../lib/dataQueries';
import { fmtDMClock } from '../../lib/format';
import { useCan } from '../../lib/permissions';
import { errorText } from '../../lib/errorText';
import { CardError, InlineError, Panel, ScreenHead, SkeletonLines, StateChip } from '../common';
import {
  AUTONOMY_LEVELS,
  AUTONOMY_OPTIONS,
  agentIcon,
  decisionTone,
  decisionWhat,
  lastSpoke,
  scopeSummary,
} from './agentsModel';
import { useAgentDecisions, useAgentTemplates, useAgents, useCloneAgent, useCreateAgent, useSetAgentEnabled, useUpdateAgent } from './queries';

export function AgentsScreen() {
  const meta = SCREEN_BY_KEY.agents;
  const canManage = useCan('system.manage');
  const agents = useAgents();
  const decisions = useAgentDecisions(undefined, undefined, 8);
  const [editing, setEditing] = useState<{ agent: AgentIdentity | null; template: AgentTemplate | null } | null>(null);
  const [cloning, setCloning] = useState(false);

  const actions = canManage ? (
    <>
      <Button variant="secondary" icon="ph ph-copy" className="btn-30" onClick={() => setCloning(true)} disabled={!agents.data?.length}>
        Nhân bản
      </Button>
      <Button variant="primary" icon="ph ph-plus" className="btn-30" onClick={() => setEditing({ agent: null, template: null })}>
        Tạo agent mới
      </Button>
    </>
  ) : null;

  return (
    <div className="screen">
      <ScreenHead title={meta.title} description={meta.description} maxWidth={700} actions={actions} />

      <div className="ag-grid" role="list" aria-label="Danh sách agent" aria-busy={agents.isFetching || undefined}>
        {agents.isPending ? (
          Array.from({ length: 3 }, (_, i) => <AgentCardSkeleton key={i} />)
        ) : agents.isError ? (
          <div className="gh-card">
            <CardError error={agents.error} onRetry={() => void agents.refetch()} retrying={agents.isFetching} />
          </div>
        ) : agents.data.length === 0 ? (
          <div className="gh-card">
            <EmptyState
              icon="ph ph-user-focus"
              title="Chưa có danh tính agent nào"
              description={canManage ? 'Tạo agent đầu tiên, hoặc dùng một mẫu có sẵn ở dưới.' : 'Owner chưa tạo danh tính agent nào.'}
            />
          </div>
        ) : (
          agents.data.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              canManage={canManage}
              decisions={decisions.data?.items ?? []}
              onEdit={() => setEditing({ agent: a, template: null })}
            />
          ))
        )}
      </div>

      <div className="ag-panels">
        <DecisionsPanel />
        <TemplatesPanel canManage={canManage} onUseTemplate={(t) => setEditing({ agent: null, template: t })} />
      </div>

      {editing ? <AgentFormDialog agent={editing.agent} template={editing.template} onClose={() => setEditing(null)} /> : null}
      {cloning ? <CloneAgentDialog agents={agents.data ?? []} onClose={() => setCloning(false)} /> : null}
    </div>
  );
}

function AgentCard({
  agent,
  canManage,
  decisions,
  onEdit,
}: {
  agent: AgentIdentity;
  canManage: boolean;
  decisions: AgentDecision[];
  onEdit: () => void;
}) {
  const { icon, tone } = agentIcon(agent);
  const setEnabled = useSetAgentEnabled();
  const fields: Array<[string, string]> = [
    ['VAI TRÒ', agent.role_desc],
    ['GIỌNG', agent.voice],
    ['NÓI KHI', agent.speak_when],
    ['CẤM', agent.forbidden.length ? agent.forbidden.join(' · ') : 'Không khai báo'],
    ['KÊNH', scopeSummary(agent.channel_scopes)],
  ];
  return (
    <article className="ag-card" role="listitem" data-off={agent.is_enabled ? undefined : ''} aria-label={agent.name}>
      <div className="ag-card__head">
        <div className="ag-card__icon" style={{ color: tone }}>
          <Icon name={icon} size={16} />
        </div>
        <div className="ag-card__title">
          <div className="ag-card__name">{agent.name}</div>
          <div className="ag-card__role">{agent.role_desc}</div>
        </div>
        {canManage ? (
          <Switch
            checked={agent.is_enabled}
            label={`${agent.is_enabled ? 'Tắt' : 'Bật'} agent ${agent.name}`}
            disabled={setEnabled.isPending}
            onChange={(v) => setEnabled.mutate({ id: agent.id, enabled: v })}
          />
        ) : (
          <StateChip color={agent.is_enabled ? 'var(--color-ok)' : 'var(--color-neutral-500)'}>{agent.is_enabled ? 'Bật' : 'Tắt'}</StateChip>
        )}
      </div>
      <div className="ag-card__fields">
        {fields.map(([k, v]) => (
          <div className="ag-field-row" key={k}>
            <span className="ag-field-row__key">{k}</span>
            <span className="ag-field-row__val">{v}</span>
          </div>
        ))}
      </div>
      <div className="ag-card__rule" aria-hidden />
      <div className="ag-card__foot">
        <span className="ag-autonomy" title={AUTONOMY_LEVELS[agent.autonomy_level]}>
          tự trị {agent.autonomy_level}
        </span>
        <span className="ag-card__spoke">{lastSpoke(agent.id, decisions)}</span>
        <Button variant="ghost" className="btn-22" onClick={onEdit} aria-label={`${canManage ? 'Sửa' : 'Xem'} agent ${agent.name}`}>
          {canManage ? 'Sửa' : 'Xem'}
        </Button>
      </div>
    </article>
  );
}

function AgentCardSkeleton() {
  return (
    <div className="ag-card" aria-hidden>
      <SkeletonLines rows={2} padding="0" />
    </div>
  );
}

function DecisionsPanel() {
  const [full, setFull] = useState(false);
  const decisions = useAgentDecisions(undefined, undefined, full ? 50 : 8);
  return (
    <Panel
      title="Agent đã nói gì, nhân danh gì"
      kicker="Mọi phát ngôn đều ghi lại danh tính đứng tên"
      aside={
        <Button variant="secondary" className="btn-27" onClick={() => setFull((v) => !v)}>
          {full ? 'Thu gọn' : 'Xem toàn bộ'}
        </Button>
      }
      bodyClass="ag-log"
      label="Agent đã nói gì, nhân danh gì"
    >
      {decisions.isPending ? (
        <SkeletonLines rows={4} padding="10px 16px" />
      ) : decisions.isError ? (
        <CardError error={decisions.error} onRetry={() => void decisions.refetch()} retrying={decisions.isFetching} />
      ) : decisions.data.items.length === 0 ? (
        <EmptyState icon="ph ph-chat-circle-dots" title="Chưa có quyết định nào được ghi lại" />
      ) : (
        decisions.data.items.map((d) => (
          <div className="ag-log-row" key={d.id}>
            <span className="ag-log-row__time">{fmtDMClock(d.at)}</span>
            <span className="ag-log-row__agent">{d.agent.name}</span>
            <span className="ag-log-row__what" style={{ color: decisionTone(d.decision) }}>
              {decisionWhat(d)}
            </span>
          </div>
        ))
      )}
    </Panel>
  );
}

function TemplatesPanel({ canManage, onUseTemplate }: { canManage: boolean; onUseTemplate: (t: AgentTemplate) => void }) {
  const templates = useAgentTemplates();
  return (
    <Panel title="Mẫu có sẵn" kicker="Template tùy chọn · không phải bản sắc hệ thống" bodyClass="ag-templates" label="Mẫu có sẵn">
      {templates.isPending ? (
        <SkeletonLines rows={4} padding="8px 16px" />
      ) : templates.isError ? (
        <CardError error={templates.error} onRetry={() => void templates.refetch()} retrying={templates.isFetching} />
      ) : (
        templates.data.map((t) => (
          <div className="ag-template-row" key={t.code}>
            <Icon name="ph ph-stack" size={15} />
            <div className="ag-template-row__body">
              <div className="ag-template-row__name" style={{ color: t.default_enabled ? undefined : 'var(--color-neutral-500)' }}>
                {t.name}
              </div>
              <div className="ag-template-row__note">{t.role_desc}</div>
            </div>
            {canManage ? (
              <Button variant="ghost" className="btn-22" onClick={() => onUseTemplate(t)}>
                Dùng mẫu
              </Button>
            ) : null}
          </div>
        ))
      )}
    </Panel>
  );
}

function AgentFormDialog({ agent, template, onClose }: { agent: AgentIdentity | null; template: AgentTemplate | null; onClose: () => void }) {
  const create = useCreateAgent();
  const update = useUpdateAgent();
  const channels = useChannels();
  const [name, setName] = useState(agent?.name ?? template?.name ?? '');
  const [roleDesc, setRoleDesc] = useState(agent?.role_desc ?? template?.role_desc ?? '');
  const [voice, setVoice] = useState(agent?.voice ?? template?.voice ?? '');
  const [speakWhen, setSpeakWhen] = useState(agent?.speak_when ?? template?.speak_when ?? '');
  const [forbidden, setForbidden] = useState((agent?.forbidden ?? template?.forbidden ?? []).join('\n'));
  const [autonomy, setAutonomy] = useState(String(agent?.autonomy_level ?? 2));
  const [scopeIds, setScopeIds] = useState<Set<string>>(new Set(agent?.channel_scopes.map((s) => s.channel_id) ?? []));
  const installed = (channels.data ?? []).filter((c) => c.installed && c.id);

  const mutation = agent ? update : create;
  const submit = () => {
    if (!name.trim() || !roleDesc.trim() || !voice.trim() || !speakWhen.trim()) return;
    const body = {
      name: name.trim(),
      role_desc: roleDesc.trim(),
      voice: voice.trim(),
      speak_when: speakWhen.trim(),
      autonomy_level: Number(autonomy),
      forbidden: forbidden
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      template: agent ? agent.template : (template?.code ?? null),
      channel_scopes: [...scopeIds].map((channel_id) => ({ channel_id })),
    };
    if (agent) update.mutate({ id: agent.id, body }, { onSuccess: onClose });
    else create.mutate(body, { onSuccess: onClose });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={480}
      title={agent ? `Sửa ${agent.name}` : 'Tạo agent mới'}
      kicker={template && !agent ? `Prefill từ mẫu ${template.name} — không mặc định bắt buộc, chỉnh tự do` : 'Danh tính do Sếp tự định nghĩa'}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" loading={mutation.isPending} disabled={!name.trim() || !roleDesc.trim() || !voice.trim() || !speakWhen.trim()} onClick={submit}>
            {agent ? 'Lưu thay đổi' : 'Tạo agent'}
          </Button>
        </>
      }
    >
      <form
        className="dlg-fields"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField label="Tên hiển thị" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        <TextField label="Vai trò" value={roleDesc} onChange={(e) => setRoleDesc(e.target.value)} maxLength={500} />
        <TextField label="Giọng / persona" value={voice} onChange={(e) => setVoice(e.target.value)} maxLength={200} />
        <TextField label="Khi nào được nói" value={speakWhen} onChange={(e) => setSpeakWhen(e.target.value)} maxLength={500} />
        <div className="gh-field">
          <label className="gh-field__label" htmlFor="ag-forbidden">
            Cấm làm gì (mỗi dòng một điều)
          </label>
          <textarea id="ag-forbidden" className="gh-input" rows={2} value={forbidden} onChange={(e) => setForbidden(e.target.value)} />
        </div>
        <SelectField label="Mức tự trị" value={autonomy} onChange={(e) => setAutonomy(e.target.value)} options={AUTONOMY_OPTIONS} />
        <fieldset className="ag-scope-fields">
          <legend className="gh-field__label">Phạm vi kênh được xuất hiện</legend>
          {installed.length === 0 ? (
            <p className="muted-note">Chưa có kênh nào cài đặt.</p>
          ) : (
            installed.map((c) => (
              <label className="ag-scope-check" key={c.id}>
                <input
                  type="checkbox"
                  checked={scopeIds.has(c.id as string)}
                  onChange={(e) => {
                    const next = new Set(scopeIds);
                    if (e.target.checked) next.add(c.id as string);
                    else next.delete(c.id as string);
                    setScopeIds(next);
                  }}
                />
                {c.name}
              </label>
            ))
          )}
        </fieldset>
        {mutation.isError ? <InlineError>{errorText(mutation.error)}</InlineError> : null}
      </form>
    </Dialog>
  );
}

function CloneAgentDialog({ agents, onClose }: { agents: AgentIdentity[]; onClose: () => void }) {
  const clone = useCloneAgent();
  const [sourceId, setSourceId] = useState(agents[0]?.id ?? '');
  const [name, setName] = useState('');
  const [copyScopes, setCopyScopes] = useState(true);
  const source = useMemo(() => agents.find((a) => a.id === sourceId) ?? null, [agents, sourceId]);
  const submit = () => {
    if (!sourceId || !name.trim()) return;
    clone.mutate({ id: sourceId, body: { name: name.trim(), copy_channel_scopes: copyScopes } }, { onSuccess: onClose });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={420}
      title="Nhân bản agent"
      kicker="Bản sao tạo ở trạng thái tắt — Owner rà lại trước khi bật"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" loading={clone.isPending} disabled={!sourceId || !name.trim()} onClick={submit}>
            Nhân bản
          </Button>
        </>
      }
    >
      <form
        className="dlg-fields"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <SelectField
          label="Nhân bản từ"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          options={agents.map((a) => ({ value: a.id, label: a.name }))}
        />
        <TextField label="Tên agent mới" value={name} onChange={(e) => setName(e.target.value)} placeholder={source ? `${source.name} (bản sao)` : ''} maxLength={120} />
        <label className="ag-scope-check">
          <input type="checkbox" checked={copyScopes} onChange={(e) => setCopyScopes(e.target.checked)} />
          Sao chép luôn phạm vi kênh
        </label>
        {clone.isError ? <InlineError>{errorText(clone.error)}</InlineError> : null}
      </form>
    </Dialog>
  );
}
