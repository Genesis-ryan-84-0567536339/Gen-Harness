import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentCloneBody, AgentCreateBody, AgentPatchBody } from '@gen-harness/contracts';
import { api } from '../../lib/api';

export const qkAgents = {
  list: ['agents', 'list'] as const,
  templates: ['agents', 'templates'] as const,
  decisions: (agentId?: string, decision?: string) => ['agents', 'decisions', agentId ?? '', decision ?? ''] as const,
};

export const useAgents = () => useQuery({ queryKey: qkAgents.list, queryFn: ({ signal }) => api.agents.list(signal) });

export const useAgentTemplates = () =>
  useQuery({ queryKey: qkAgents.templates, queryFn: ({ signal }) => api.agents.templates(signal) });

export const useAgentDecisions = (agentId?: string, decision?: string, limit = 8) =>
  useQuery({
    queryKey: [...qkAgents.decisions(agentId, decision), limit],
    queryFn: ({ signal }) => api.agentDecisions({ agent_id: agentId, decision, limit }, signal),
  });

function invalidateAgents(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: qkAgents.list });
}

export const useCreateAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentCreateBody) => api.agents.create(body),
    onSuccess: () => invalidateAgents(qc),
  });
};

export const useUpdateAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AgentPatchBody }) => api.agents.update(id, body),
    onSuccess: () => invalidateAgents(qc),
  });
};

export const useCloneAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AgentCloneBody }) => api.agents.clone(id, body),
    onSuccess: () => invalidateAgents(qc),
  });
};

export const useSetAgentEnabled = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.agents.setEnabled(id, enabled),
    onSuccess: () => invalidateAgents(qc),
  });
};
