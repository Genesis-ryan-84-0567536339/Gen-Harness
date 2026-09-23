import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@gen-harness/tokens/tokens.css';
import '@gen-harness/ui/styles.css';
import './styles/global.css';
import './styles/shell.css';
import './styles/setup.css';
import './styles/data.css';
import './styles/system.css';
import { queryClient } from './lib/queryClient';
import { createAppRouter } from './router';

const router = createAppRouter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
