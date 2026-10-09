import { useEffect, useState } from 'react';
import type { HubLink, HubLinkTestResult } from '@gen-harness/contracts';
import { Button, Icon, Switch, TextField } from '@gen-harness/ui';
import { errorText } from '../../lib/errorText';
import { useMe } from '../../lib/queries';
import { CardError, FriendlyErrorText, InlineError, Panel, SkeletonLines } from '../common';
import { ConnectionStatusPill } from '../connections/ConnectionStatusPill';
import { hubStatus } from '../connections/connectionsModel';
import {
  HUB_BREAKER_STRIP,
  HUB_STATUS_LABEL,
  PUBLIC_NET_HINT,
  SCOPES_READ_ONLY_TEXT,
  expiryToIso,
  hubStatusTone,
  isPublicHttpsUrl,
  isoToDay,
  scopeRows,
  scopesMessage,
} from './mcpModel';
import { useHubLink, useTestHubLink, useUpdateHubLink } from './queries';

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN') : '—');

/**
 * v0.1.42 (F-61): thẻ này chỉ render ở Kết nối (/connections#genhub) — MCP Hub chỉ còn dòng liên kết tới đây.
 * Gen-hub (v0.1.26, docs/design/gen-hub-link.md §3): Gen đọc Kho Ryan qua Gen-hub — chỉ đọc, chỉ Sếp (Owner).
 * Token là ô CHỈ GHI: API không bao giờ trả lại (chỉ biết "đã lưu"). Liên kết tắt tới khi bấm "Kiểm tra" xanh;
 * đổi địa chỉ/token thì tắt lại, phải kiểm tra lại. Lưu / Kiểm tra cần PIN (`hub.link`), ghi Nhật ký hành động.
 * v0.1.39 (F-31): gõ địa chỉ https công khai → công tắc "mạng công cộng" bật sẵn (Owner vẫn bỏ được); "Kiểm tra" khi
 * còn thay đổi chưa lưu = lưu rồi kiểm tra luôn (một lần PIN — phiên PIN của lần lưu phủ lần kiểm tra).
 * v0.1.49 (QD-16): khối "Quyền đọc thêm (tuỳ chọn)" — lịch, mail, việc, Drive (Gen chỉ đọc); sau Kiểm tra báo quyền còn
 * thiếu (không làm Kiểm tra đỏ); bộ ngắt F-83 đang mở ⇒ dải "Gen-hub tạm không trả lời".
 */
export function HubLinkCard() {
  const me = useMe();
  const isOwner = me.data?.role?.code === 'owner';
  const link = useHubLink();
  return (
    <Panel
      title="Gen-hub — Gen đọc Kho tri thức"
      kicker={
        link.data ? (
          <>
            <span style={{ color: hubStatusTone(link.data.status) }}>{HUB_STATUS_LABEL[link.data.status]}</span> · chỉ đọc · chỉ Sếp · tắt tới khi
            Kiểm tra xanh
          </>
        ) : (
          'Chỉ đọc · chỉ Sếp · tắt tới khi Kiểm tra xanh'
        )
      }
      label="Gen-hub"
      genTarget="mcp.hub_link"
      bodyClass="hub-link"
      aside={link.data ? <ConnectionStatusPill status={hubStatus(link.data)} /> : undefined}
    >
      {link.isPending ? (
        <SkeletonLines rows={3} padding="0" />
      ) : link.isError ? (
        <CardError error={link.error} onRetry={() => void link.refetch()} retrying={link.isFetching} />
      ) : (
        <HubLinkBody link={link.data} isOwner={isOwner} />
      )}
    </Panel>
  );
}

function HubLinkBody({ link, isOwner }: { link: HubLink; isOwner: boolean }) {
  const update = useUpdateHubLink();
  const test = useTestHubLink();
  const [endpoint, setEndpoint] = useState(link.endpoint ?? '');
  const [token, setToken] = useState('');
  const [expiry, setExpiry] = useState(isoToDay(link.token_expires_at));
  const [publicNet, setPublicNet] = useState(link.allow_public_network);
  // Owner đã tự bấm công tắc → không tự bật/tắt theo địa chỉ nữa.
  const [publicTouched, setPublicTouched] = useState(false);
  const [publicAuto, setPublicAuto] = useState(false);
  useEffect(() => {
    setEndpoint(link.endpoint ?? '');
    setExpiry(isoToDay(link.token_expires_at));
    setPublicNet(link.allow_public_network);
    setPublicAuto(false);
  }, [link.endpoint, link.token_expires_at, link.allow_public_network]);
  const onEndpoint = (v: string) => {
    setEndpoint(v);
    if (!publicTouched) {
      const pub = isPublicHttpsUrl(v);
      setPublicNet(pub);
      setPublicAuto(pub);
    }
  };
  const onPublic = (on: boolean) => {
    setPublicTouched(true);
    setPublicAuto(false);
    setPublicNet(on);
  };

  const firstTime = !link.configured;
  const valid = /^https?:\/\/\S+$/.test(endpoint.trim()) && (!firstTime || token.trim().length >= 8) && (!token.trim() || token.trim().length >= 8);
  const dirty =
    endpoint.trim() !== (link.endpoint ?? '') || token.trim() !== '' || expiry !== isoToDay(link.token_expires_at) || publicNet !== link.allow_public_network;

  const buildBody = () => {
    const body: Parameters<typeof update.mutate>[0] = {};
    if (endpoint.trim() !== (link.endpoint ?? '')) body.endpoint = endpoint.trim();
    if (token.trim()) body.token = token.trim();
    if (expiry !== isoToDay(link.token_expires_at)) body.token_expires_at = expiryToIso(expiry);
    if (publicNet !== link.allow_public_network) body.allow_public_network = publicNet;
    return body;
  };
  const save = () => {
    if (!valid || !dirty) return;
    update.mutate(buildBody(), { onSuccess: () => setToken('') });
  };
  // "Kiểm tra" khi còn thay đổi: lưu trước rồi kiểm tra (lỗi lưu hiện ở dòng lỗi lưu, không kiểm tra).
  const saveAndTest = async () => {
    if (dirty) {
      if (!valid) return;
      try {
        await update.mutateAsync(buildBody());
      } catch {
        return;
      }
      setToken('');
    }
    test.mutate();
  };
  const result = test.data;
  const blocked = result && !result.ok && result.error_code === 'MCP_NETWORK_BLOCKED';

  return (
    <>
      <dl className="jev-dl">
        <dt>Địa chỉ</dt>
        <dd className="mono">{link.endpoint ?? 'Chưa nối'}</dd>
        <dt>Token</dt>
        <dd>
          <Icon name={link.has_token ? 'ph ph-lock-key' : 'ph ph-lock-key-open'} size={12} /> {link.has_token ? 'Đã lưu (mã hoá, không hiện lại)' : 'Chưa có'}
        </dd>
        <dt>Hạn token</dt>
        <dd>{link.token_expires_at ? `${isoToDay(link.token_expires_at)} · còn ${link.days_left ?? 0} ngày` : 'Chưa nhập'}</dd>
        <dt>Kiểm tra xanh gần nhất</dt>
        <dd>{fmtTime(link.last_ok_at)}</dd>
        {link.last_error ? (
          <>
            <dt>Lỗi gần nhất</dt>
            <dd style={{ color: 'var(--color-bad)' }}>{link.last_error}</dd>
          </>
        ) : null}
      </dl>

      {link.breaker?.open === true ? (
        <p className="hub-breaker" role="note" data-testid="hub-breaker">
          <Icon name="ph ph-warning" size={12} /> {HUB_BREAKER_STRIP}
        </p>
      ) : null}

      {isOwner ? (
        <form
          className="jev-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <TextField label="Địa chỉ Gen-hub" value={endpoint} onChange={(e) => onEndpoint(e.target.value)} placeholder="https://hub.genos.top/mcp" className="mono" />
          <TextField
            label={link.has_token ? 'Token mới (bỏ trống để giữ token đã lưu)' : 'Token Gen-hub'}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Dán token agent gen-harness-… tạo trong Gen-hub"
            data-gen-target="mcp.hub_link.token"
          />
          <TextField label="Ngày hết hạn token" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} hint="Token thủ công của Gen-hub hết hạn sau 90 ngày — Gen nhắc Sếp trước 14 ngày." />
          <div className="triage-row">
            <Switch checked={publicNet} label="Cho phép Gen-hub ở mạng công cộng" onChange={onPublic} />
            <span>Gen-hub ở Internet (mạng công cộng) — chỉ bật cho máy chủ này</span>
          </div>
          {publicAuto && publicNet ? (
            <p className="muted-note hub-public-note" role="note">
              <Icon name="ph ph-globe" size={12} /> Đã bật sẵn vì địa chỉ là https công khai — Gen-hub sẽ được gọi qua Internet. Bỏ tích nếu Gen-hub nằm trong mạng nội bộ.
            </p>
          ) : null}
          <div className="jev-actions">
            <Button variant="primary" type="submit" className="btn-27" icon="ph ph-floppy-disk" disabled={!valid || !dirty} loading={update.isPending}>
              Lưu
            </Button>
            <Button
              variant="secondary"
              type="button"
              className="btn-27"
              icon="ph ph-pulse"
              data-main-action
              disabled={dirty ? !valid : !link.configured}
              loading={test.isPending || (update.isPending && dirty)}
              data-gen-target="mcp.hub_link.test"
              onClick={() => void saveAndTest()}
            >
              {dirty ? 'Lưu & kiểm tra' : 'Kiểm tra'}
            </Button>
            {link.enabled ? (
              <Button variant="ghost" type="button" className="btn-27" loading={update.isPending && update.variables?.enabled === false} onClick={() => update.mutate({ enabled: false })}>
                Tắt
              </Button>
            ) : null}
          </div>
          {update.isError ? <InlineError>{errorText(update.error)}</InlineError> : null}
          {test.isError ? <InlineError>{errorText(test.error)}</InlineError> : null}
          {result ? (
            <div className={result.ok ? 'apm-test-result apm-test-result--ok' : 'apm-test-result apm-test-result--bad'} role="status">
              {result.ok ? (
                `Đã nối Kho · ${result.latency_ms} ms · mở ${result.exposed_tools.length} tool đọc cho Gen`
              ) : (
                <>
                  <FriendlyErrorText raw={blocked ? PUBLIC_NET_HINT : result.error} fallback="Chưa kết nối được Gen-hub — kiểm tra địa chỉ và thẻ truy cập." />
                  {result.error_code ? (
                    <details className="tech-detail">
                      <summary>Chi tiết kỹ thuật</summary>
                      <code>Mã lỗi {result.error_code}</code>
                    </details>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
          <ReadScopes link={link} result={result} />
          {/* v0.1.28 (UX V14): từng bước bằng lời thường, không tên riêng. */}
          <ol className="muted-note hub-steps">
            <li>Mở Gen-hub, vào mục tạo trợ lý mới, đặt tên có tên công ty (ví dụ gen-harness-congty).</li>
            <li>
              Chọn thời hạn thẻ truy cập 90 ngày. Bật quyền ĐỌC Kho (tóm tắt, tìm, xem một mục) và (tuỳ chọn) quyền đọc lịch, đọc mail, đọc việc, tìm Drive —
              KHÔNG bật quyền ghi.
            </li>
            <li>Chép thẻ truy cập (token) vừa tạo, dán vào ô trên rồi bấm Kiểm tra.</li>
          </ol>
          <p className="muted-note">Nội dung Kho được che số tài khoản, SĐT, email, khoá trước khi gửi cho AI.</p>
        </form>
      ) : (
        <p className="muted-note">Chỉ Sếp (Owner) cấu hình và dùng Gen-hub.</p>
      )}
    </>
  );
}

/**
 * v0.1.49 (QD-16): "Quyền đọc thêm (tuỳ chọn)" — 4 dòng Có / Chưa / Chưa kiểm lấy từ lần Kiểm tra vừa xong
 * (`test.data.read_scopes`) hoặc, chưa bấm, từ lần kiểm gần nhất máy chủ nhớ (`link.read_scopes`). Thiếu quyền đọc chỉ là
 * lời nhắc — không làm Kiểm tra đỏ. Mọi giá trị từ máy chủ được kiểm kiểu trước khi hiện (chỉ chuỗi / boolean).
 */
function ReadScopes({ link, result }: { link: HubLink; result: HubLinkTestResult | undefined }) {
  const scopes = result?.read_scopes ?? link.read_scopes;
  const rows = scopeRows(scopes);
  // Kiểm tra vừa đỏ (không nối được) thì chưa nói gì về quyền; còn lại: lần Kiểm tra vừa xong, hoặc lần kiểm gần nhất.
  const msg = result ? (result.ok ? scopesMessage(result.read_missing, scopes) : null) : scopesMessage(undefined, scopes);
  const writeTools = result && Array.isArray(result.write_tools) ? result.write_tools.filter((t): t is string => typeof t === 'string' && t !== '') : [];
  return (
    <div className="hub-scopes" data-testid="hub-scopes">
      <p className="hub-scopes__title">Quyền đọc thêm (tuỳ chọn)</p>
      <ul className="hub-scopes__list">
        {rows.map((r) => (
          <li key={r.key} className="hub-scopes__row" data-has={r.state === 'unknown' ? undefined : r.state}>
            <span className="hub-scopes__name">{r.label}</span>
            <span className="hub-scopes__val">{r.text}</span>
          </li>
        ))}
      </ul>
      {msg ? (
        <p className="hub-scopes__msg" data-tone={msg.tone} role="note">
          {msg.text}
        </p>
      ) : null}
      {writeTools.length > 0 ? (
        <p className="hub-scopes__msg" data-tone="warn" role="note">
          Token đang có thêm quyền GHI ({writeTools.join(', ')}) — Gen không bao giờ dùng, nên tắt các quyền này trong Gen-hub.
        </p>
      ) : null}
      <p className="muted-note">{SCOPES_READ_ONLY_TEXT}</p>
    </div>
  );
}
