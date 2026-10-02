import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type SidebarMode = 'full' | 'rail';
/** v0.1.23 (B7): `system` = theo cài đặt sáng/tối của máy. */
export type ThemePref = 'system' | 'light' | 'dark';

interface UiPrefs {
  /** Design prop `sidebarMode` — 244px full / 60px icon rail. */
  sidebarMode: SidebarMode;
  /** Design prop `showEnglish` — English subtitle under parent-level titles. v0.1.28 (UX N5): mặc định TẮT. */
  showEnglish: boolean;
  /** Explicit open/closed state per nav group (by group name); absent = auto. */
  navOpen: Record<string, boolean>;
  /** Lựa chọn giao diện gần nhất trên trình duyệt này (dùng cả trước khi đăng nhập — public/theme-init.js). */
  theme: ThemePref;
  /** Lựa chọn giao diện theo từng người dùng (id) — hai người dùng chung máy không đè lựa chọn của nhau. */
  themeByUser: Record<string, ThemePref>;
  /**
   * v0.1.30: thẻ "Việc thiết lập tiếp" người dùng (id) đã bấm "Ẩn" — lưu các bước còn dở lúc ẩn; có bước dở MỚI thì
   * thẻ hiện lại. Chỉ ẩn cho người đó trên trình duyệt này (lối vào cố định: menu tài khoản / thanh bên).
   */
  followUpHiddenByUser: Record<string, number[]>;
  /** Ngăn kéo điều hướng trên điện thoại (B4) — không lưu. */
  drawerOpen: boolean;
  /**
   * v0.1.42: domain thu gọn (Nâng cao) người dùng đã bấm mở/đóng — KHÔNG lưu (không nằm trong partialize): mở lại
   * trang là thu gọn như mặc định.
   */
  domainOpen: Record<string, boolean>;
  setSidebarMode: (m: SidebarMode) => void;
  toggleSidebarMode: () => void;
  setShowEnglish: (v: boolean) => void;
  setNavOpen: (group: string, open: boolean) => void;
  setTheme: (theme: ThemePref, userId?: string | null) => void;
  setDrawerOpen: (open: boolean) => void;
  setDomainOpen: (domain: string, open: boolean) => void;
  hideFollowUp: (userId: string, pending: number[]) => void;
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
      showEnglish: false,
      navOpen: {},
      theme: 'system',
      themeByUser: {},
      drawerOpen: false,
      domainOpen: {},
      followUpHiddenByUser: {},
      setSidebarMode: (sidebarMode) => set({ sidebarMode }),
      toggleSidebarMode: () => set((s) => ({ sidebarMode: s.sidebarMode === 'full' ? 'rail' : 'full' })),
      setShowEnglish: (showEnglish) => set({ showEnglish }),
      setNavOpen: (group, open) => set((s) => ({ navOpen: { ...s.navOpen, [group]: open } })),
      setTheme: (theme, userId) =>
        set((s) => ({ theme, themeByUser: userId ? { ...s.themeByUser, [userId]: theme } : s.themeByUser })),
      setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
      setDomainOpen: (domain, open) => set((s) => ({ domainOpen: { ...s.domainOpen, [domain]: open } })),
      hideFollowUp: (userId, pending) => set((s) => ({ followUpHiddenByUser: { ...s.followUpHiddenByUser, [userId]: [...pending] } })),
    }),
    {
      name: 'gh-ui',
      storage: safeStorage,
      // v1 (v0.1.28): phụ đề tiếng Anh chuyển sang mặc định tắt — tắt một lần cho trình duyệt đã lưu bản cũ (true
      // là mặc định cũ, không phải lựa chọn có chủ đích); người dùng bật lại ở menu tài khoản thì được giữ.
      version: 1,
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Partial<UiPrefs>;
        return version < 1 ? { ...s, showEnglish: false } : s;
      },
      partialize: (s) => ({
        sidebarMode: s.sidebarMode,
        showEnglish: s.showEnglish,
        navOpen: s.navOpen,
        theme: s.theme,
        themeByUser: s.themeByUser,
        followUpHiddenByUser: s.followUpHiddenByUser,
      }),
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
