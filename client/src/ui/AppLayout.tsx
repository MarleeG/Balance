import type { ReactNode } from 'react';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <main className="app-layout" id="main-content" tabIndex={-1}>
      <div className="app-container app-content">
        {children}
      </div>
    </main>
  );
}
