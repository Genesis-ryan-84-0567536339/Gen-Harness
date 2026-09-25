import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BindingSetBody, ProviderCreateBody } from '@gen-harness/contracts';
import { api } from '../../lib/api';
import { qk2 } from '../../lib/dataQueries';

export const qkApi = {
  bindings: ['agents', 'bindings'] as const,
  failoverRules: ['failover-rules'] as const,
};

export const useBindings = () => useQuery({ queryKey: qkApi.bindings, queryFn: ({ signal }) => api.bindings.list(signal) });

export const useFailoverRules = () =>
  useQuery({ queryKey: qkApi.failoverRules, queryFn: ({ signal }) => api.failoverRules(signal) });

export const useSetBinding = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentKey, body }: { agentKey: string; body: BindingSetBody }) => api.bindings.set(agentKey, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qkApi.bindings }),
  });
};

export const useRemoveBinding = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentKey: string) => api.bindings.remove(agentKey),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qkApi.bindings }),
  });
};

function invalidateProviders(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: qk2.providers });
  void qc.invalidateQueries({ queryKey: qk2.credentials });
}

export const useCreateProvider = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProviderCreateBody) => api.providers.create(body),
    onSuccess: () => invalidateProviders(qc),
  });
};

export const useAddProviderKey = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, secret }: { id: string; secret: string }) => api.providers.addKey(id, secret),
    onSuccess: () => invalidateProviders(qc),
  });
};

export const useTestProvider = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.providers.test(id),
    onSuccess: () => invalidateProviders(qc),
  });
};

export const useAddModel = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { model_name: string; daily_quota?: number; rate_limit_per_min?: number } }) =>
      api.providers.addModel(id, body),
    onSuccess: () => invalidateProviders(qc),
  });
};

export const useSetProviderEnabled = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.providers.update(id, { enabled }),
    onSuccess: () => invalidateProviders(qc),
  });
};

export const useReorderChain = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerIds: string[]) => api.providers.chain(providerIds),
    onMutate: async (providerIds) => {
      await qc.cancelQueries({ queryKey: qk2.providers });
      const prev = qc.getQueryData(qk2.providers);
      qc.setQueryData(qk2.providers, (old: import('@gen-harness/contracts').Provider[] | undefined) =>
        old
          ? providerIds
              .map((id, i) => {
                const p = old.find((x) => x.id === id);
                return p ? { ...p, failover_rank: i + 1 } : null;
              })
              .filter((p): p is import('@gen-harness/contracts').Provider => p !== null)
          : old,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk2.providers, ctx.prev);
    },
    onSuccess: (saved) => qc.setQueryData(qk2.providers, saved),
  });
};
