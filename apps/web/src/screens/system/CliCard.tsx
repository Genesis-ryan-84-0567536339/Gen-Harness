import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, type CliProfile } from '@gen-harness/contracts';
import { Button, Dialog, EmptyState, Icon, TextField } from '@gen-harness/ui';
import { api } from '../../lib/api';
import { qk2, useCliProfiles } from '../../lib/dataQueries';
import { emailInitials } from '../../lib/format';
import { queryClient } from '../../lib/queryClient';
import { toast } from '../../lib/toast';
import { useNow } from '../../lib/useNow';
import { errorText } from '../../lib/errorText';
import { CardError, InlineError, SkeletonLines, StateChip } from '../common';
import { CLI_LOGIN_TEXT, cliChip, cliMeta, credTone } from './systemModel';
import { useCliLogin, type CliLogin } from './useCliLogin';

export function CliLoginPanel({ login }: { login: CliLogin }) {
  const [code, setCode] = useState('');
  const { event, status } = login;
  useEffect(() => {
    if (status === 'waiting_code') setCode('');
  }, [status]);
  if (!login.active && !login.start.isError) return null;
  const submitErr = login.submit.error;
  const notWaiting = submitErr instanceof ApiError && submitErr.code === 'CLI_LOGIN_NOT_WAITING';
  return (
    <div className="cli-login" aria-live="polite" data-testid="cli-login">
      {login.start.isError ? (
        <InlineError>{errorText(login.start.error)}</InlineError>
      ) : (
        <div className="cli-login__status">
          {status === 'starting' || status === 'verifying' ? (
            <Icon name="ph ph-circle-notch" size={14} className="spin" />
          ) : status === 'failed' ? (
            <Icon name="ph ph-x-circle" size={14} color="var(--color-bad)" />
          ) : (
            <Icon name="ph ph-key" size={14} color="var(--color-accent-300)" />
          )}
          <span>{status === 'failed' && event?.message ? event.message : status ? CLI_LOGIN_TEXT[status] : ''}</span>
        </div>
      )}
      {status === 'waiting_code' && event?.url ? (
        <>
          <a className="cli-login__url" href={event.url} target="_blank" rel="noopener noreferrer">
            <Icon name="ph ph-arrow-square-out" size={13} />
            Mở trang đăng nhập Google
          </a>
          {/* Not a <form>: this panel also sits inside the setup wizard's form (no nested forms). */}
          <div
            className="cli-login__row"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
                e.preventDefault();
                e.stopPropagation();
                if (code.trim()) login.submit.mutate(code.trim());
              }
            }}
          >
            <TextField
              label="Mã xác thực"
              value={code}
              autoComplete="one-time-code"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Dán mã từ trang đăng nhập"
            />
            <Button variant="primary" disabled={!code.trim()} loading={login.submit.isPending} onClick={() => login.submit.mutate(code.trim())}>
              Xác nhận
            </Button>
          </div>
        </>
      ) : null}
      {submitErr ? (
        <InlineError>{notWaiting ? 'Phiên đăng nhập không còn chờ mã — bắt đầu lại.' : errorText(submitErr)}</InlineError>
      ) : null}
      <div className="dlg-row">
        {status === 'failed' || login.start.isError ? (
          <Button variant="secondary" className="btn-27" icon="ph ph-arrow-clockwise" onClick={() => login.start.mutate()}>
            Thử lại
          </Button>
        ) : null}
        {!login.finished ? (
          <Button variant="ghost" className="btn-27" loading={login.cancel.isPending} onClick={() => login.cancel.mutate()}>
            Huỷ đăng nhập
          </Button>
        ) : (
          <Button variant="ghost" className="btn-27" onClick={login.clear}>
            Đóng
          </Button>
        )}
      </div>
    </div>
  );
}

/** Tài khoản Antigravity CLI + "Khoá & phiên" rows (design CLI card + `creds`). */
export function CliCard({ canManage, showCredentials = true }: { canManage: boolean; showCredentials?: boolean }) {
  const profiles = useCliProfiles();
  const creds = useQuery({
    queryKey: qk2.credentials,
    queryFn: ({ signal }) => api.providers.credentials(signal),
    enabled: showCredentials,
  });
  const now = useNow(60_000);
  const login = useCliLogin();
  const [switchOpen, setSwitchOpen] = useState(false);
  const active = profiles.data?.find((p) => p.active);
  const chip = cliChip(active);

  return (
    <section className="gh-card" aria-label="Tài khoản Antigravity CLI">
      <div className="gh-card__header">
        <div style={{ minWidth: 0 }}>
          <div className="gh-card__title">Tài khoản Antigravity CLI</div>
          <div className="gh-card__kicker">Core agent account</div>
        </div>
        {profiles.data ? (
          <StateChip color={chip.tone} border={chip.tone === 'var(--color-neutral-400)' ? 'var(--color-neutral-800)' : chip.tone} size="md" dot>
            {chip.label}
          </StateChip>
        ) : null}
      </div>
      <div className="cli-body">
        {profiles.isPending ? (
          <SkeletonLines rows={2} padding="0" />
        ) : profiles.isError ? (
          <CardError error={profiles.error} onRetry={() => void profiles.refetch()} retrying={profiles.isFetching} />
        ) : active ? (
          <div className="cli-acct">
            <div className="cli-avatar" aria-hidden>
              {emailInitials(active.email)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="cli-email">{active.email}</div>
              <div className="cli-meta">{cliMeta(active, now)}</div>
            </div>
            {canManage ? (
              <Button variant="secondary" className="btn-28" icon="ph ph-user-switch" onClick={() => setSwitchOpen(true)}>
                Đổi tài khoản
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="cli-acct">
            <div className="cli-avatar cli-avatar--empty" aria-hidden>
              <Icon name="ph ph-user" size={15} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="cli-email">Chưa có tài khoản CLI</div>
              <div className="cli-meta">Đăng nhập Google để core agent dùng Antigravity CLI</div>
            </div>
            {canManage && !login.active ? (
              <Button variant="primary" className="btn-28" icon="ph ph-sign-out" onClick={() => login.start.mutate()} loading={login.start.isPending}>
                Đăng nhập
              </Button>
            ) : null}
          </div>
        )}
        <CliLoginPanel login={login} />
        {showCredentials ? (
          <>
            <div className="cli-rule" />
            {creds.isPending ? (
              <SkeletonLines rows={3} padding="0" />
            ) : creds.isError ? (
              <CardError error={creds.error} onRetry={() => void creds.refetch()} retrying={creds.isFetching} />
            ) : creds.data.length === 0 ? (
              <p className="muted-note">Chưa có khoá API hay phiên kênh nào.</p>
            ) : (
              creds.data.map((cr, i) => {
                const tone = credTone(cr.state);
                return (
                  <div className="cred" key={`${cr.name}-${i}`}>
                    <Icon name={cr.icon} size={14} color={tone} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="cred__name">{cr.name}</div>
                      <div className="cred__meta">{cr.meta}</div>
                    </div>
                    <StateChip color={tone}>{cr.state_label}</StateChip>
                  </div>
                );
              })
            )}
          </>
        ) : null}
      </div>
      <ProfilesDialog
        open={switchOpen}
        onClose={() => setSwitchOpen(false)}
        profiles={profiles.data ?? []}
        onAdd={() => {
          setSwitchOpen(false);
          login.start.mutate();
        }}
      />
    </section>
  );
}

function ProfilesDialog({
  open,
  onClose,
  profiles,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  profiles: CliProfile[];
  onAdd: () => void;
}) {
  const now = useNow(60_000, open);
  const [confirmDelete, setConfirmDelete] = useState<CliProfile | null>(null);
  const activate = useMutation({
    mutationFn: (id: string) => api.cli.activate(id),
    onSuccess: (p) => {
      queryClient.setQueryData<CliProfile[]>(qk2.cliProfiles, (old) => old?.map((x) => ({ ...x, active: x.id === p.id })));
      void queryClient.invalidateQueries({ queryKey: qk2.cliProfiles });
      void queryClient.invalidateQueries({ queryKey: qk2.credentials });
      toast(`Core agent dùng ${p.email}`);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.cli.remove(id),
    onSuccess: (_v, id) => {
      queryClient.setQueryData<CliProfile[]>(qk2.cliProfiles, (old) => old?.filter((x) => x.id !== id));
      void queryClient.invalidateQueries({ queryKey: qk2.cliProfiles });
      toast('Đã xoá hồ sơ CLI', 'neutral');
    },
  });
  const err = activate.error ?? remove.error;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={460}
      title="Đổi tài khoản CLI"
      kicker="Đổi hoặc xoá hồ sơ cần mã PIN"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
          <Button variant="primary" icon="ph ph-plus" onClick={onAdd}>
            Đăng nhập tài khoản khác
          </Button>
        </>
      }
    >
      {profiles.length === 0 ? (
        <EmptyState icon="ph ph-user" title="Chưa có hồ sơ CLI nào" />
      ) : (
        <div>
          {profiles.map((p) => (
            <div className="profile-row" key={p.id}>
              <div className="cli-avatar" aria-hidden>
                {emailInitials(p.email)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cli-email">{p.email}</div>
                <div className="cli-meta">{cliMeta(p, now)}</div>
              </div>
              {p.active ? (
                <StateChip color="var(--color-ok)">Đang dùng</StateChip>
              ) : confirmDelete?.id === p.id ? (
                <>
                  <span className="cli-meta" style={{ marginTop: 0 }}>Xoá hồ sơ?</span>
                  <Button variant="secondary" className="btn-27" onClick={() => setConfirmDelete(null)}>
                    Huỷ
                  </Button>
                  <Button
                    variant="primary"
                    className="btn-27"
                    icon="ph ph-trash"
                    loading={remove.isPending}
                    onClick={() => {
                      setConfirmDelete(null);
                      remove.mutate(p.id);
                    }}
                  >
                    Xoá
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    className="btn-27"
                    loading={activate.isPending && activate.variables === p.id}
                    onClick={() => activate.mutate(p.id)}
                  >
                    Dùng
                  </Button>
                  <Button
                    variant="ghost"
                    className="btn-27"
                    icon="ph ph-trash"
                    aria-label={`Xoá hồ sơ ${p.email}`}
                    onClick={() => setConfirmDelete(p)}
                  />
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {err ? <InlineError>{errorText(err)}</InlineError> : null}
    </Dialog>
  );
}
