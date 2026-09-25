import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InboxTab, TaskCreateBody, TaskPatchBody, TaskPriority, TaskStatus } from '@gen-harness/contracts';
import { api } from '../../lib/api';
import { onRealtimeEvent } from '../../lib/realtime';

/** Khoá truy vấn của cụm Hàng đợi & Hành động. */
export const qkQueue = {
  overview: ['queue', 'overview'] as const,
  inbox: (tab: InboxTab, intent?: string) => ['queue', 'inbox', tab, intent ?? ''] as const,
  inboxItem: (id: string) => ['queue', 'inbox', 'one', id] as const,
  tasks: (q: Record<string, string | boolean | undefined>) => ['queue', 'tasks', JSON.stringify(q)] as const,
  task: (id: string) => ['queue', 'tasks', 'one', id] as const,
  promises: (status: string) => ['queue', 'promises', status] as const,
};

export const useOverview = () =>
  useQuery({
    queryKey: qkQueue.overview,
    queryFn: ({ signal }) => api.queue.overview(signal),
  });

export const useInbox = (tab: InboxTab, intent?: string) =>
  useQuery({
    queryKey: qkQueue.inbox(tab, intent),
    queryFn: ({ signal }) => api.queue.inbox.list({ tab, intent: intent || undefined }, signal),
  });

export const useInboxItem = (id: string | null) =>
  useQuery({
    queryKey: qkQueue.inboxItem(id ?? ''),
    queryFn: ({ signal }) => api.queue.inbox.get(id as string, signal),
    enabled: !!id,
  });

function invalidateInbox(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['queue', 'inbox'] });
  void qc.invalidateQueries({ queryKey: qkQueue.overview });
}

export const useInboxAct = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { text?: string; create_task?: boolean } }) => api.queue.inbox.act(id, body),
    onSuccess: () => invalidateInbox(qc),
  });
};

export const useInboxAssign = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string }) => api.queue.inbox.assign(id, userId),
    onSuccess: () => invalidateInbox(qc),
  });
};

export const useInboxSilence = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, until }: { id: string; reason?: string | null; until?: string | null }) =>
      api.queue.inbox.silence(id, { reason, until }),
    onSuccess: () => invalidateInbox(qc),
  });
};

export interface TaskFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
  overdue?: boolean;
}

export const useTasks = (filters: TaskFilters) =>
  useQuery({
    queryKey: qkQueue.tasks(filters as Record<string, string | boolean | undefined>),
    queryFn: ({ signal }) => api.queue.tasks.list(filters, signal),
  });

export const useTask = (id: string | null) =>
  useQuery({
    queryKey: qkQueue.task(id ?? ''),
    queryFn: ({ signal }) => api.queue.tasks.get(id as string, signal),
    enabled: !!id,
  });

function invalidateTasks(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['queue', 'tasks'] });
  void qc.invalidateQueries({ queryKey: qkQueue.overview });
}

export const useCreateTask = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TaskCreateBody) => api.queue.tasks.create(body),
    onSuccess: () => invalidateTasks(qc),
  });
};

export const useUpdateTask = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: TaskPatchBody }) => api.queue.tasks.update(id, body),
    onSuccess: () => invalidateTasks(qc),
  });
};

export const usePromises = (status: 'upcoming' | 'overdue' | 'kept' | 'all') =>
  useQuery({
    queryKey: qkQueue.promises(status),
    queryFn: ({ signal }) => api.queue.tasks.promises.list({ status }, signal),
  });

export const useKeepPromise = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, kept }: { id: string; kept: boolean }) => api.queue.tasks.promises.keep(id, kept),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['queue', 'promises'] });
      void qc.invalidateQueries({ queryKey: qkQueue.overview });
    },
  });
};

// Realtime: cảnh báo mới → tải lại Hộp thư và Tổng quan (WS chỉ báo "có cảnh báo mới", không kèm dữ liệu).
onRealtimeEvent('alert.new', (qc) => invalidateInbox(qc));
