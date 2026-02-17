import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { apiClient } from '../api';
import { useToast } from '../ui/toast-provider';

interface SessionSummary {
  sessionId: string;
  expiresAt: string;
  status: string;
}

interface SessionsLocationState {
  sessions?: SessionSummary[];
}

export function SessionsListPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const state = (location.state ?? {}) as SessionsLocationState;

  const [sessions, setSessions] = useState<SessionSummary[]>(state.sessions ?? []);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime()),
    [sessions],
  );

  async function handleDeleteSession(sessionId: string) {
    const confirmed = window.confirm(`Delete session ${sessionId}? This action cannot be undone.`);
    if (!confirmed) {
      return;
    }

    setDeleteError(null);
    setDeletingSessionId(sessionId);
    try {
      await apiClient.delete<{ deleted: boolean }>(`/sessions/${sessionId}`);
      setSessions((current) => current.filter((session) => session.sessionId !== sessionId));
      showToast(`Session ${sessionId} deleted.`, 'success');
    } catch {
      setDeleteError('Unable to delete this session right now. Please try again.');
      showToast('Unable to delete this session right now. Please try again.', 'error');
    } finally {
      setDeletingSessionId(null);
    }
  }

  function formatDate(dateValue: string): string {
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) {
      return dateValue;
    }

    return date.toLocaleString();
  }

  return (
    <main className="page">
      <h1>Sessions</h1>
      <p className="muted">Open a session to continue uploading and managing statements.</p>

      {deleteError && <p className="text-error">{deleteError}</p>}

      {sortedSessions.length === 0 ? (
        <section className="card">
          <p>No sessions found from this link. Request a new magic link if needed.</p>
        </section>
      ) : (
        sortedSessions.map((session) => (
          <section className="card session-row" key={session.sessionId}>
            <div>
              <p><strong>{session.sessionId}</strong></p>
              <p className="muted">Expires: {formatDate(session.expiresAt)}</p>
              <p className="muted">Status: {session.status}</p>
            </div>
            <div className="actions">
              <button
                className="button"
                type="button"
                onClick={() => navigate(`/sessions/${session.sessionId}`)}
              >
                Open
              </button>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => handleDeleteSession(session.sessionId)}
                disabled={deletingSessionId === session.sessionId}
              >
                {deletingSessionId === session.sessionId ? 'Deleting...' : 'Delete session'}
              </button>
            </div>
          </section>
        ))
      )}

      <nav className="actions">
        <Link to="/">Back home</Link>
      </nav>
    </main>
  );
}
