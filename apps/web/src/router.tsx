import { Navigate, createBrowserRouter, type RouteObject } from 'react-router-dom';
import { buildScreenTree } from '@gen-harness/contracts';
import { setNavigator } from './lib/navigation';
import { UrlStateSync } from './lib/uiStore';
import { LoginPage } from './pages/LoginPage';
import { AccountPage } from './account/AccountPage';
import { ForcePasswordPage } from './account/ForcePasswordPage';
import { GuidePage } from './guide/GuidePage';
import { HelpPage } from './help/HelpPage';
import { GuideStepPage } from './guide/GuideStepPage';
import { ScreenPage } from './screens/ScreenPage';
import { NotFoundPage, RouteErrorPage } from './shell/ErrorPage';
import { SetupPage } from './setup/SetupPage';
import { AppShell } from './shell/AppShell';
import { ACCOUNT_CRUMBS, HELP_CRUMBS, SOCIAL_CRUMBS, type RouteHandle } from './shell/routeHandles';
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
          { index: true, element: <Navigate to="/overview" replace /> },
          ...buildConsoleRoutes(),
          // Hướng dẫn kết nối từng bước (việc "Để sau" 5–11) — mở từ thẻ Việc thiết lập tiếp ở Tổng quan.
          { path: 'guide', element: <GuidePage /> },
          { path: 'guide/:n', element: <GuideStepPage /> },
          // Tài khoản của tôi (v0.1.19) — mở từ khối tài khoản ở chân thanh bên.
          { path: 'account', handle: { page: ACCOUNT_CRUMBS } satisfies RouteHandle, element: <AccountPage /> },
          // Trợ giúp / Giới thiệu (v0.1.22) — phiên bản, hỏi Gen, lệnh genh, Báo lỗi.
          { path: 'help', handle: { page: HELP_CRUMBS } satisfies RouteHandle, element: <HelpPage /> },
          // Tài khoản mạng xã hội (v0.1.29, chỉ Owner) — mở từ menu tài khoản ở chân thanh bên.
          { path: 'social', handle: { page: SOCIAL_CRUMBS } satisfies RouteHandle, element: <SocialPage /> },
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
