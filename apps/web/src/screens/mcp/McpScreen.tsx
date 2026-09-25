import { useMemo, useState } from 'react';
import type { McpServer, McpServerCreateBody, McpTool, McpTransport } from '@gen-harness/contracts';
import { SCREEN_BY_KEY } from '@gen-harness/contracts';
import { Button, Dialog, EmptyState, Icon, SelectField, Switch, TextField } from '@gen-harness/ui';
import { useBindings } from '../api/queries';
import { errorText } from '../../lib/errorText';
import { useCan } from '../../lib/permissions';
import { toast } from '../../lib/toast';
import { CardError, InlineError, Panel, ScreenHead, SkeletonLines, StateChip } from '../common';
import { ACCESS_LABEL, N5, OK, OUTCOME_LABEL, TRANSPORT_LABEL, WARN, fmtLatency, healthLabel, healthTone, outcomeTone } from './mcpModel';
import {
  useCallTool,
  useCreateServer,
  useDeleteServer,
  useDiscoverTools,
  useExposeTool,
  useGrantTool,
  useMcpCalls,
  useMcpServers,
  useMcpTools,
  useUngrantTool,
  useUpdateServer,
} from './queries';

const TRANSPORTS: McpTransport[] = ['stdio', 'http+sse', 'streamable_http'];

export function McpScreen() {
  const meta = SCREEN_BY_KEY.mcp;
  const canManage = useCan('system.manage');
  const servers = useMcpServers();
  const tools = useMcpTools();
  const calls = useMcpCalls();
  const bindings = useBindings();
  const [addingServer, setAddingServer] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [testingTool, setTestingTool] = useState<McpTool | null>(null);

  const agents = useMemo(() => (bindings.data?.items ?? []).map((i) => ({ key: i.agent_key, label: i.label })), [bindings.data]);

  const stats = useMemo(() => {
    const s = servers.data ?? [];
    const t = tools.data ?? [];
    const c = calls.data?.items ?? [];
    const publicNetCount = s.filter((x) => x.allow_public_network).length;
    return {
      serversOn: `${s.filter((x) => x.is_enabled).length}/${s.length}`,
      toolsExposed: `${t.filter((x) => x.is_exposed).length}/${t.length}`,
      callsSeen: c.length,
      blockedSeen: c.filter((x) => x.outcome === 'blocked').length,
      publicNetCount,
      serverCount: s.length,
    };
  }, [servers.data, tools.data, calls.data]);

  const actions = canManage ? (
    <Button variant="primary" icon="ph ph-plus" className="btn-30" onClick={() => setAddingServer(true)}>
      Thêm máy chủ
    </Button>
  ) : undefined;

  return (
    <div className="screen">
      <ScreenHead title={meta.title} description={meta.description} maxWidth={meta.descMaxWidth} actions={actions} />

      <div className="mcp-stats">
        <div className="mcp-stat">
          <div className="mcp-stat__label">Máy chủ đang bật</div>
          <div className="mcp-stat__value mono">{stats.serversOn}</div>
        </div>
        <div className="mcp-stat">
          <div className="mcp-stat__label">Tool đã mở</div>
          <div className="mcp-stat__value mono">{stats.toolsExposed}</div>
        </div>
        <div className="mcp-stat">
          <div className="mcp-stat__label">Lượt gọi trong nhật ký</div>
          <div className="mcp-stat__value mono">{stats.callsSeen}</div>
        </div>
        <div className="mcp-stat">
          <div className="mcp-stat__label">Bị chặn trong nhật ký</div>
          <div className="mcp-stat__value mono" style={{ color: stats.blockedSeen ? WARN : undefined }}>
            {stats.blockedSeen}
          </div>
        </div>
      </div>

      <Panel title="Rào chắn khoá cứng" kicker="ARCHITECTURE §7.4, §10 — không cài đặt nào tắt được" bodyClass="mcp-guards" label="Rào chắn khoá cứng MCP">
        <GuardRow label="Tool có ghi phải qua Bàn làm việc trước khi thực thi" hint="Mọi tool loại ghi tạo bản nháp chờ duyệt, không gọi thẳng ra ngoài." />
        <GuardRow label="Agent chỉ gọi được tool Sếp đã mở VÀ đã cấp" hint="Thiếu một trong hai điều kiện → chặn ngay, ghi log, không có cách bật nhanh." />
        <GuardRow label="Tool mới khám phá luôn đóng mặc định" hint="Khám phá xong vẫn phải bật tay từng tool, cần PIN." />
        <GuardRow
          label="Cho phép máy chủ MCP ra mạng công cộng"
          hint={stats.serverCount === 0 ? 'Chưa có máy chủ nào.' : stats.publicNetCount === 0 ? 'Đang tắt cho tất cả máy chủ — sửa từng máy chủ để bật.' : `Đang bật cho ${stats.publicNetCount}/${stats.serverCount} máy chủ.`}
          tone={stats.publicNetCount > 0 ? WARN : undefined}
          locked={false}
        />
      </Panel>

      <Panel title="Máy chủ MCP" bodyClass="mcp-servers" label="Danh sách máy chủ MCP">
        {servers.isPending ? (
          <SkeletonLines rows={4} padding="12px 16px" />
        ) : servers.isError ? (
          <CardError error={servers.error} onRetry={() => void servers.refetch()} retrying={servers.isFetching} />
        ) : servers.data.length === 0 ? (
          <EmptyState icon="ph ph-plugs-connected" title="Chưa có máy chủ MCP nào" description={canManage ? 'Thêm máy chủ đầu tiên để agent có tool để gọi.' : 'Owner chưa thêm máy chủ nào.'} />
        ) : (
          servers.data.map((s) => (
            <ServerCard
              key={s.id}
              server={s}
              tools={(tools.data ?? []).filter((t) => t.server_id === s.id)}
              canManage={canManage}
              onEdit={() => setEditingServer(s)}
              onTest={setTestingTool}
            />
          ))
        )}
      </Panel>

      <GrantMatrix tools={tools.data ?? []} agents={agents} canManage={canManage} />

      <CallLogPanel calls={calls} />

      {addingServer ? <ServerFormDialog title="Thêm máy chủ MCP" onClose={() => setAddingServer(false)} /> : null}
      {editingServer ? <ServerFormDialog title={`Sửa ${editingServer.name}`} server={editingServer} onClose={() => setEditingServer(null)} /> : null}
      {testingTool ? <TestCallDialog tool={testingTool} agents={agents} onClose={() => setTestingTool(null)} /> : null}
    </div>
  );
}

function GuardRow({ label, hint, tone, locked = true }: { label: string; hint: string; tone?: string; locked?: boolean }) {
  return (
    <div className="mcp-guard-row">
      <div className="mcp-guard-row__head">
        <Icon name={locked ? 'ph ph-lock-simple' : 'ph ph-globe'} size={13} color={locked ? N5 : tone ?? N5} />
        <span className="mcp-guard-row__label">{label}</span>
        {locked ? <StateChip color={OK}>Khoá cứng</StateChip> : null}
      </div>
      <p className="mcp-guard-row__hint" style={tone ? { color: tone } : undefined}>
        {hint}
      </p>
    </div>
  );
}

function ServerCard({ server: s, tools, canManage, onEdit, onTest }: { server: McpServer; tools: McpTool[]; canManage: boolean; onEdit: () => void; onTest: (t: McpTool) => void }) {
  const update = useUpdateServer();
  const remove = useDeleteServer();
  const discover = useDiscoverTools();
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <article className="mcp-server" aria-label={s.name}>
      <div className="mcp-server__head">
        <Icon name="ph ph-plugs-connected" size={16} color={healthTone(s.health)} />
        <div className="mcp-server__title">
          <div className="mcp-server__name">{s.name}</div>
          <div className="mcp-server__kind">{TRANSPORT_LABEL[s.transport]} · {s.endpoint}</div>
        </div>
        <StateChip color={healthTone(s.health)} dot>
          {healthLabel(s.health)}
        </StateChip>
      </div>
      {s.note ? <p className="mcp-server__note">{s.note}</p> : null}
      <div className="mcp-server__meta">
        <span>{s.tool_count} tool · {s.exposed_count} đã mở</span>
        <span className="mcp-server__auth">
          <Icon name={s.has_auth ? 'ph ph-lock-key' : 'ph ph-lock-key-open'} size={12} />
          {s.has_auth ? 'Có xác thực' : 'Chưa có xác thực'}
        </span>
      </div>
      {canManage ? (
        <div className="mcp-server__switches">
          <Switch checked={s.is_enabled} label={`${s.is_enabled ? 'Tắt' : 'Bật'} máy chủ ${s.name}`} onChange={(v) => update.mutate({ id: s.id, body: { is_enabled: v } })} />
          <Switch
            checked={s.allow_public_network}
            label={`${s.allow_public_network ? 'Tắt' : 'Bật'} mạng công cộng cho ${s.name}`}
            onChange={(v) => update.mutate({ id: s.id, body: { allow_public_network: v } }, { onSuccess: () => v && toast('Đã cho phép ra mạng công cộng — cân nhắc rủi ro', 'warn') })}
          />
          <span className="mcp-server__switch-label">Mạng công cộng {s.allow_public_network ? <span style={{ color: WARN }}>đang bật</span> : 'đang tắt'}</span>
        </div>
      ) : null}
      <div className="mcp-server__foot">
        {canManage ? (
          <>
            <Button variant="secondary" className="btn-22" icon="ph ph-magnifying-glass" loading={discover.isPending} onClick={() => discover.mutate(s.id, { onSuccess: (r) => { const n = r.tools.filter((t) => t.is_new).length; toast(n ? `Tìm thấy ${n} tool mới — mặc định đóng` : 'Không có tool mới', 'ok'); } })}>
              Khám phá tool
            </Button>
            <Button variant="ghost" className="btn-22" icon="ph ph-pencil-simple" onClick={onEdit}>
              Sửa
            </Button>
            <Button variant="ghost" className="btn-22" icon="ph ph-trash" onClick={() => setConfirmRemove(true)}>
              Xoá
            </Button>
          </>
        ) : null}
      </div>
      {update.isError ? <InlineError>{errorText(update.error)}</InlineError> : null}

      {tools.length ? (
        <table className="mcp-tool-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Loại</th>
              <th>Mở</th>
              <th>Cấp cho</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <ToolRow key={t.id} tool={t} canManage={canManage} onTest={() => onTest(t)} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted-note" style={{ padding: '10px 15px' }}>
          Chưa khám phá tool nào — bấm &quot;Khám phá tool&quot;.
        </p>
      )}

      {confirmRemove ? (
        <Dialog
          open
          onClose={() => setConfirmRemove(false)}
          width={380}
          title={`Xoá máy chủ ${s.name}?`}
          actions={
            <>
              <Button variant="secondary" onClick={() => setConfirmRemove(false)}>
                Huỷ
              </Button>
              <Button variant="primary" loading={remove.isPending} onClick={() => remove.mutate(s.id, { onSuccess: () => setConfirmRemove(false) })}>
                Xoá máy chủ
              </Button>
            </>
          }
        >
          <p className="muted-note">Xoá cả tool và lượt cấp đã khai báo cho máy chủ này. Không xoá nhật ký đã ghi.</p>
          {remove.isError ? <InlineError>{errorText(remove.error)}</InlineError> : null}
        </Dialog>
      ) : null}
    </article>
  );
}

function ToolRow({ tool: t, canManage, onTest }: { tool: McpTool; canManage: boolean; onTest: () => void }) {
  const expose = useExposeTool();
  return (
    <tr data-tool={t.name} data-exposed={t.is_exposed ? '' : undefined}>
      <td className="mono">{t.name}</td>
      <td>
        <StateChip color={t.access === 'write' ? WARN : N5}>{ACCESS_LABEL[t.access]}</StateChip>
      </td>
      <td>
        {canManage ? (
          <Switch checked={t.is_exposed} disabled={expose.isPending} label={`${t.is_exposed ? 'Đóng' : 'Mở'} tool ${t.name}`} onChange={(v) => expose.mutate({ id: t.id, isExposed: v })} />
        ) : (
          <StateChip color={t.is_exposed ? OK : N5}>{t.is_exposed ? 'Đã mở' : 'Đóng'}</StateChip>
        )}
      </td>
      <td>{t.grants.length ? `${t.grants.length} agent` : <span style={{ color: N5 }}>Chưa cấp</span>}</td>
      <td>
        <Button variant="ghost" className="btn-22" icon="ph ph-play" onClick={onTest}>
          Gọi thử
        </Button>
      </td>
    </tr>
  );
}

function GrantMatrix({ tools, agents, canManage }: { tools: McpTool[]; agents: { key: string; label: string }[]; canManage: boolean }) {
  const grant = useGrantTool();
  const ungrant = useUngrantTool();
  if (!tools.length) return null;
  const sorted = [...tools].sort((a, b) => a.server_name.localeCompare(b.server_name) || a.name.localeCompare(b.name));
  return (
    <Panel title="Ma trận cấp quyền" kicker="Agent × tool — cấp quyền chỉ có hiệu lực khi tool đã được mở" bodyClass="mcp-matrix-wrap" label="Ma trận cấp quyền agent và tool">
      {!agents.length ? (
        <EmptyState icon="ph ph-users" title="Chưa có agent nào để cấp quyền" description="Tạo agent ở màn Danh tính Agent trước." />
      ) : (
        <table className="mcp-matrix">
          <thead>
            <tr>
              <th>Tool</th>
              {agents.map((a) => (
                <th key={a.key} title={a.label}>
                  {a.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => (
              <tr key={t.id}>
                <td className="mcp-matrix__tool">
                  <span className="mono">{t.name}</span>
                  <span className="mcp-matrix__server">{t.server_name}{t.is_exposed ? '' : ' · đóng'}</span>
                </td>
                {agents.map((a) => {
                  const on = t.grants.includes(a.key);
                  const busy = (grant.isPending && grant.variables?.id === t.id && grant.variables.agentKey === a.key) || (ungrant.isPending && ungrant.variables?.id === t.id && ungrant.variables.agentKey === a.key);
                  return (
                    <td key={a.key} className="mcp-matrix__cell">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!canManage || busy}
                        aria-label={`Cấp ${t.name} cho ${a.label}`}
                        onChange={(e) => (e.target.checked ? grant.mutate({ id: t.id, agentKey: a.key }) : ungrant.mutate({ id: t.id, agentKey: a.key }))}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function CallLogPanel({ calls }: { calls: ReturnType<typeof useMcpCalls> }) {
  return (
    <Panel title="Nhật ký gọi tool" kicker="Cập nhật LIVE — mọi lượt gọi, kể cả bị chặn, đều vào đây" bodyClass="mcp-log-wrap" label="Nhật ký gọi tool MCP">
      {calls.isPending ? (
        <SkeletonLines rows={5} padding="10px 16px" />
      ) : calls.isError ? (
        <CardError error={calls.error} onRetry={() => void calls.refetch()} retrying={calls.isFetching} />
      ) : calls.data.items.length === 0 ? (
        <EmptyState icon="ph ph-list-magnifying-glass" title="Chưa có lượt gọi nào" />
      ) : (
        <table className="mcp-log">
          <thead>
            <tr>
              <th>Thời gian</th>
              <th>Agent</th>
              <th>Tool</th>
              <th>Kết quả</th>
              <th>Độ trễ</th>
              <th>Chi tiết</th>
            </tr>
          </thead>
          <tbody>
            {calls.data.items.map((c) => (
              <tr key={c.id} data-outcome={c.outcome}>
                <td className="mono">{new Date(c.at).toLocaleTimeString('vi-VN')}</td>
                <td>{c.agent_key}</td>
                <td className="mono">{c.server_name} · {c.tool_name}</td>
                <td>
                  <StateChip color={outcomeTone(c.outcome)} dot>
                    {OUTCOME_LABEL[c.outcome]}
                  </StateChip>
                </td>
                <td className="mono">{fmtLatency(c.latency_ms)}</td>
                <td className="mcp-log__detail" title={c.result_summary}>
                  {c.result_summary}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ServerFormDialog({ title, server, onClose }: { title: string; server?: McpServer; onClose: () => void }) {
  const create = useCreateServer();
  const update = useUpdateServer();
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? 'http+sse');
  const [endpoint, setEndpoint] = useState(server?.endpoint ?? '');
  const [authToken, setAuthToken] = useState('');
  const [note, setNote] = useState(server?.note ?? '');
  const busy = create.isPending || update.isPending;
  const err = create.error ?? update.error;

  const submit = () => {
    if (!name.trim() || !endpoint.trim()) return;
    if (server) {
      const body: Record<string, unknown> = { name: name.trim(), endpoint: endpoint.trim(), note: note.trim() || null };
      if (authToken.trim()) body.auth_token = authToken.trim();
      update.mutate({ id: server.id, body }, { onSuccess: onClose });
    } else {
      const body: McpServerCreateBody = { name: name.trim(), transport, endpoint: endpoint.trim(), note: note.trim() || undefined, auth_token: authToken.trim() || undefined };
      create.mutate(body, { onSuccess: onClose });
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={440}
      title={title}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || !endpoint.trim()} onClick={submit}>
            {server ? 'Lưu' : 'Thêm máy chủ'}
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
        {!server ? (
          <SelectField label="Kiểu kết nối" value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)} options={TRANSPORTS.map((t) => ({ value: t, label: t }))} />
        ) : null}
        <TextField label="Endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="mcp://… hoặc https://…" />
        <TextField label={server ? 'Đổi xác thực (bỏ trống để giữ nguyên)' : 'Xác thực (tuỳ chọn)'} value={authToken} onChange={(e) => setAuthToken(e.target.value)} revealable autoComplete="off" />
        <TextField label="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        {err ? <InlineError>{errorText(err)}</InlineError> : null}
      </form>
    </Dialog>
  );
}

function TestCallDialog({ tool, agents, onClose }: { tool: McpTool; agents: { key: string; label: string }[]; onClose: () => void }) {
  const call = useCallTool();
  const [agentKey, setAgentKey] = useState(tool.grants[0] ?? agents[0]?.key ?? '');
  const [argsText, setArgsText] = useState('{}');
  const [argsError, setArgsError] = useState<string | null>(null);

  const submit = () => {
    let args: Record<string, unknown>;
    try {
      args = argsText.trim() ? JSON.parse(argsText) : {};
    } catch {
      setArgsError('Tham số phải là JSON hợp lệ');
      return;
    }
    setArgsError(null);
    call.mutate({ id: tool.id, body: { agent_key: agentKey, args } });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={420}
      title={`Gọi thử ${tool.name}`}
      kicker={`${tool.server_name} · ${ACCESS_LABEL[tool.access]}`}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
          <Button variant="primary" loading={call.isPending} disabled={!agentKey} onClick={submit}>
            Gọi tool
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
        {agents.length === 0 ? (
          <p className="muted-note">Chưa có agent nào — tạo ở màn Danh tính Agent trước.</p>
        ) : (
          <SelectField label="Gọi nhân danh agent" value={agentKey} onChange={(e) => setAgentKey(e.target.value)} options={agents.map((a) => ({ value: a.key, label: a.label }))} />
        )}
        <div className="gh-field">
          <label className="gh-field__label" htmlFor="mcp-test-args">
            Tham số (JSON)
          </label>
          <textarea id="mcp-test-args" className="gh-input mono" rows={3} value={argsText} onChange={(e) => setArgsText(e.target.value)} spellCheck={false} />
        </div>
        {argsError ? <InlineError>{argsError}</InlineError> : null}
        {call.isError ? <InlineError>{errorText(call.error)}</InlineError> : null}
        {call.isSuccess ? (
          <div className="mcp-test-result" data-outcome={call.data.outcome}>
            <StateChip color={outcomeTone(call.data.outcome)} dot>
              {OUTCOME_LABEL[call.data.outcome]}
            </StateChip>
            <span>{call.data.outcome === 'ok' ? JSON.stringify(call.data.result) : call.data.call.result_summary}</span>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
