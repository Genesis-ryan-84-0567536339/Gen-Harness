/**
 * Trạng thái khung chat Gen (docs/design/gen-v1.md §3.1). Mở/đóng nhớ THEO NGƯỜI DÙNG (localStorage, khoá theo id) —
 * đổi tài khoản trên cùng máy không kéo theo trạng thái của người khác. Hội thoại lấy từ server, không lưu máy.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { GenStep, TourStep } from '@gen-harness/contracts';

export interface GenChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  /** Bước của câu trả lời theo `seq` (WS và polling có thể tới trùng — ghép theo seq). */
  steps: GenStep[];
  turnId?: string;
  status?: 'running' | 'done' | 'failed';
}

export interface SpotlightState {
  target: string;
  message: string;
  /** Tour đang chạy: bước hiện tại `index` trong `steps`. */
  tour?: { steps: TourStep[]; index: number; turnId?: string };
  /** Không tìm thấy phần tử sau thời gian chờ. */
  missing?: boolean;
  waitFor?: 'click' | 'none';
}

interface GenState {
  openByUser: Record<string, boolean>;
  conversationId: string | null;
  messages: GenChatMessage[];
  busy: boolean;
  spotlight: SpotlightState | null;
  setOpen: (userId: string, open: boolean) => void;
  reset: () => void;
  setSpotlight: (s: SpotlightState | null) => void;
}

const safeStorage = createJSONStorage<Pick<GenState, 'openByUser'>>(() => {
  try {
    return window.localStorage;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  }
});

export const useGenStore = create<GenState>()(
  persist(
    (set) => ({
      openByUser: {},
      conversationId: null,
      messages: [],
      busy: false,
      spotlight: null,
      setOpen: (userId, open) => set((s) => ({ openByUser: { ...s.openByUser, [userId]: open } })),
      reset: () => set({ conversationId: null, messages: [], busy: false }),
      setSpotlight: (spotlight) => set({ spotlight }),
    }),
    { name: 'gh-gen', storage: safeStorage, partialize: (s) => ({ openByUser: s.openByUser }) },
  ),
);

/** Ghép bước mới vào tin trả lời của lượt `turnId`; trả `true` nếu bước là mới (chưa thấy seq này). */
export function mergeStep(turnId: string, seq: number, step: GenStep): boolean {
  let fresh = false;
  useGenStore.setState((s) => ({
    messages: s.messages.map((m) => {
      if (m.role !== 'assistant' || m.turnId !== turnId) return m;
      if (m.steps[seq] !== undefined) return m;
      fresh = true;
      const steps = [...m.steps];
      steps[seq] = step;
      return { ...m, steps };
    }),
  }));
  return fresh;
}
