import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, apiClient } from '../api';
import { useToast } from '../ui/toast-provider';

interface CreateSessionResponse {
  sessionId: string;
  email: string;
  expiresAt: string;
}

interface GenericMessageResponse {
  message?: string;
}

const CONTINUE_GENERIC_MESSAGE = "If we found your session, you'll receive an email shortly.";
const FIND_GENERIC_MESSAGE = "If we found sessions, you'll receive an email shortly.";

function toApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const payload = error.payload;
    if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
      return payload.message;
    }
  }

  return fallback;
}

export function HomePage() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [startEmail, setStartEmail] = useState('');
  const [createdSession, setCreatedSession] = useState<CreateSessionResponse | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  const [continueEmail, setContinueEmail] = useState('');
  const [continueSessionId, setContinueSessionId] = useState('');
  const [isContinuing, setIsContinuing] = useState(false);
  const [continueNotice, setContinueNotice] = useState<string | null>(null);
  const [continueError, setContinueError] = useState<string | null>(null);

  const [findEmail, setFindEmail] = useState('');
  const [isFinding, setIsFinding] = useState(false);
  const [findNotice, setFindNotice] = useState<string | null>(null);
  const [findError, setFindError] = useState<string | null>(null);

  async function handleStartSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStartError(null);
    setCopyState('idle');
    setCreatedSession(null);

    const email = startEmail.trim().toLowerCase();
    if (!email) {
      setStartError('Email is required.');
      return;
    }

    setIsStarting(true);
    try {
      const response = await apiClient.post<CreateSessionResponse>(
        '/sessions',
        { email },
        { skipAuth: true },
      );
      setCreatedSession(response);
      showToast(`Session ${response.sessionId} created.`, 'success');
    } catch (error) {
      const message = toApiErrorMessage(error, 'Unable to start a session right now. Please try again.');
      setStartError(message);
      showToast(message, 'error');
    } finally {
      setIsStarting(false);
    }
  }

  async function handleContinueSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setContinueError(null);
    setContinueNotice(null);

    const email = continueEmail.trim().toLowerCase();
    const sessionId = continueSessionId.trim();
    if (!email || !sessionId) {
      setContinueError('Email and session ID are required.');
      return;
    }

    setIsContinuing(true);
    try {
      const response = await apiClient.post<GenericMessageResponse>(
        '/auth/request-link',
        { email, sessionId },
        { skipAuth: true },
      );
      const message = response.message ?? CONTINUE_GENERIC_MESSAGE;
      setContinueNotice(message);
      showToast(message, 'info');
    } catch {
      setContinueNotice(CONTINUE_GENERIC_MESSAGE);
      showToast(CONTINUE_GENERIC_MESSAGE, 'info');
    } finally {
      setIsContinuing(false);
    }
  }

  async function handleFindSessions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFindError(null);
    setFindNotice(null);

    const email = findEmail.trim().toLowerCase();
    if (!email) {
      setFindError('Email is required.');
      return;
    }

    setIsFinding(true);
    try {
      const response = await apiClient.post<GenericMessageResponse>(
        '/auth/request-sessions',
        { email },
        { skipAuth: true },
      );
      const message = response.message ?? FIND_GENERIC_MESSAGE;
      setFindNotice(message);
      showToast(message, 'info');
    } catch {
      setFindNotice(FIND_GENERIC_MESSAGE);
      showToast(FIND_GENERIC_MESSAGE, 'info');
    } finally {
      setIsFinding(false);
    }
  }

  async function handleCopySessionId() {
    if (!createdSession?.sessionId) {
      return;
    }

    try {
      await navigator.clipboard.writeText(createdSession.sessionId);
      setCopyState('copied');
      showToast('Session ID copied.', 'success');
    } catch {
      setCopyState('error');
      showToast('Could not copy session ID.', 'error');
    }
  }

  return (
    <main className="page">
      <h1>Balance</h1>
      <p className="muted">Start a session, continue a session, or find your sessions.</p>

      <section className="card">
        <h2>Start Session</h2>
        <form className="form-grid" onSubmit={handleStartSession}>
          <label className="field">
            <span>Email</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={startEmail}
              onChange={(event) => setStartEmail(event.target.value)}
              required
            />
          </label>

          <button className="button" type="submit" disabled={isStarting}>
            {isStarting ? 'Starting...' : 'Start Session'}
          </button>
        </form>

        {startError && <p className="text-error">{startError}</p>}

        {createdSession && (
          <div className="result-box">
            <p>
              <strong>Session ID:</strong> {createdSession.sessionId}
            </p>
            <div className="actions">
              <button className="button button-secondary" type="button" onClick={handleCopySessionId}>
                Copy session ID
              </button>
              <button
                className="button"
                type="button"
                onClick={() => navigate(`/sessions/${createdSession.sessionId}`)}
              >
                Upload statements
              </button>
            </div>
            {copyState === 'copied' && <p className="text-success">Session ID copied.</p>}
            {copyState === 'error' && <p className="text-error">Could not copy. Please copy manually.</p>}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Continue Session</h2>
        <form className="form-grid" onSubmit={handleContinueSession}>
          <label className="field">
            <span>Email</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={continueEmail}
              onChange={(event) => setContinueEmail(event.target.value)}
              required
            />
          </label>

          <label className="field">
            <span>Session ID</span>
            <input
              className="input"
              type="text"
              placeholder="AB12CD34"
              value={continueSessionId}
              onChange={(event) => setContinueSessionId(event.target.value)}
              required
            />
          </label>

          <button className="button" type="submit" disabled={isContinuing}>
            {isContinuing ? 'Submitting...' : 'Continue Session'}
          </button>
        </form>

        {continueError && <p className="text-error">{continueError}</p>}
        {continueNotice && <p className="text-success">{continueNotice}</p>}
      </section>

      <section className="card">
        <h2>Find Sessions</h2>
        <form className="form-grid" onSubmit={handleFindSessions}>
          <label className="field">
            <span>Email</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={findEmail}
              onChange={(event) => setFindEmail(event.target.value)}
              required
            />
          </label>

          <button className="button" type="submit" disabled={isFinding}>
            {isFinding ? 'Submitting...' : 'Find My Sessions'}
          </button>
        </form>

        {findError && <p className="text-error">{findError}</p>}
        {findNotice && <p className="text-success">{findNotice}</p>}
      </section>

      <nav className="actions">
        <Link to="/auth/verify">Go to magic link verify route</Link>
        <Link to="/sessions">Go to sessions list route</Link>
      </nav>
    </main>
  );
}
