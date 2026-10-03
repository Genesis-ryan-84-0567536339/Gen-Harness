import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { BossCheck, BossCheckKey, BossCheckRunBody, BossOverview, CliProfile } from '@gen-harness/contracts';
import { Button, EmptyState, Icon, Switch, TextField } from '@gen-harness/ui';
import { api } from '../lib/api';
import { cliProfilesKey, useCliProfiles, useProviders } from '../lib/dataQueries';
import { errorDetail, errorText } from '../lib/errorText';
import { useOrgTimezone } from '../lib/permissions';
import { useMe } from '../lib/queries';
import { queryClient } from '../lib/queryClient';
import { CardError, InlineError, SkeletonLines } from '../screens/common';
import { ScreenTitle } from '../screens/ScreenPage';
import { isPublicHttpsUrl } from '../screens/mcp/mcpModel';
import { useHubLink, useUpdateHubLink } from '../screens/mcp/queries';
import { ClaudeRiskNotice, CliLoginPanel } from '../screens/system/CliCard';
import { useCliLogin } from '../screens/system/useCliLogin';
import { accountStatus, qkSocial } from '../social/socialModel';
import { TELEGRAM_GUIDE_PATH } from '../screens/connections/telegramModel';
import {
  BOSS_CHECKS_KEY,
  BOSS_CHECKS_POLL_MS,
  HUB_ADDRESS_CODES,
  accountOf,
  bossErrorText,
  fmtCheckedAt,
  hasPending,
  hubTokenExpiry,
  isStalePending,
  needsRelogin,
  resultOf,
  switchesOf,
  withResult,
} from './bossChecksModel';

type Results = BossOverview | undefined;

/**
 * v0.1.39 (F-74) — "Việc Sếp cần làm" (`/guide/viec-sep`): 6 dòng kết nối chạy thật (5 bắt buộc + Jev tuỳ chọn). Mỗi
 * dòng có việc phải làm bằng lời thường, nút hành động và Ô KẾT QUẢ ngay cạnh. Kết quả lưu ở máy chủ
 * (`GET /boss-checks`) — tải lại trang vẫn còn, Claude tự đọc, Sếp không cần chụp màn hình. Chỉ Owner.
 */
export function BossChecksPage() {
  const me = useMe();
  const role = me.data?.role?.code;
  const nonOwner = !!role && role !== 'owner';
  const q = useQuery({
    queryKey: BOSS_CHECKS_KEY,
    queryFn: ({ signal }) => api.bossChecks.list(signal),
    enabled: !!me.data && !nonOwner,
    refetchInterval: (query) => (hasPending(query.state.data) ? BOSS_CHECKS_POLL_MS : false),
  });

  useEffect(() => {
    document.title = 'Việc Sếp cần làm · Hướng dẫn thiết lập · Gen-Harness';
  }, []);

  const data = q.data;
  const rowDone = (n: number) => !!data?.rows?.find((r) => r.row === n)?.done;
  const total = data?.required_total ?? 5;
  const done = data?.required_done ?? 0;

  return (
    <div className="screen guide boss">
      <Link to="/guide" className="guide-back">
        <Icon name="ph ph-arrow-left" size={13} /> Hướng dẫn thiết lập
      </Link>
      <ScreenTitle
        title="Việc Sếp cần làm"
        description="Sáu việc để hệ thống kết nối chạy thật (khoảng 25 phút). Làm từng dòng: bấm nút, xem ô kết quả ngay bên cạnh."
        maxWidth={640}
      />
      {nonOwner ? (
        <div className="gh-card">
          <EmptyState
            icon="ph ph-lock-simple"
            title="Việc kết nối do Owner làm"
            description="Nối Gen-hub, Facebook, tài khoản Google, Claude Code và Telegram chỉ Owner làm được. Cần thêm gì, hãy nhắn Owner."
          />
        </div>
      ) : me.isError ? (
        // Không đọc được vai trò → truy vấn bị tắt, `q.isPending` luôn đúng: báo lỗi + Thử lại thay vì khung chờ mãi.
        <div className="gh-card">
          <CardError error={me.error} onRetry={() => void me.refetch()} retrying={me.isFetching} />
        </div>
      ) : q.isPending ? (
        <div className="gh-card">
          <SkeletonLines rows={6} />
        </div>
      ) : q.isError ? (
        <div className="gh-card">
          <CardError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        </div>
      ) : (
        <>
          <div className="guide-progress" role="status">
            <div className="guide-progress__bar" role="progressbar" aria-label="Tiến độ việc Sếp cần làm" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
              <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
            </div>
            <span className="guide-progress__text">{done >= total ? `Đã đạt đủ ${total} dòng bắt buộc — kết nối chạy thật.` : `Đã đạt ${done}/${total} dòng bắt buộc`}</span>
          </div>
          <ol className="boss-list">
            <HubRow data={data} done={rowDone(1)} />
            <FacebookRow data={data} done={rowDone(2)} />
            <AgyRow data={data} done={rowDone(3)} />
            <ClaudeRow data={data} done={rowDone(4)} />
            <JevRow data={data} done={rowDone(5)} />
            <TelegramRow data={data} done={rowDone(6)} />
          </ol>
          <p className="boss-foot muted-note">
            <Icon name="ph ph-floppy-disk" size={13} /> Kết quả được lưu lại — Claude tự đọc, Sếp không cần chụp màn hình.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Chạy một lượt kiểm: hiện kết quả ngay từ phản hồi rồi tải lại bản tổng quan. Lỗi TẠM (`transient`: bận/hạn mức) máy
 * chủ không ghi → KHÔNG thay ô kết quả (giữ "Đạt"/"Đang chạy…"), chỉ báo cạnh nút qua `TransientNote`.
 */
function useRunCheck() {
  return useMutation({
    mutationFn: ({ key, body }: { key: BossCheckKey; body?: BossCheckRunBody }) => api.bossChecks.run(key, body),
    onSuccess: (c) => {
      if (!c.transient) queryClient.setQueryData<BossOverview>(BOSS_CHECKS_KEY, (old) => withResult(old, c));
      void queryClient.invalidateQueries({ queryKey: BOSS_CHECKS_KEY });
    },
  });
}

/** Câu báo lỗi tạm của lượt vừa bấm (không lưu) — chuỗi thân thiện + Chi tiết kỹ thuật. */
function TransientNote({ check }: { check: BossCheck | undefined }) {
  if (!check?.transient) return null;
  return (
    <div className="muted-note friendly-error" role="status" data-testid="boss-transient">
      {bossErrorText(check)} Kết quả đã lưu giữ nguyên.
      {check.error_code ? (
        <details className="tech-detail">
          <summary>Chi tiết kỹ thuật</summary>
          <code>Mã lỗi {check.error_code}</code>
        </details>
      ) : null}
    </div>
  );
}

function Row({ n, title, optional, done, todo, children, results }: { n: number; title: string; optional?: boolean; done: boolean; todo: string; children: ReactNode; results: ReactNode }) {
  return (
    <li className="boss-row gh-card" data-done={done || undefined}>
      <section aria-label={title}>
        <div className="boss-row__head">
          <span className="guide-card__num mono">{String(n).padStart(2, '0')}</span>
          <span className="guide-card__title">{title}</span>
          {optional ? <span className="guide-chip">Không bắt buộc</span> : null}
          {done ? (
            <span className="guide-chip guide-chip--done">
              <Icon name="ph ph-check" size={12} /> Xong
            </span>
          ) : null}
        </div>
        <div className="boss-row__body">
          <div className="boss-row__main">
            <p className="boss-row__todo">{todo}</p>
            {children}
          </div>
          <div className="boss-row__results">{results}</div>
        </div>
      </section>
    </li>
  );
}

/**
 * Ô kết quả: Đạt (xanh) | Lỗi · câu thân thiện + Chi tiết kỹ thuật | Đang chạy… | Chưa kiểm (hoặc `emptyText` khi chưa
 * có bản ghi nhưng đã có sẵn trạng thái, vd phiên đăng nhập từ trước). Chỉ render chuỗi.
 */
function ResultCell({ label, check, okText, failText, emptyText }: { label?: string; check: BossCheck | null; okText?: (c: BossCheck) => string; failText?: string; emptyText?: string }) {
  const tz = useOrgTimezone();
  const state = check?.status ?? 'none';
  return (
    <div className={`boss-result boss-result--${state}`} data-testid="boss-result">
      {label ? <span className="boss-result__label">{label}</span> : null}
      {!check ? (
        <span>{emptyText ?? 'Chưa kiểm'}</span>
      ) : check.status === 'pending' ? (
        <span>
          <Icon name="ph ph-circle-notch" size={12} className="spin" /> Đang chạy…
        </span>
      ) : check.status === 'pass' ? (
        <span>{okText ? okText(check) : `Đạt · ${fmtCheckedAt(check.checked_at, tz)}`}</span>
      ) : (
        <span className="friendly-error">
          {failText ?? `Lỗi · ${bossErrorText(check)}`}
          {check.error_code ? (
            <details className="tech-detail">
              <summary>Chi tiết kỹ thuật</summary>
              <code>Mã lỗi {check.error_code}</code>
            </details>
          ) : null}
        </span>
      )}
    </div>
  );
}

// ── 1. Gen-hub ─────────────────────────────────────────────────────────────────────────────────────────────
function HubRow({ data, done }: { data: Results; done: boolean }) {
  const link = useHubLink();
  const update = useUpdateHubLink();
  const run = useRunCheck();
  const l = link.data;
  const configured = !!l?.configured;
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [publicNet, setPublicNet] = useState(false);
  const [touched, setTouched] = useState(false);
  const savedEndpoint = l?.endpoint ?? '';
  const effective = configured ? savedEndpoint : endpoint.trim();
  // Bật sẵn theo địa chỉ (https công khai) tới khi Sếp tự bấm công tắc.
  useEffect(() => {
    if (!l || touched) return;
    setPublicNet(l.allow_public_network || isPublicHttpsUrl(effective));
  }, [l, effective, touched]);
  const auto = !touched && publicNet && isPublicHttpsUrl(effective) && !l?.allow_public_network;
  const validNew = /^https?:\/\/\S+$/.test(endpoint.trim()) && token.trim().length >= 8;
  const tokenOk = !token.trim() || token.trim().length >= 8;
  const canRun = !!l && (configured ? tokenOk : validNew);
  const hubRes = resultOf(data, 'hub');

  const check = async () => {
    if (!l) return;
    const body: Parameters<typeof update.mutateAsync>[0] = {};
    if (!configured) {
      body.endpoint = endpoint.trim();
      body.token = token.trim();
    } else if (token.trim()) body.token = token.trim();
    // Token mới (lần đầu hoặc thay) = token 90 ngày trang yêu cầu → gửi kèm hạn để lời nhắc trước 14 ngày chạy đúng ngày.
    if (body.token) body.token_expires_at = hubTokenExpiry();
    if (publicNet !== l.allow_public_network) body.allow_public_network = publicNet;
    if (Object.keys(body).length) {
      try {
        await update.mutateAsync(body);
      } catch {
        return;
      }
      setToken('');
      setEndpoint('');
    }
    run.mutate({ key: 'hub' });
  };

  return (
    <Row
      n={1}
      title="Nối Gen-hub"
      done={done}
      todo="Nhập địa chỉ Gen-hub (vd https://hub.genos.top/mcp), trong Gen-hub tạo token chỉ đọc 90 ngày, dán vào đây rồi bấm Kiểm tra."
      results={<ResultCell check={hubRes} />}
    >
      {link.isPending ? (
        <SkeletonLines rows={2} padding="0" />
      ) : link.isError ? (
        <CardError error={link.error} onRetry={() => void link.refetch()} retrying={link.isFetching} />
      ) : (
        <div className="boss-form">
          {!configured ? (
            <>
              <TextField label="Địa chỉ Gen-hub" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://hub.genos.top/mcp" className="mono" />
              <TextField label="Token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Dán token tạo trong Gen-hub" />
            </>
          ) : (
            <>
              <p className="muted-note">
                <span className="mono">{savedEndpoint}</span>{' '}
                <Link to="/connections#genhub" className={HUB_ADDRESS_CODES.has(hubRes?.error_code ?? '') ? 'gh-btn gh-btn--secondary btn-27' : undefined}>
                  Sửa địa chỉ ở Kết nối
                </Link>
              </p>
              <TextField label="Token mới (bỏ trống để giữ)" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Dán token mới nếu cần đổi" />
            </>
          )}
          <div className="triage-row">
            <Switch
              checked={publicNet}
              label="Cho phép Gen-hub ở mạng công cộng"
              onChange={(on) => {
                setTouched(true);
                setPublicNet(on);
              }}
            />
            <span>Cho phép Gen-hub ở mạng công cộng</span>
          </div>
          {auto ? (
            <p className="muted-note" role="note">
              <Icon name="ph ph-globe" size={12} /> Đã bật sẵn vì địa chỉ là https công khai — Gen-hub sẽ được gọi qua Internet. Bỏ tích nếu Gen-hub nằm trong mạng nội bộ.
            </p>
          ) : null}
          <div className="boss-actions">
            <Button variant="primary" className="btn-27" icon="ph ph-pulse" disabled={!canRun} loading={update.isPending || run.isPending} onClick={() => void check()}>
              Kiểm tra
            </Button>
          </div>
          {l && !canRun ? (
            <p className="muted-note" data-testid="boss-hub-hint">
              {configured ? 'Token mới cần ít nhất 8 ký tự (bỏ trống để giữ token cũ).' : 'Cần địa chỉ http(s) và token ít nhất 8 ký tự rồi mới bấm Kiểm tra được.'}
            </p>
          ) : null}
          {update.isError ? <InlineError>{errorText(update.error)}</InlineError> : null}
          {run.isError ? <InlineError>{errorText(run.error)}</InlineError> : null}
          <TransientNote check={run.data} />
        </div>
      )}
    </Row>
  );
}

// ── 2. Facebook ────────────────────────────────────────────────────────────────────────────────────────────
function FacebookRow({ data, done }: { data: Results; done: boolean }) {
  const accounts = useQuery({ queryKey: qkSocial.accounts, queryFn: ({ signal }) => api.social.accounts.list(signal) });
  const run = useRunCheck();
  const fb = (accounts.data?.items ?? []).filter((a) => a.platform.startsWith('facebook') && a.status !== 'revoked');
  const acc = fb.find((a) => a.status === 'active') ?? fb[0];
  const res = resultOf(data, 'facebook');
  // Đang chạy quá lâu (worker trình duyệt treo): máy chủ tự chốt lỗi ở lần tải sau; phòng khi chưa kịp, mở lại nút.
  const stale = isStalePending(res);
  const running = res?.status === 'pending' && !stale;
  return (
    <Row
      n={2}
      title="Kết nối Facebook"
      done={done}
      todo="Thêm tài khoản Facebook của Sếp, tự đăng nhập ngay trong app, rồi bấm Đọc ngay."
      results={<ResultCell check={res} />}
    >
      {accounts.isPending ? (
        <SkeletonLines rows={1} padding="0" />
      ) : accounts.isError ? (
        <CardError error={accounts.error} onRetry={() => void accounts.refetch()} retrying={accounts.isFetching} />
      ) : !acc ? (
        <div className="boss-actions">
          <Link to="/social" className="gh-btn gh-btn--primary btn-27">
            Mở trang Tài khoản mạng xã hội
            <Icon name="ph ph-arrow-right" size={13} />
          </Link>
          <span className="muted-note">Đăng nhập ngay trong app — mật khẩu, mã 2FA Sếp tự gõ, không lưu lại.</span>
        </div>
      ) : acc.status !== 'active' ? (
        // Có tài khoản nhưng chưa đăng nhập / cần đăng nhập lại / tạm dừng: "Đọc ngay" chỉ ra SOCIAL_NOT_ACTIVE → lối
        // chính là trang Tài khoản mạng xã hội.
        <div className="boss-actions">
          <Link to="/social" className="gh-btn gh-btn--primary btn-27">
            Đăng nhập ở trang Tài khoản mạng xã hội
            <Icon name="ph ph-arrow-right" size={13} />
          </Link>
          <span className="muted-note">{`${acc.label} · ${accountStatus(acc).label}`}</span>
        </div>
      ) : (
        <div className="boss-actions">
          <Button
            variant={res?.status === 'pass' ? 'secondary' : 'primary'}
            className="btn-27"
            icon="ph ph-book-open"
            disabled={running}
            loading={run.isPending}
            onClick={() => run.mutate({ key: 'facebook', body: { account_id: acc.id } })}
          >
            {res?.status === 'pass' ? 'Đọc lại' : 'Đọc ngay'}
          </Button>
          <span className="muted-note">{running ? `${acc.label} · đang đọc, đợi xong rồi mới bấm lại được` : acc.label}</span>
        </div>
      )}
      {stale ? (
        <p className="muted-note" role="note" data-testid="boss-fb-stale">
          Lượt đọc chạy quá lâu — có thể trình duyệt nền đang treo. Mở <Link to="/social">trang Tài khoản mạng xã hội</Link> xem, rồi bấm Đọc ngay lần nữa.
        </p>
      ) : null}
      {run.isError ? <InlineError>{errorText(run.error)}</InlineError> : null}
      <TransientNote check={run.data} />
    </Row>
  );
}

// ── 3. Google / Antigravity ───────────────────────────────────────────────────────────────────────────────
function AgyRow({ data, done }: { data: Results; done: boolean }) {
  const profiles = useCliProfiles('antigravity_cli');
  const login = useCliLogin('antigravity_cli');
  const call = useRunCheck();
  const sw = useRunCheck();
  const list: CliProfile[] = profiles.data ?? [];
  const sw0 = resultOf(data, 'agy_switch');
  const switches = switchesOf(data);
  // Hết hạn / chưa có phiên / gọi thử vẫn chạy tài khoản khác: chỉ đăng nhập lại mới sửa được (đổi lại = lặp lỗi).
  const relogin = list.length > 0 && (needsRelogin(resultOf(data, 'agy_call')) || needsRelogin(sw0) || list.some((p) => p.state === 'expired'));
  const doSwitch = (p: CliProfile) =>
    sw.mutate(
      { key: 'agy_switch', body: { profile_id: p.id } },
      { onSettled: () => void queryClient.invalidateQueries({ queryKey: cliProfilesKey('antigravity_cli') }) },
    );
  return (
    <Row
      n={3}
      title="Google (Antigravity) — hai tài khoản"
      done={done}
      todo="Đăng nhập hai tài khoản Google, bấm Gọi thử, rồi đổi qua lại hai lần để chắc hệ thống dùng đúng tài khoản."
      results={
        <>
          <ResultCell label="Đăng nhập" check={resultOf(data, 'agy_login')} emptyText={list.length > 0 ? 'Đã có phiên (đăng nhập trước đây)' : undefined} />
          <ResultCell label="Gọi thử" check={resultOf(data, 'agy_call')} okText={(c) => `Đạt · đang dùng ${accountOf(c, call.data) ?? 'tài khoản Google'}`} />
          <ResultCell
            label="Đổi tài khoản"
            check={sw0}
            okText={(c) =>
              c.detail?.account_match === null || !accountOf(c, sw.data)
                ? 'Đã đổi · gọi thử chạy được (không đọc được email để so)'
                : `Đã đổi · gọi thử chạy bằng ${accountOf(c, sw.data)} — khớp`
            }
          />
        </>
      }
    >
      {profiles.isPending ? (
        <SkeletonLines rows={1} padding="0" />
      ) : profiles.isError ? (
        <CardError error={profiles.error} onRetry={() => void profiles.refetch()} retrying={profiles.isFetching} />
      ) : (
        <>
          <div className="boss-actions">
            {list.length === 0 ? (
              <Button variant="primary" className="btn-27" icon="ph ph-google-logo" disabled={login.active} loading={login.start.isPending} onClick={() => login.start.mutate()}>
                Đăng nhập Google
              </Button>
            ) : relogin ? (
              <Button variant="primary" className="btn-27" icon="ph ph-arrow-clockwise" disabled={login.active} loading={login.start.isPending} onClick={() => login.start.mutate()}>
                Đăng nhập lại
              </Button>
            ) : list.length === 1 ? (
              <Button variant="secondary" className="btn-27" icon="ph ph-user-plus" disabled={login.active} loading={login.start.isPending} onClick={() => login.start.mutate()}>
                Thêm tài khoản thứ hai
              </Button>
            ) : null}
            {list.length > 0 ? (
              <Button variant="primary" className="btn-27" icon="ph ph-chat-circle-dots" loading={call.isPending} onClick={() => call.mutate({ key: 'agy_call' })}>
                Gọi thử
              </Button>
            ) : null}
            {list
              .filter((p) => !p.active)
              .map((p) => (
                <Button
                  key={p.id}
                  variant="secondary"
                  className="btn-27"
                  icon="ph ph-arrows-left-right"
                  loading={sw.isPending && sw.variables?.body?.profile_id === p.id}
                  onClick={() => doSwitch(p)}
                >
                  {`Đổi sang ${p.email ?? 'tài khoản Google'}`}
                </Button>
              ))}
          </div>
          {list.length > 0 ? (
            <p className="muted-note">
              Đang dùng: {list.find((p) => p.active)?.email ?? '—'} · Đã đổi qua lại {switches}/2 lần
            </p>
          ) : null}
          {relogin ? (
            <p className="muted-note" role="note">
              Bấm Đăng nhập lại rồi đăng nhập đúng tài khoản Google cần dùng — hoặc làm ở <Link to="/connections#brain">Kết nối › Bộ não AI</Link>.
            </p>
          ) : null}
          <CliLoginPanel login={login} />
        </>
      )}
      {call.isError ? <InlineError>{errorText(call.error)}</InlineError> : null}
      {sw.isError ? <InlineError>{errorText(sw.error)}</InlineError> : null}
      <TransientNote check={call.data} />
      <TransientNote check={sw.data} />
    </Row>
  );
}

// ── 4. Claude Code CLI ─────────────────────────────────────────────────────────────────────────────────────
function ClaudeRow({ data, done }: { data: Results; done: boolean }) {
  const profiles = useCliProfiles('claude_code_cli');
  const login = useCliLogin('claude_code_cli');
  const call = useRunCheck();
  const tz = useOrgTimezone();
  const has = (profiles.data ?? []).length > 0;
  const relogin = has && (needsRelogin(resultOf(data, 'claude_call')) || (profiles.data ?? []).some((p) => p.active && p.state === 'expired'));
  return (
    <Row
      n={4}
      title="Claude Code CLI"
      done={done}
      todo="Đọc cảnh báo, đăng nhập tài khoản Claude của Sếp rồi bấm Gọi thử."
      results={
        <>
          <ResultCell
            label="Đăng nhập"
            check={resultOf(data, 'claude_login')}
            // Phiên có từ trước v0.1.39: máy chủ ghi "Đạt" khi Gọi thử đạt (login_source = existing_session).
            emptyText={has ? 'Đã có phiên (đăng nhập trước đây) — bấm Gọi thử để xác nhận' : undefined}
            okText={(c) => `Đạt${c.detail?.login_source === 'existing_session' ? ' · phiên có sẵn, đã xác nhận bằng Gọi thử' : ''} · ${fmtCheckedAt(c.checked_at, tz)}`}
          />
          <ResultCell label="Gọi thử" check={resultOf(data, 'claude_call')} okText={(c) => (accountOf(c, call.data) ? `Đạt · đang dùng ${accountOf(c, call.data)}` : `Đạt`)} />
        </>
      }
    >
      <ClaudeRiskNotice />
      <div className="boss-actions">
        {!has ? (
          <Button variant="primary" className="btn-27" icon="ph ph-sign-in" disabled={login.active} loading={login.start.isPending} onClick={() => login.start.mutate()}>
            Đăng nhập Claude Code
          </Button>
        ) : relogin ? (
          <Button variant="primary" className="btn-27" icon="ph ph-arrow-clockwise" disabled={login.active} loading={login.start.isPending} onClick={() => login.start.mutate()}>
            Đăng nhập lại Claude Code
          </Button>
        ) : null}
        <Button variant={has ? 'primary' : 'secondary'} className="btn-27" icon="ph ph-chat-circle-dots" disabled={!has} loading={call.isPending} onClick={() => call.mutate({ key: 'claude_call' })}>
          Gọi thử
        </Button>
        {!has && !profiles.isPending ? <span className="muted-note">Đăng nhập trước rồi mới Gọi thử.</span> : null}
      </div>
      <CliLoginPanel login={login} />
      {call.isError ? <InlineError>{errorText(call.error)}</InlineError> : null}
      <TransientNote check={call.data} />
    </Row>
  );
}

// ── 5. Jev (tuỳ chọn) ─────────────────────────────────────────────────────────────────────────────────────
function JevRow({ data, done }: { data: Results; done: boolean }) {
  const providers = useProviders();
  const run = useRunCheck();
  const jev = (providers.data ?? []).find((p) => p.kind === 'system_one');
  const result = resultOf(data, 'jev');
  // QD-10: đã có kết quả thì không mời kiểm lại (Jev lỗi chỉ ẩn thẻ, không phải việc của Sếp).
  const showRun = !!jev && (!result || result.error_code === 'JEV_NOT_CONFIGURED');
  return (
    <Row
      n={5}
      title="Jev"
      optional
      done={done}
      todo="Không bắt buộc. Có khoá Jev thì kiểm một lần; không có thì bỏ qua dòng này."
      results={<ResultCell check={result} failText={result?.status === 'fail' && result.error_code !== 'JEV_NOT_CONFIGURED' ? 'Lỗi — thẻ Jev sẽ ẩn, không cần làm thêm' : undefined} />}
    >
      {providers.isPending ? (
        <SkeletonLines rows={1} padding="0" />
      ) : providers.isError ? (
        <CardError error={providers.error} onRetry={() => void providers.refetch()} retrying={providers.isFetching} />
      ) : !jev ? (
        <div className="boss-actions">
          <Link to="/system?tab=brain#jev" className="gh-btn gh-btn--secondary btn-27">
            Nhập khoá Jev
            <Icon name="ph ph-arrow-right" size={13} />
          </Link>
        </div>
      ) : showRun ? (
        <div className="boss-actions">
          <Button variant="secondary" className="btn-27" icon="ph ph-pulse" loading={run.isPending} onClick={() => run.mutate({ key: 'jev' })}>
            Kiểm tra 1 lần
          </Button>
        </div>
      ) : null}
      {run.isError ? <InlineError>{errorText(run.error)}</InlineError> : null}
      <TransientNote check={run.data} />
    </Row>
  );
}

// ── 6. Telegram (báo động & bản tin) ─────────────────────────────────────────────────────────────────────
/**
 * v0.1.44 (F-8c): cấu hình bot ở Kết nối › Telegram (`/connections#telegram`); ở đây chỉ "Gửi thử" (máy chủ gửi một
 * tin và nhờ Trực canh máy chủ gửi thêm một tin). Lỗi tạm (TELEGRAM_RATE_LIMITED) báo cạnh nút, không thay ô kết quả.
 */
function TelegramRow({ data, done }: { data: Results; done: boolean }) {
  const run = useRunCheck();
  const tz = useOrgTimezone();
  const res = resultOf(data, 'telegram');
  const okText = (c: BossCheck) => {
    const bot = typeof c.detail?.bot_username === 'string' && c.detail.bot_username ? `@${c.detail.bot_username}` : null;
    const chat = typeof c.detail?.chat_masked === 'string' && c.detail.chat_masked ? c.detail.chat_masked : null;
    return bot || chat ? `Đạt · đã gửi tới ${bot ?? 'bot'} → chat ${chat ?? '•••'}` : `Đạt · ${fmtCheckedAt(c.checked_at, tz)}`;
  };
  return (
    <Row
      n={6}
      title="Telegram (báo động & bản tin)"
      done={done}
      todo="Tạo bot bằng BotFather, dán token và chọn chat ở Kết nối › Telegram, rồi bấm Gửi thử — điện thoại nhận được tin là xong."
      results={<ResultCell check={res} okText={okText} />}
    >
      <div className="boss-actions">
        <Button
          variant={res?.status === 'pass' ? 'secondary' : 'primary'}
          className="btn-27"
          icon="ph ph-paper-plane-tilt"
          loading={run.isPending}
          onClick={() => run.mutate({ key: 'telegram' })}
        >
          Gửi thử
        </Button>
        <Link to={TELEGRAM_GUIDE_PATH} className="gh-btn gh-btn--secondary btn-27">
          Mở hướng dẫn
          <Icon name="ph ph-arrow-right" size={13} />
        </Link>
      </div>
      {run.isError ? <InlineError detail={errorDetail(run.error)}>{errorText(run.error)}</InlineError> : null}
      <TransientNote check={run.data} />
    </Row>
  );
}
