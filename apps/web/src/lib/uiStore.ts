import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type SidebarMode = 'full' | 'rail';

interface UiPrefs {
  /** Design prop `sidebarMode` — 244px full / 60px icon rail. */
  sidebarMode: SidebarMode;
  /** Design prop `showEnglish` — English subtitle under parent-level titles. */
  showEnglish: boolean;
  /** Explicit open/closed state per nav group (by group name); absent = auto. */
  navOpen: Record<string, boolean>;
  setSidebarMode: (m: SidebarMode) => void;
  toggleSidebarMode: () => void;
  setShowEnglish: (v: boolean) => void;
  setNavOpen: (group: string, open: boolean) => void;
}

const safeStorage = createJSONStorage<Partial<UiPrefs>>(() => {
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

/** Per-viewer layout preferences (persisted in localStorage). */
export const useUiStore = create<UiPrefs>()(
  persist(
    (set) => ({
      sidebarMode: 'full',
      showEnglish: true,
      navOpen: {},
      setSidebarMode: (sidebarMode) => set({ sidebarMode }),
      toggleSidebarMode: () => set((s) => ({ sidebarMode: s.sidebarMode === 'full' ? 'rail' : 'full' })),
      setShowEnglish: (showEnglish) => set({ showEnglish }),
      setNavOpen: (group, open) => set((s) => ({ navOpen: { ...s.navOpen, [group]: open } })),
    }),
    {
      name: 'gh-ui',
      storage: safeStorage,
      partialize: (s) => ({ sidebarMode: s.sidebarMode, showEnglish: s.showEnglish, navOpen: s.navOpen }),
    },
  ),
);

// ── Screen state mirrored into the URL query (tabs, filters, expanded rows) ──
// docs/handoff/07 §5: "Bộ lọc, tab, mục mở rộng phản ánh vào URL; tải lại giữ nguyên".

interface UrlState {
  params: Record<string, string>;
  hydrate: (search: string) => void;
}

export const useUrlStateStore = create<UrlState>((set) => ({
  params: {},
  hydrate: (search) => set({ params: Object.fromEntries(new URLSearchParams(search)) }),
}));

/** Keeps the URL-state store in step with the location. Mount once inside the router. */
export function UrlStateSync(): null {
  const { search } = useLocation();
  useEffect(() => {
    useUrlStateStore.getState().hydrate(search);
  }, [search]);
  return null;
}

/**
 * `const [tab, setTab] = useUrlState('tab', 'channels')` — reads from the
 * store (hydrated from the URL) and writes back with history.replace.
 */
export function useUrlState<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const value = useUrlStateStore((s) => s.params[key]) as T | undefined;
  const navigate = useNavigate();
  const location = useLocation();
  const set = useCallback(
    (v: T) => {
      const qs = new URLSearchParams(location.search);
      if (v === fallback) qs.delete(key);
      else qs.set(key, v);
      const s = qs.toString();
      useUrlStateStore.setState((st) => {
        const params = { ...st.params };
        if (v === fallback) delete params[key];
        else params[key] = v;
        return { params };
      });
      navigate({ pathname: location.pathname, search: s ? `?${s}` : '' }, { replace: true });
    },
    [fallback, key, location.pathname, location.search, navigate],
  );
  return [value ?? fallback, set];
}
