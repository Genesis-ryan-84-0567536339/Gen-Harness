import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DirGroup, DirHeatBand, DirPerson, DirPriority, DirRelation, DirValueBand } from '@gen-harness/contracts';
import { Bar, CardError, InlineError, ScreenHead, SkeletonLines } from '../common';
import { Button, Dialog, EmptyState, Icon, Tabs, type FilterOption, type TabItem } from '@gen-harness/ui';
import { errorText } from '../../lib/errorText';
import { fmtInt } from '../../lib/format';
import { useUrlState } from '../../lib/uiStore';
import {
  CHANNEL_LABEL,
  CHANNEL_STATE_LABEL,
  GROUP_KIND_LABEL,
  HEAT_FILTER_LABEL,
  LISTEN_MODE_LABEL,
  PRIORITY_LABEL,
  RELATION_LABEL,
  VALUE_FILTER_LABEL,
  channelIcon,
  channelTone,
  fmtVnd,
  heatTone,
  initialsOf,
  listenModeTone,
  priorityTone,
} from './relationsModel';
import { useDirChannels, useDirGroups, useDirPeople, useSetGroupBot, useSetPersonBot } from './queries';

/** Đội ngũ agent tạm để gán BOT — chưa có màn Danh tính Agent (giai đoạn 4), giống TEAMMATES của Hộp thư ý nghĩa. */
const AGENTS = [
  { id: 'agent-tls', name: 'Trợ lý thương mại' },
  { id: 'agent-ka', name: 'Key Account junior' },
  { id: 'agent-hc', name: 'Admin hậu cần' },
  { id: 'agent-thk', name: 'Thư ký cá nhân' },
];

type DirTab = 'groups' | 'people';

export function DirectoryScreen() {
  const [tab, setTab] = useUrlState<DirTab>('dt', 'groups');
  const items: TabItem<DirTab>[] = [
    { key: 'groups', label: 'Nhóm theo kênh' },
    { key: 'people', label: 'Con người' },
  ];
  return (
    <div className="screen">
      <ScreenHead
        title="Nhóm & Con người"
        description="Danh sách nhóm tách theo từng kênh, và danh sách con người lọc được theo mức liên quan với Sếp, độ nhiệt, giá trị và mức ưu tiên — từ đó gán agent trực tương ứng."
        maxWidth={760}
        actions={<Tabs items={items} value={tab} onChange={setTab} label="Tab nhóm & con người" idPrefix="dir-tab" />}
      />
      {tab === 'groups' ? <GroupsPane /> : <PeoplePane />}
    </div>
  );
}

function GroupsPane() {
  const channels = useDirChannels();
  const groups = useDirGroups({});
  const [botFor, setBotFor] = useState<DirGroup | null>(null);

  if (channels.isPending || groups.isPending) return <SkeletonLines rows={6} />;
  if (channels.isError) return <CardError error={channels.error} onRetry={() => void channels.refetch()} retrying={channels.isFetching} />;
  if (groups.isError) return <CardError error={groups.error} onRetry={() => void groups.refetch()} retrying={groups.isFetching} />;
  if (channels.data.length === 0) return <EmptyState icon="ph ph-broadcast" title="Chưa có kênh nào kết nối" />;

  const byChannel = (type: string) => groups.data.items.filter((g) => g.channel.type === type);

  return (
    <div className="dir-groups">
      {channels.data.map((ch) => {
        const rows = byChannel(ch.type);
        return (
          <section className="gh-card" key={ch.id} aria-label={CHANNEL_LABEL[ch.type] ?? ch.type}>
            <div className="gh-card__header">
              <div className="dir-ch-head">
                <span className="dir-ch-head__icon" style={{ color: channelTone(ch.type) }}>
                  <Icon name={channelIcon(ch.type)} size={15} />
                </span>
                <div>
                  <div className="gh-card__title">{CHANNEL_LABEL[ch.type] ?? ch.type}</div>
                  <div className="gh-card__kicker">
                    {fmtInt(ch.group_count)} nhóm · {fmtInt(ch.events_24h)} tin trong 24 giờ
                  </div>
                </div>
                {ch.state ? (
                  <span className="state-chip" style={{ color: channelTone(ch.type), borderColor: channelTone(ch.type) }}>
                    <span className="state-chip__dot" style={{ background: channelTone(ch.type) }} />
                    {CHANNEL_STATE_LABEL[ch.state] ?? ch.state}
                  </span>
                ) : null}
              </div>
            </div>
            {rows.length === 0 ? (
              <EmptyState icon="ph ph-users-three" title="Chưa có nhóm nào trên kênh này" />
            ) : (
              <div className="gh-table-scroll">
                <table className="gh-table w920" aria-label={`Nhóm kênh ${CHANNEL_LABEL[ch.type] ?? ch.type}`}>
                  <thead>
                    <tr>
                      <th style={{ width: 118 }}>ID nhóm</th>
                      <th>Tên nhóm</th>
                      <th style={{ width: 96 }}>Loại</th>
                      <th style={{ width: 90 }}>Thành viên</th>
                      <th style={{ width: 80 }}>Tin 24h</th>
                      <th style={{ width: 110 }}>Độ nhiệt</th>
                      <th style={{ width: 150 }}>Chế độ nghe</th>
                      <th style={{ width: 170 }}>Agent trực</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((g) => (
                      <tr key={g.id}>
                        <td className="td-id">{g.code}</td>
                        <td>{g.name}</td>
                        <td>
                          <span className="mono-tag">{GROUP_KIND_LABEL[g.kind] ?? g.kind}</span>
                        </td>
                        <td className="td-id">{fmtInt(g.member_count)}</td>
                        <td className="td-id">{fmtInt(g.events_24h)}</td>
                        <td>
                          {g.heat !== null ? <Bar pct={g.heat} tone={heatTone(g.heat)} width={64} /> : <span className="td-id">—</span>}
                          {g.heat !== null ? <span style={{ marginLeft: 8, color: heatTone(g.heat), fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{fmtInt(g.heat)}</span> : null}
                        </td>
                        <td>
                          <span className="mono-tag" style={{ color: listenModeTone(g.listen_mode) }}>
                            {LISTEN_MODE_LABEL[g.listen_mode]}
                          </span>
                        </td>
                        <td>
                          <div className="dir-bot-cell">
                            <span className="dir-bot-cell__name">{g.bot ? g.bot.name : 'Chưa gán'}</span>
                            <Button variant="ghost" size="sm" onClick={() => setBotFor(g)}>
                              Đổi
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
      {botFor ? <GroupBotDialog group={botFor} onClose={() => setBotFor(null)} /> : null}
    </div>
  );
}

function GroupBotDialog({ group, onClose }: { group: DirGroup; onClose: () => void }) {
  const setBot = useSetGroupBot();
  const [agentId, setAgentId] = useState(group.bot?.id ?? '');
  return (
    <Dialog
      open
      onClose={onClose}
      width={400}
      title="Gán BOT trực nhóm"
      kicker={group.name}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            variant="primary"
            icon="ph ph-robot"
            loading={setBot.isPending}
            onClick={() => setBot.mutate({ id: group.id, body: { agent_id: agentId || null } }, { onSuccess: onClose })}
          >
            Lưu
          </Button>
        </>
      }
    >
      <div className="dlg-list" role="list">
        <button type="button" className="sv-open" aria-pressed={agentId === ''} onClick={() => setAgentId('')}>
          <span className="sv-open__name">Chưa gán</span>
          {agentId === '' ? <Icon name="ph ph-check" size={14} /> : null}
        </button>
        {AGENTS.map((a) => (
          <button key={a.id} type="button" className="sv-open" aria-pressed={agentId === a.id} onClick={() => setAgentId(a.id)}>
            <span className="sv-open__name">{a.name}</span>
            {agentId === a.id ? <Icon name="ph ph-check" size={14} /> : null}
          </button>
        ))}
      </div>
      {setBot.isError ? <InlineError>{errorText(setBot.error)}</InlineError> : null}
    </Dialog>
  );
}

const REL_OPTIONS: FilterOption<string>[] = [
  { value: '', label: 'Tất cả' },
  { value: 'direct', label: RELATION_LABEL.direct },
  { value: 'via_staff', label: RELATION_LABEL.via_staff },
  { value: 'stranger', label: RELATION_LABEL.stranger },
];
const HEAT_OPTIONS: FilterOption<string>[] = [{ value: '', label: 'Tất cả' }, ...(['high', 'mid', 'cold'] as DirHeatBand[]).map((v) => ({ value: v, label: HEAT_FILTER_LABEL[v] }))];
const VALUE_OPTIONS: FilterOption<string>[] = [{ value: '', label: 'Tất cả' }, ...(['high', 'mid', 'unknown'] as DirValueBand[]).map((v) => ({ value: v, label: VALUE_FILTER_LABEL[v] }))];
const PRIORITY_OPTIONS: FilterOption<string>[] = [{ value: '', label: 'Tất cả' }, ...(['P1', 'P2', 'P3'] as DirPriority[]).map((v) => ({ value: v, label: PRIORITY_LABEL[v] }))];
const BOT_OPTIONS: FilterOption<string>[] = [
  { value: '', label: 'Tất cả' },
  { value: 'assigned', label: 'Đã gán' },
  { value: 'unassigned', label: 'Chưa gán' },
];

function PeoplePane() {
  const [relation, setRelation] = useUrlState<string>('rel', '');
  const [heat, setHeat] = useUrlState<string>('heat', '');
  const [value, setValue] = useUrlState<string>('val', '');
  const [priority, setPriority] = useUrlState<string>('pri', '');
  const [bot, setBot] = useUrlState<string>('bot', '');
  const query = useMemo(
    () => ({
      relation: (relation || undefined) as DirRelation | undefined,
      heat: (heat || undefined) as DirHeatBand | undefined,
      value: (value || undefined) as DirValueBand | undefined,
      priority: (priority || undefined) as DirPriority | undefined,
      bot: (bot || undefined) as 'assigned' | 'unassigned' | undefined,
    }),
    [relation, heat, value, priority, bot],
  );
  const people = useDirPeople(query);
  const [botFor, setBotFor] = useState<DirPerson | null>(null);
  const [bulk, setBulk] = useState(false);

  return (
    <div className="dir-people">
      <div className="dir-filters">
        <FilterRow label="Liên quan Sếp" value={relation} onChange={setRelation} options={REL_OPTIONS} />
        <FilterRow label="Độ nhiệt" value={heat} onChange={setHeat} options={HEAT_OPTIONS} />
        <FilterRow label="Giá trị" value={value} onChange={setValue} options={VALUE_OPTIONS} />
        <FilterRow label="Ưu tiên" value={priority} onChange={setPriority} options={PRIORITY_OPTIONS} />
        <FilterRow label="BOT" value={bot} onChange={setBot} options={BOT_OPTIONS} />
        <span className="dir-filters__spacer" />
        <div className="dir-filters__actions">
          {people.data ? <span className="raw-count">{fmtInt(people.data.total)} người khớp</span> : null}
          <Button variant="primary" icon="ph ph-robot" disabled={!people.data?.items.length} onClick={() => setBulk(true)}>
            Thiết lập BOT cho nhóm đã lọc
          </Button>
        </div>
      </div>

      <div className="table-card">
        {people.isPending ? (
          <SkeletonLines rows={6} />
        ) : people.isError ? (
          <CardError error={people.error} onRetry={() => void people.refetch()} retrying={people.isFetching} />
        ) : people.data.items.length === 0 ? (
          <EmptyState icon="ph ph-address-book" title="Không có ai khớp bộ lọc" />
        ) : (
          <div className="gh-table-scroll">
            <table className="gh-table w920" aria-label="Con người">
              <thead>
                <tr>
                  <th style={{ width: 100 }}>ID người</th>
                  <th>Con người</th>
                  <th style={{ width: 64 }}>Kênh</th>
                  <th style={{ width: 150 }}>Liên quan Sếp</th>
                  <th style={{ width: 120 }}>Độ nhiệt</th>
                  <th style={{ width: 120 }}>Giá trị</th>
                  <th style={{ width: 80 }}>Ưu tiên</th>
                  <th style={{ width: 190 }}>BOT phụ trách</th>
                  <th style={{ width: 90 }}>Tự trị</th>
                </tr>
              </thead>
              <tbody>
                {people.data.items.map((p) => (
                  <tr key={p.id}>
                    <td className="td-id">{p.code}</td>
                    <td>
                      <div className="dir-person-cell">
                        <span className="dir-person-cell__av">{initialsOf(p.name)}</span>
                        <div style={{ minWidth: 0 }}>
                          <Link to={`/profile?id=${encodeURIComponent(p.id)}`} className="dir-person-cell__name">
                            {p.name}
                          </Link>
                          {p.org_name ? <div className="dir-person-cell__org">{p.org_name}</div> : null}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="dir-ch-icons">
                        {p.channels.map((c) => (
                          <Icon key={c} name={channelIcon(c)} size={13} color={channelTone(c)} label={CHANNEL_LABEL[c] ?? c} />
                        ))}
                      </span>
                    </td>
                    <td>
                      <span className="mono-tag">{RELATION_LABEL[p.relation]}</span>
                    </td>
                    <td>
                      {p.heat !== null ? (
                        <>
                          <Bar pct={p.heat} tone={heatTone(p.heat)} width={56} />
                          <span style={{ marginLeft: 8, color: heatTone(p.heat), fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{fmtInt(p.heat)}</span>
                        </>
                      ) : (
                        <span className="td-id">—</span>
                      )}
                    </td>
                    <td className="td-id">{fmtVnd(p.value_vnd)}</td>
                    <td>
                      <span style={{ color: priorityTone(p.priority), fontFamily: 'var(--font-mono)', fontSize: 11 }}>{p.priority}</span>
                    </td>
                    <td>
                      <div className="dir-bot-cell">
                        <span className="dir-bot-cell__name">{p.bot ? p.bot.name : 'Chưa gán'}</span>
                        <Button variant="ghost" size="sm" onClick={() => setBotFor(p)}>
                          Đổi
                        </Button>
                      </div>
                    </td>
                    <td className="td-id">{p.autonomy_level !== null ? `mức ${p.autonomy_level}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {botFor ? <PersonBotDialog person={botFor} onClose={() => setBotFor(null)} /> : null}
      {bulk ? <BulkBotDialog ids={people.data?.items.map((p) => p.id) ?? []} onClose={() => setBulk(false)} /> : null}
    </div>
  );
}

function FilterRow({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: FilterOption<string>[] }) {
  return (
    <div className="dir-filter-row">
      <span className="dir-filter-row__label">{label}</span>
      <div className="dir-filter-row__opts" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" className="dir-filter-row__opt" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AutonomySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="dlg-fields">
      <span className="dir-filter-row__label">Mức tự trị (không bắt buộc)</span>
      <div className="dir-filter-row__opts" role="group" aria-label="Mức tự trị">
        <button type="button" className="dir-filter-row__opt" aria-pressed={value === ''} onClick={() => onChange('')}>
          Giữ nguyên
        </button>
        {Array.from({ length: 7 }, (_, i) => String(i)).map((n) => (
          <button key={n} type="button" className="dir-filter-row__opt" aria-pressed={value === n} onClick={() => onChange(n)}>
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

function PersonBotDialog({ person, onClose }: { person: DirPerson; onClose: () => void }) {
  const setBot = useSetPersonBot();
  const [agentId, setAgentId] = useState(person.bot?.id ?? '');
  const [autonomy, setAutonomy] = useState(person.autonomy_level !== null ? String(person.autonomy_level) : '');
  return (
    <Dialog
      open
      onClose={onClose}
      width={400}
      title="Thiết lập BOT + tự trị"
      kicker={person.name}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            variant="primary"
            icon="ph ph-robot"
            loading={setBot.isPending}
            onClick={() =>
              setBot.mutate(
                { id: person.id, body: { agent_id: agentId || null, ...(autonomy !== '' ? { autonomy_level: Number(autonomy) } : {}) } },
                { onSuccess: onClose },
              )
            }
          >
            Lưu
          </Button>
        </>
      }
    >
      <div className="dlg-fields">
        <div className="dlg-list" role="list">
          <button type="button" className="sv-open" aria-pressed={agentId === ''} onClick={() => setAgentId('')}>
            <span className="sv-open__name">Chưa gán</span>
            {agentId === '' ? <Icon name="ph ph-check" size={14} /> : null}
          </button>
          {AGENTS.map((a) => (
            <button key={a.id} type="button" className="sv-open" aria-pressed={agentId === a.id} onClick={() => setAgentId(a.id)}>
              <span className="sv-open__name">{a.name}</span>
              {agentId === a.id ? <Icon name="ph ph-check" size={14} /> : null}
            </button>
          ))}
        </div>
        <AutonomySelect value={autonomy} onChange={setAutonomy} />
        {setBot.isError ? <InlineError>{errorText(setBot.error)}</InlineError> : null}
      </div>
    </Dialog>
  );
}

function BulkBotDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const setBot = useSetPersonBot();
  const [agentId, setAgentId] = useState('');
  const [autonomy, setAutonomy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const id of ids) {
        // tuần tự (không await-in-loop song song) để không vượt giới hạn tốc độ API mock
        await setBot.mutateAsync({ id, body: { agent_id: agentId || null, ...(autonomy !== '' ? { autonomy_level: Number(autonomy) } : {}) } });
      }
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={400}
      title="Thiết lập BOT cho nhóm đã lọc"
      kicker={`${ids.length} người đang khớp bộ lọc hiện tại`}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" icon="ph ph-robot" loading={busy} disabled={!ids.length} onClick={() => void apply()}>
            Áp dụng cho {ids.length} người
          </Button>
        </>
      }
    >
      <div className="dlg-fields">
        <div className="dlg-list" role="list">
          <button type="button" className="sv-open" aria-pressed={agentId === ''} onClick={() => setAgentId('')}>
            <span className="sv-open__name">Chưa gán (gỡ BOT)</span>
            {agentId === '' ? <Icon name="ph ph-check" size={14} /> : null}
          </button>
          {AGENTS.map((a) => (
            <button key={a.id} type="button" className="sv-open" aria-pressed={agentId === a.id} onClick={() => setAgentId(a.id)}>
              <span className="sv-open__name">{a.name}</span>
              {agentId === a.id ? <Icon name="ph ph-check" size={14} /> : null}
            </button>
          ))}
        </div>
        <AutonomySelect value={autonomy} onChange={setAutonomy} />
        {error ? <InlineError>{errorText(error)}</InlineError> : null}
      </div>
    </Dialog>
  );
}

