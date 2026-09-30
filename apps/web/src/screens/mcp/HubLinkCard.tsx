import { useEffect, useState } from 'react';
import type { HubLink } from '@gen-harness/contracts';
import { Button, Icon, Switch, TextField } from '@gen-harness/ui';
import { errorText } from '../../lib/errorText';
import { useMe } from '../../lib/queries';
import { CardError, FriendlyErrorText, InlineError, Panel, SkeletonLines, StateChip } from '../common';
import { HUB_STATUS_LABEL, expiryToIso, hubStatusTone, isoToDay } from './mcpModel';
import { useHubLink, useTestHubLink, useUpdateHubLink } from './queries';

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN') : '—');

/**
 * Gen-hub (v0.1.26, docs/design/gen-hub-link.md §3): Gen đọc Kho Ryan qua Gen-hub — chỉ đọc, chỉ Sếp (Owner).
 * Token là ô CHỈ GHI: API không bao giờ trả lại (chỉ biết "đã lưu"). Liên kết tắt tới khi bấm "Kiểm tra" xanh;
 * đổi địa chỉ/token thì tắt lại, phải kiểm tra lại. Lưu / Kiểm tra cần PIN (`hub.link`), ghi Nhật ký hành động.
 */
export function HubLinkCard() {
  const me = useMe();
  const isOwner = me.data?.role?.code === 'owner';
  const link = useHubLink();
  return (
    <Panel
      title="Gen-hub — Gen đọc Kho tri thức"
      kicker="Chỉ đọc · chỉ Sếp · tắt tới khi Kiểm tra xanh"
      label="Gen-hub"
      genTarget="mcp.hub_link"
      bodyClass="hub-link"
      aside={link.data ? <StateChip color={hubStatusTone(link.data.status)} dot>{HUB_STATUS_LABEL[link.data.status]}</StateChip> : undefined}
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
  useEffect(() => {
    setEndpoint(link.endpoint ?? '');
    setExpiry(isoToDay(link.token_expires_at));
    setPublicNet(link.allow_public_network);
  }, [link.endpoint, link.token_expires_at, link.allow_public_network]);

  const firstTime = !link.configured;
  const valid = /^https?:\/\/\S+$/.test(endpoint.trim()) && (!firstTime || token.trim().length >= 8) && (!token.trim() || token.trim().length >= 8);
  const dirty =
    endpoint.trim() !== (link.endpoint ?? '') || token.trim() !== '' || expiry !== isoToDay(link.token_expires_at) || publicNet !== link.allow_public_network;

  const save = () => {
    if (!valid || !dirty) return;
    const body: Parameters<typeof update.mutate>[0] = {};
    if (endpoint.trim() !== (link.endpoint ?? '')) body.endpoint = endpoint.trim();
    if (token.trim()) body.token = token.trim();
    if (expiry !== isoToDay(link.token_expires_at)) body.token_expires_at = expiryToIso(expiry);
    if (publicNet !== link.allow_public_network) body.allow_public_network = publicNet;
    update.mutate(body, { onSuccess: () => setToken('') });
  };
  const result = test.data;

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

      {isOwner ? (
        <form
          className="jev-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <TextField label="Địa chỉ Gen-hub" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://hub.genos.top/mcp" className="mono" />
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
            <Switch checked={publicNet} label="Cho phép Gen-hub ở mạng công cộng" onChange={setPublicNet} />
            <span>Gen-hub ở Internet (mạng công cộng) — chỉ bật cho máy chủ này</span>
          </div>
          <div className="jev-actions">
            <Button variant="primary" type="submit" className="btn-27" icon="ph ph-floppy-disk" disabled={!valid || !dirty} loading={update.isPending}>
              Lưu
            </Button>
            <Button
              variant="secondary"
              type="button"
              className="btn-27"
              icon="ph ph-pulse"
              disabled={!link.configured || dirty}
              loading={test.isPending}
              data-gen-target="mcp.hub_link.test"
              onClick={() => test.mutate()}
            >
              Kiểm tra
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
              {result.ok ? `Đã nối Kho · ${result.latency_ms} ms · mở ${result.exposed_tools.length} tool đọc cho Gen` : <FriendlyErrorText raw={result.error} fallback="Chưa kết nối được Gen-hub — kiểm tra địa chỉ và thẻ truy cập." />}
            </div>
          ) : null}
          {/* v0.1.28 (UX V14): từng bước bằng lời thường, không tên riêng. */}
          <ol className="muted-note hub-steps">
            <li>Mở Gen-hub, vào mục tạo trợ lý mới, đặt tên có tên công ty (ví dụ gen-harness-congty).</li>
            <li>Chọn thời hạn thẻ truy cập 90 ngày và chỉ bật các quyền ĐỌC Kho (tóm tắt, tìm, xem một mục) — không bật quyền ghi.</li>
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
