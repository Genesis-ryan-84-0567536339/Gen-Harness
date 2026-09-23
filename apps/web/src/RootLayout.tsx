import { Outlet } from 'react-router-dom';
import { PinDialogHost } from './shell/PinDialogHost';
import { ToastHost } from './shell/ToastHost';

export function RootLayout() {
  return (
    <>
      <Outlet />
      <PinDialogHost />
      <ToastHost />
    </>
  );
}
