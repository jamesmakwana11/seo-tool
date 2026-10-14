import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter, MemoryRouter } from 'react-router-dom';

/**
 * Routing: browser history by default; VITE_ROUTER=hash for static hosting without a deep-link fallback;
 * VITE_ROUTER=memory for the hosted review build, which must not depend on the page URL at all.
 */
const Router = import.meta.env.VITE_ROUTER === 'memory' ? MemoryRouter : import.meta.env.VITE_ROUTER === 'hash' ? HashRouter : BrowserRouter;
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './index.css';
import { AuthProvider } from '@/auth/AuthContext';
import { ToastProvider } from '@/components/ui/Toast';
import { AppRoutes } from '@/routes';

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 15000, refetchOnWindowFocus: false } } });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </Router>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
