import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { MagicLinkVerifyPage } from './pages/MagicLinkVerifyPage';
import { SessionDashboardPage } from './pages/SessionDashboardPage';
import { SessionsListPage } from './pages/SessionsListPage';
import { ThemeToggle } from './theme/ThemeToggle';
import { ThemeProvider } from './theme/theme-provider';
import { ToastProvider } from './ui/toast-provider';

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <BrowserRouter>
          <header className="app-header">
            <div className="app-header-inner">
              <div className="brand">
                <span className="brand-mark" />
                <strong>Balance</strong>
              </div>
              <ThemeToggle />
            </div>
          </header>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/auth/verify" element={<MagicLinkVerifyPage />} />
            <Route path="/sessions" element={<SessionsListPage />} />
            <Route path="/sessions/:sessionId" element={<SessionDashboardPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
