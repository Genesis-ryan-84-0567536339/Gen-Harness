/** Presentation helpers dùng chung cho 4 màn của cụm Hàng đợi & Hành động. */
import type { InboxItemType, InboxTab, QueueWidgetKind, TaskPriority, TaskStatus } from '@gen-harness/contracts';

export const OK = 'var(--color-ok)';
export const WARN = 'var(--color-warn)';
export const BAD = 'var(--color-bad)';
export const ACC3 = 'var(--color-accent-300)';
export const ACC4 = 'var(--color-accent-400)';
export const N3 = 'var(--color-neutral-300)';
export const N4 = 'var(--color-neutral-400)';
export const N5 = 'var(--color-neutral-500)';
export const N8 = 'var(--color-neutral-800)';

export const PRIORITY_LABEL: Record<string, string> = { P1: 'P1', P2: 'P2', P3: 'P3' };
export function priorityTone(p: string): string {
  return p === 'P1' ? BAD : p === 'P2' ? WARN : N4;
}

export const TAB_LABEL: Record<InboxTab, string> = {
  all: 'Tất cả',
  opportunity: 'Cơ hội',
  alert: 'Cảnh báo',
  approval: 'Chờ duyệt',
  reply: 'Cần soạn',
  candidate: 'Ứng viên',
};

export const ITEM_TYPE_TAG: Record<InboxItemType, string> = {
  unit: 'Ý NGHĨA',
  alert: 'CẢNH BÁO',
  draft: 'CHỜ DUYỆT',
};

export function itemTag(item: { item_type: InboxItemType; tab: InboxTab }): string {
  if (item.item_type === 'alert') return 'CẢNH BÁO';
  if (item.item_type === 'draft') return 'CHỜ DUYỆT';
  if (item.tab === 'opportunity') return 'CƠ HỘI';
  if (item.tab === 'candidate') return 'ỨNG VIÊN';
  return 'CẦN SOẠN';
}

export function itemTagTone(item: { item_type: InboxItemType; tab: InboxTab }): string {
  if (item.item_type === 'alert') return BAD;
  if (item.item_type === 'draft') return WARN;
  if (item.tab === 'opportunity') return OK;
  if (item.tab === 'candidate') return ACC3;
  return ACC4;
}

const CONF_LABEL: Record<string, { color: string }> = {
  cao: { color: OK },
  'trung bình': { color: WARN },
  thấp: { color: BAD },
};
export function confidenceTone(band: string | null): string {
  return band ? (CONF_LABEL[band]?.color ?? N4) : N5;
}

export const QUEUE_KIND_LABEL: Record<QueueWidgetKind, string> = {
  opportunity: 'CƠ HỘI',
  alert: 'CẢNH BÁO',
  draft: 'CHỜ DUYỆT',
  due: 'ĐẾN HẠN',
};
export function queueKindTone(k: QueueWidgetKind): string {
  return k === 'opportunity' ? OK : k === 'alert' ? BAD : k === 'draft' ? WARN : N4;
}
export function queueKindIcon(k: QueueWidgetKind): string {
  switch (k) {
    case 'opportunity':
      return 'ph ph-target';
    case 'alert':
      return 'ph ph-warning';
    case 'draft':
      return 'ph ph-pen-nib';
    default:
      return 'ph ph-clock';
  }
}
export const QUEUE_ACTION_LABEL: Record<QueueWidgetKind, string> = {
  opportunity: 'Xem trong Hộp thư',
  alert: 'Mở hồ sơ',
  draft: 'Xem bản nháp',
  due: 'Mở việc',
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'Chưa làm',
  doing: 'Đang làm',
  done: 'Đã xong',
  cancelled: 'Đã huỷ',
};
export function taskStatusTone(s: TaskStatus): string {
  return s === 'done' ? OK : s === 'cancelled' ? N5 : s === 'doing' ? ACC4 : N4;
}
export function taskPriorityTone(p: TaskPriority): string {
  return priorityTone(p);
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const last = parts.at(-1)?.[0] ?? '';
  const first = parts[0]?.[0] ?? '';
  return (first + last).toLocaleUpperCase('vi').slice(0, 2) || '·';
}

export const SPOTLIGHT_DIMENSION_LABEL: Record<string, string> = {
  heat: 'Độ nóng',
  churn_risk: 'Rủi ro mất khách',
};
