import { Toaster } from 'sonner';
import { QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { queryClientInstance } from '@/lib/query-client';
import ErrorBoundary from '@/components/ErrorBoundary';
import Home from '@/pages/Home';

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClientInstance}>
        <HashRouter>
          <Routes>
            <Route path="*" element={<Home />} />
          </Routes>
        </HashRouter>
        <Toaster position="bottom-right" theme="dark" />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
