import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { FileLabelsPage } from './pages/FileLabelsPage';
import { MagicLinkVerifyPage } from './pages/MagicLinkVerifyPage';
import { SessionDashboardPage } from './pages/SessionDashboardPage';
import { SessionInsightsPage } from './pages/SessionInsightsPage';
import { SessionsListPage } from './pages/SessionsListPage';
import { ThemeToggle } from './theme/ThemeToggle';
import { ThemeProvider } from './theme/theme-provider';
import { ToastProvider } from './ui/toast-provider';

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <BrowserRouter>
          <a className="skip-link" href="#main-content">Skip to main content</a>
          <header className="app-header">
            <div className="app-container app-header-inner">
              <Link className="brand" to="/" aria-label="Balance home">
                <span className="brand-mark" />
                <strong>Balance</strong>
              </Link>
              <ThemeToggle />
            </div>
          </header>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/auth/verify" element={<MagicLinkVerifyPage />} />
            <Route path="/sessions" element={<SessionsListPage />} />
            <Route path="/sessions/:sessionId" element={<SessionDashboardPage />} />
            <Route path="/sessions/:sessionId/insights" element={<SessionInsightsPage />} />
            <Route path="/sessions/:sessionId/files/:fileId/labels" element={<FileLabelsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
