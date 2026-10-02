import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * Ô chọn người / trợ lý THẬT (v0.1.35, F-1) — dùng chung cho «Giao cho người khác» (Hộp thư), «Gán người xử lý»
 * (Vụ việc), «Gán BOT trực nhóm» / BOT của một người (Nhóm & Con người) và bộ lọc «Phụ trách» (Bản đồ quan hệ).
 * Không bao giờ quay về danh sách cứng: lỗi → màn hiện lỗi, rỗng → màn hiện hướng dẫn.
 */
export const qkPickers = {
  users: ['pickers', 'users'] as const,
  agents: ['pickers', 'agents'] as const,
};

export interface PickerOption {
  id: string;
  label: string;
}

/** Nhãn của người đang đăng nhập trong mọi ô chọn người. */
export const ME_LABEL = 'Tôi';
export const EMPTY_USERS_TEXT = 'Chưa có người dùng nào khác — mời thêm ở Người dùng';
export const EMPTY_AGENTS_TEXT = 'Chưa có trợ lý nào đang bật — tạo ở Danh tính Agent';

const STALE_MS = 60_000;

/** Người có thể được giao việc — người đang đăng nhập là "Tôi" và đứng đầu; còn lại giữ thứ tự tên của API. */
export function useAssignees(opts: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: qkPickers.users,
    queryFn: ({ signal }) => api.pickers.users(signal),
    staleTime: STALE_MS,
    enabled: opts.enabled ?? true,
  });
  const data = query.data;
  const options = useMemo<PickerOption[]>(() => {
    const items = data?.items ?? [];
    return [
      ...items.filter((u) => u.me).map((u) => ({ id: u.id, label: ME_LABEL })),
      ...items.filter((u) => !u.me).map((u) => ({ id: u.id, label: u.name })),
    ];
  }, [data]);
  /** Có người nào khác ngoài người đang đăng nhập không (để hiện gợi ý "mời thêm"). */
  const hasOthers = (data?.items ?? []).some((u) => !u.me);
  return { options, hasOthers, query };
}

/** Trợ lý (agent) đang bật — để gán BOT. */
export function useAgentOptions(opts: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: qkPickers.agents,
    queryFn: ({ signal }) => api.pickers.agents(signal),
    staleTime: STALE_MS,
    enabled: opts.enabled ?? true,
  });
  const data = query.data;
  const options = useMemo<PickerOption[]>(() => (data?.items ?? []).map((a) => ({ id: a.id, label: a.name })), [data]);
  return { options, query };
}
