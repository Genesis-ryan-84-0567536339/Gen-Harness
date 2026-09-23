import { Outlet } from 'react-router-dom';
import { PinDialogHost } from './shell/PinDialogHost';

export function RootLayout() {
  return (
    <>
      <Outlet />
      <PinDialogHost />
    </>
  );
}
