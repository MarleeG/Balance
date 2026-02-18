import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, apiClient, getAccessToken } from '../api';
import { AppLayout } from '../ui/AppLayout';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/toast-provider';

interface SessionSummary {
  sessionId: string;
  createdAt?: string;
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
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => {
      const aTime = new Date(a.createdAt ?? a.expiresAt).getTime();
      const bTime = new Date(b.createdAt ?? b.expiresAt).getTime();
      return bTime - aTime;
    }),
    [sessions],
  );

  useEffect(() => {
    let isActive = true;
    const abortController = new AbortController();

    async function loadSessions() {
      setIsLoading(true);
      setLoadError(null);

      if (!getAccessToken()) {
        if (!isActive) {
          return;
        }

        setLoadError('To access your sessions, continue via email link.');
        setIsLoading(false);
        return;
      }

      try {
        const fetchedSessions = await apiClient.get<SessionSummary[]>(
          '/sessions',
          { signal: abortController.signal },
        );

        if (!isActive) {
          return;
        }

        setSessions(fetchedSessions ?? []);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        if (!isActive) {
          return;
        }

        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          setLoadError('To access your sessions, continue via email link.');
        } else {
          setLoadError('Unable to load your sessions right now. Please try again.');
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    loadSessions();

    return () => {
      isActive = false;
      abortController.abort();
    };
  }, []);

  async function handleDeleteSession(sessionId: string) {
    setDeleteError(null);
    setDeletingSessionId(sessionId);
    try {
      await apiClient.delete<{ deleted: boolean }>(`/sessions/${sessionId}`);
      setSessions((current) => current.filter((session) => session.sessionId !== sessionId));
      showToast(`Session ${sessionId} deleted.`, 'success');
      setPendingDeleteSessionId(null);
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
    <AppLayout>
      <h1>Sessions</h1>
      <p className="muted page-lead">Open a session to continue uploading and managing statements.</p>

      {deleteError && <p className="text-error" role="alert">{deleteError}</p>}
      {loadError && (
        <section className="card">
          <p className="text-error" role="alert">{loadError}</p>
          <div className="actions">
            <Link className="button button-secondary" to="/#continue-session">Continue via email link</Link>
          </div>
        </section>
      )}

      {!loadError && isLoading ? (
        <section className="card">
          <p role="status">Loading sessions...</p>
        </section>
      ) : !loadError && sortedSessions.length === 0 ? (
        <section className="card">
          <p role="status">No sessions found from this link. Request a new magic link if needed.</p>
        </section>
      ) : !loadError ? (
        <div className="sessions-list" role="list" aria-label="Available sessions" aria-busy={deletingSessionId !== null}>
          <div className="sessions-list-head" aria-hidden="true">
            <span>Session</span>
            <span>Created</span>
            <span>Expires</span>
            <span>Status</span>
            <span>Actions</span>
          </div>
          {sortedSessions.map((session) => (
            <section className="card session-item" key={session.sessionId} role="listitem">
              <div className="session-details">
                <p className="session-id"><strong>{session.sessionId}</strong></p>
                <p className="session-meta muted">
                  <span className="session-meta-label">Created</span>
                  <span>{session.createdAt ? formatDate(session.createdAt) : 'Not available'}</span>
                </p>
                <p className="session-meta muted">
                  <span className="session-meta-label">Expires</span>
                  <span>{formatDate(session.expiresAt)}</span>
                </p>
                <p className="session-meta muted">
                  <span className="session-meta-label">Status</span>
                  <span>{session.status}</span>
                </p>
              </div>
              <div className="session-actions">
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
                  onClick={() => setPendingDeleteSessionId(session.sessionId)}
                  disabled={deletingSessionId === session.sessionId}
                >
                  {deletingSessionId === session.sessionId ? 'Deleting...' : 'Delete session'}
                </button>
              </div>
            </section>
          ))}
        </div>
      ) : null}

      <nav className="actions">
        <Link to="/">Back home</Link>
      </nav>

      <ConfirmDialog
        open={pendingDeleteSessionId !== null}
        title="Delete session?"
        message={
          pendingDeleteSessionId
            ? `This will permanently remove session ${pendingDeleteSessionId}.`
            : 'This will permanently remove this session.'
        }
        confirmLabel="Delete session"
        destructive
        busy={Boolean(deletingSessionId)}
        onCancel={() => setPendingDeleteSessionId(null)}
        onConfirm={() => {
          if (!pendingDeleteSessionId) {
            return;
          }
          return handleDeleteSession(pendingDeleteSessionId);
        }}
      />
    </AppLayout>
  );
}
