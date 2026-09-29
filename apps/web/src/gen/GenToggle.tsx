import { IconButton } from '@gen-harness/ui';
import { useMe } from '../lib/queries';
import { useGenStore } from './genStore';

/** Nút bật/tắt khung Gen ở Header — chỉ hiện khi Gen bật cho người này (`Me.features.gen`). */
export function GenToggle() {
  const me = useMe();
  const id = me.data?.id;
  const open = useGenStore((s) => (id ? !!s.openByUser[id] : false));
  const setOpen = useGenStore((s) => s.setOpen);
  if (!id || !me.data?.features?.gen) return null;
  return (
    <IconButton
      icon="ph ph-sparkle"
      label={open ? 'Đóng Gen' : 'Hỏi Gen — trợ lý quản trị'}
      className="hd-gen"
      aria-pressed={open}
      onClick={() => setOpen(id, !open)}
    />
  );
}
