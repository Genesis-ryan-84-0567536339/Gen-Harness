import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { buildScreenTree } from '@gen-harness/contracts';
import { setNavigator } from './lib/navigation';
import { UrlStateSync } from './lib/uiStore';
import { LoginPage } from './pages/LoginPage';
import { AccountPage } from './account/AccountPage';
import { ForcePasswordPage } from './account/ForcePasswordPage';
import { BossChecksPage } from './guide/BossChecksPage';
import { GuidePage } from './guide/GuidePage';
import { HelpPage } from './help/HelpPage';
import { GuideStepPage } from './guide/GuideStepPage';
import { ScreenPage } from './screens/ScreenPage';
import { NotFoundPage, RouteErrorPage } from './shell/ErrorPage';
import { SetupPage } from './setup/SetupPage';
import { AppShell } from './shell/AppShell';
import { ACCOUNT_CRUMBS, BOSS_CHECKS_CRUMBS, GUIDE_CRUMBS, HELP_CRUMBS, SOCIAL_CRUMBS, type RouteHandle } from './shell/routeHandles';
import { HomeRedirect } from './shell/HomeRedirect';
import { SocialPage } from './social/SocialPage';
import { RootLayout } from './RootLayout';

/**
 * One route per screen key (docs/design/screens.json), nested
 * domain › parent group › screen with pathless layout routes so the header
 * breadcrumb comes from the same tree as the sidebar. URLs stay flat (/inbox).
 */
export function buildConsoleRoutes(): RouteObject[] {
  return buildScreenTree().map((d) => ({
    id: `domain:${d.id}`,
    handle: { domain: d.id } satisfies RouteHandle,
    children: d.entries.flatMap((e): RouteObject[] => {
      if (e.kind === 'screen') {
        return [{ path: e.screen.key, handle: { screen: e.screen.key } satisfies RouteHandle, element: <ScreenPage screenKey={e.screen.key} /> }];
      }
      const g = e.group;
      const own: RouteObject[] = g.key
        ? [{ path: g.key, handle: { screen: g.key } satisfies RouteHandle, element: <ScreenPage screenKey={g.key} /> }]
        : [];
      return [
        ...own,
        {
          id: `group:${g.name}`,
          handle: { group: g.name } satisfies RouteHandle,
          children: g.children.map((s) => ({
            path: s.key,
            handle: { screen: s.key } satisfies RouteHandle,
            element: <ScreenPage screenKey={s.key} />,
          })),
        },
      ];
    }),
  }));
}

export const routes: RouteObject[] = [
  {
    element: (
      <>
        <UrlStateSync />
        <RootLayout />
      </>
    ),
    // B5: lỗi vẽ/tải trong route → trang lỗi có mã thay cho trang lỗi mặc định của react-router.
    errorElement: <RouteErrorPage />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/setup', element: <SetupPage /> },
      // v0.1.19: mật khẩu tạm sau `genh reset-password` — AppShell chuyển mọi màn Console về đây tới khi đổi xong.
      { path: '/change-password', element: <ForcePasswordPage /> },
      {
        path: '/',
        element: <AppShell />,
        children: [
          // v0.1.42 (F-26): "/" → màn đầu tiên KHÔNG ẩn của vai trò (GET /navigation), giữ ?gen=.
          { index: true, element: <HomeRedirect /> },
          ...buildConsoleRoutes(),
          // Hướng dẫn thiết lập (việc "Để sau" 5–11 + Facebook, Gen-hub) — mở từ thẻ Việc thiết lập tiếp ở Tổng quan.
          // v0.1.42 (F-66): có breadcrumb riêng, tô sáng Cài đặt trên thanh bên.
          { path: 'guide', handle: { page: GUIDE_CRUMBS, navKey: 'system' } satisfies RouteHandle, element: <GuidePage /> },
          // v0.1.39 (F-74): "Việc Sếp cần làm" — đặt TRƯỚC `guide/:n`.
          { path: 'guide/viec-sep', handle: { page: BOSS_CHECKS_CRUMBS, navKey: 'system' } satisfies RouteHandle, element: <BossChecksPage /> },
          { path: 'guide/:n', handle: { page: GUIDE_CRUMBS, navKey: 'system' } satisfies RouteHandle, element: <GuideStepPage /> },
          // Tài khoản của tôi (v0.1.19) — mở từ khối tài khoản ở chân thanh bên và từ Cài đặt.
          { path: 'account', handle: { page: ACCOUNT_CRUMBS, navKey: 'system' } satisfies RouteHandle, element: <AccountPage /> },
          // Trợ giúp / Giới thiệu (v0.1.22) — phiên bản, hỏi Gen, lệnh genh, Báo lỗi.
          { path: 'help', handle: { page: HELP_CRUMBS, navKey: 'system' } satisfies RouteHandle, element: <HelpPage /> },
          // Tài khoản mạng xã hội (v0.1.29, chỉ Owner) — mở từ thẻ Facebook ở Kết nối và menu tài khoản.
          { path: 'social', handle: { page: SOCIAL_CRUMBS, navKey: 'connections' } satisfies RouteHandle, element: <SocialPage /> },
          // B5: trang 404 trong khung Console (thanh bên vẫn dùng được).
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export function createAppRouter() {
  const router = createBrowserRouter(routes);
  setNavigator((to, opts) => void router.navigate(to, opts));
  return router;
}
