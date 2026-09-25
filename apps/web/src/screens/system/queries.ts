/**
 * Hook đọc/ghi cho 3 tab mới của Điều khiển hệ thống (Quyền hạn, Nhật ký, Dữ liệu & lưu trữ — PLAN 4.5) +
 * bước thiết lập 10–11 (PLAN 4.6). "Bộ não AI" dùng lại `useProviders`/`useCliProfiles` (`lib/dataQueries.ts`)
 * và `useFailoverRules` (`screens/api/queries.ts`) — không có hook riêng ở đây.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Boundary, BoundaryPatchBody, DataRequestKind, PermissionPatchBody, RetentionPatchBody, SystemAuditQuery } from '@gen-harness/contracts';
import { api } from '../../lib/api';

export const qkSystem = {
  permissions: ['system', 'permissions'] as const,
  listeningGroups: ['system', 'listening-groups'] as const,
  boundaries: ['system', 'boundaries'] as const,
  auditLog: (q: SystemAuditQuery) => ['system', 'audit-log', q] as const,
  retention: ['system', 'retention'] as const,
  dataRequests: (personId: string) => ['system', 'data-requests', personId] as const,
};

export const usePermissions = () => useQuery({ queryKey: qkSystem.permissions, queryFn: ({ signal }) => api.permissions.get(signal) });

export const usePatchPermission = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PermissionPatchBody) => api.permissions.patch(body),
    onSuccess: (page) => qc.setQueryData(qkSystem.permissions, page),
  });
};

export const useListeningGroups = () =>
  useQuery({ queryKey: qkSystem.listeningGroups, queryFn: ({ signal }) => api.listeningGroups(signal) });

export const useBoundaries = () => useQuery({ queryKey: qkSystem.boundaries, queryFn: ({ signal }) => api.boundaries.list(signal) });

export const usePatchBoundary = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, body }: { code: string; body: BoundaryPatchBody }) => api.boundaries.patch(code, body),
    onSuccess: (row) => qc.setQueryData<Boundary[]>(qkSystem.boundaries, (old) => old?.map((b) => (b.code === row.code ? row : b))),
  });
};

export const useSystemAuditLog = (q: SystemAuditQuery) =>
  useQuery({ queryKey: qkSystem.auditLog(q), queryFn: ({ signal }) => api.systemAuditLog.list(q, signal) });

export const useExportAuditLog = () => useMutation({ mutationFn: (q: Omit<SystemAuditQuery, 'cursor' | 'limit'>) => api.systemAuditLog.exportCsv(q) });

export const useRetentionPolicies = () => useQuery({ queryKey: qkSystem.retention, queryFn: ({ signal }) => api.retentionPolicies.list(signal) });

export const usePatchRetention = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RetentionPatchBody) => api.retentionPolicies.patch(body),
    onSuccess: (list) => qc.setQueryData(qkSystem.retention, list),
  });
};

export const usePersonDataRequests = (personId: string, enabled: boolean) =>
  useQuery({ queryKey: qkSystem.dataRequests(personId), queryFn: ({ signal }) => api.personDataRequests.list(personId, signal), enabled });

export const useCreateDataRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ personId, kind }: { personId: string; kind: DataRequestKind }) => api.personDataRequests.create(personId, kind),
    onSuccess: (_r, { personId }) => void qc.invalidateQueries({ queryKey: qkSystem.dataRequests(personId) }),
  });
};
