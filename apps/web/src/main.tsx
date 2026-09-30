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
import './styles/p3-core.css';
import './styles/p3-queue.css';
import './styles/p3-relations.css';
import './styles/p3-graph.css';
import './styles/p3-market.css';
import './styles/p3-people.css';
import './styles/p4-agents.css';
import './styles/p4-api.css';
import './styles/p4-mcp.css';
import './styles/p4-plugins.css';
import './styles/system.css';
import './styles/account.css';
import './styles/gen.css';
import './styles/notifications.css';
import './styles/social.css';
import './styles/errors.css';
import './styles/theme.css';
import { queryClient } from './lib/queryClient';
import { createAppRouter } from './router';
import { ErrorBoundary } from './shell/ErrorPage';

const router = createAppRouter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary variant="page">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
