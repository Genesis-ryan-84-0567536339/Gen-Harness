/**
 * v0.1.55 (G5) — truy vấn của Mặt tiền Owner (`/api/v1/owner/*`, CHỈ ĐỌC, chỉ Owner). Không có mutation nào: mọi thao tác
 * ghi dẫn link sâu tới luồng sẵn có. Vai trò khác Owner KHÔNG gọi (máy chủ trả 403) — `enabled` theo `Me.role`.
 */
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/api';
import { useMe } from '../lib/queries';
import { ownerEndpoints, type OwnerRelationList } from './ownerModel';

// TODO(v0155-integ): khi `endpoints.ts` nối `owner: ownerEndpoints(r)` thì đổi sang `api.owner`.
const ownerApi = ownerEndpoints(apiClient.request);

export const OWNER_KEYS = {
  all: ['owner'] as const,
  today: ['owner', 'today'] as const,
  tasks: ['owner', 'tasks'] as const,
  relations: (list: OwnerRelationList) => ['owner', 'relations', list] as const,
};

/** Hôm nay tự làm tươi mỗi 5 phút khi đang mở (không gọi model, chỉ đọc). */
const REFRESH_MS = 5 * 60_000;

export function useIsOwnerRole(): boolean {
  return useMe().data?.role?.code === 'owner';
}

export const useOwnerToday = () => {
  const owner = useIsOwnerRole();
  return useQuery({
    queryKey: OWNER_KEYS.today,
    queryFn: ({ signal }) => ownerApi.today(signal),
    enabled: owner,
    refetchInterval: owner ? REFRESH_MS : false,
  });
};

export const useOwnerRelations = (list: OwnerRelationList, limit = 20) => {
  const owner = useIsOwnerRole();
  return useQuery({
    queryKey: [...OWNER_KEYS.relations(list), limit] as const,
    queryFn: ({ signal }) => ownerApi.relations(list, limit, signal),
    enabled: owner,
  });
};

export const useOwnerTasks = () => {
  const owner = useIsOwnerRole();
  return useQuery({
    queryKey: OWNER_KEYS.tasks,
    queryFn: ({ signal }) => ownerApi.tasks(signal),
    enabled: owner,
    refetchInterval: owner ? REFRESH_MS : false,
  });
};
