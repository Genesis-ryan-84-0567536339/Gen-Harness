import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { CliLoginEvent } from '@gen-harness/contracts';
import { api } from '../../lib/api';
import { qk2 } from '../../lib/dataQueries';
import { queryClient } from '../../lib/queryClient';
import { toast } from '../../lib/toast';

/**
 * Antigravity CLI login — URL + paste-back code (contract addendum):
 * POST /cli/login → WS `cli.login` starting → waiting_code {url} → the user
 * pastes the code → POST /cli/login/{id}/code → verifying → done|failed.
 */
export function useCliLogin() {
  const [loginId, setLoginId] = useState<string | null>(null);
  const ev = useQuery<CliLoginEvent | null>({
    queryKey: qk2.cliLogin(loginId ?? '-'),
    queryFn: () => null,
    enabled: false,
    initialData: null,
  });
  const start = useMutation({
    mutationFn: () => api.cli.login(),
    onSuccess: (r) => {
      // The WS event may arrive before or after the 202; seed "starting" only if nothing came yet.
      if (!queryClient.getQueryData(qk2.cliLogin(r.login_id)))
        queryClient.setQueryData<CliLoginEvent>(qk2.cliLogin(r.login_id), { login_id: r.login_id, status: 'starting' });
      setLoginId(r.login_id);
    },
  });
  const submit = useMutation({
    mutationFn: (code: string) => api.cli.submitCode(loginId!, code),
    onSuccess: () =>
      queryClient.setQueryData<CliLoginEvent | null>(qk2.cliLogin(loginId!), (old) =>
        old && old.status === 'waiting_code' ? { ...old, status: 'verifying' } : old,
      ),
  });
  const cancel = useMutation({
    mutationFn: () => (loginId ? api.cli.cancelLogin(loginId) : Promise.resolve()),
    onSettled: () => {
      setLoginId(null);
      start.reset();
      submit.reset();
    },
  });
  const status = ev.data?.status ?? (start.isPending ? 'starting' : null);
  const finished = status === 'done' || status === 'failed';
  useEffect(() => {
    if (ev.data?.status === 'done') {
      toast(ev.data.profile ? `Đã đăng nhập ${ev.data.profile.email}` : 'Đã đăng nhập Antigravity CLI');
      setLoginId(null);
    }
  }, [ev.data]);
  return {
    active: !!loginId || start.isPending,
    event: ev.data,
    status,
    finished,
    start,
    submit,
    cancel,
    clear: () => {
      setLoginId(null);
      start.reset();
      submit.reset();
    },
  };
}

export type CliLogin = ReturnType<typeof useCliLogin>;
