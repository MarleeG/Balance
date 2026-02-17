import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiClient, setAccessToken } from '../api';
import { useToast } from '../ui/toast-provider';

interface VerifiedSession {
  sessionId: string;
  expiresAt: string;
  status: string;
}

interface VerifyResponse {
  accessToken: string;
  expiresIn: number;
  sessions: VerifiedSession[];
}

const INVALID_LINK_MESSAGE = 'This link is invalid or expired. Request a new link.';
const VERIFYING_MESSAGE = 'Verifying your secure link...';

export function MagicLinkVerifyPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setErrorMessage(INVALID_LINK_MESSAGE);
      showToast(INVALID_LINK_MESSAGE, 'error');
      return;
    }

    let isActive = true;
    const abortController = new AbortController();

    const verify = async () => {
      try {
        const response = await apiClient.get<VerifyResponse>(
          `/auth/verify?token=${encodeURIComponent(token)}`,
          {
            skipAuth: true,
            signal: abortController.signal,
          },
        );

        if (!isActive || !response.accessToken) {
          return;
        }

        setAccessToken(response.accessToken);
        navigate('/sessions', {
          replace: true,
          state: {
            sessions: response.sessions ?? [],
          },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        if (!isActive) {
          return;
        }

        setErrorMessage(INVALID_LINK_MESSAGE);
        showToast(INVALID_LINK_MESSAGE, 'error');
      }
    };

    verify();

    return () => {
      isActive = false;
      abortController.abort();
    };
  }, [navigate, showToast, token]);

  return (
    <main className="page">
      <h1>Magic Link Verification</h1>
      {!errorMessage && <p className="muted">{VERIFYING_MESSAGE}</p>}
      {errorMessage && (
        <section className="card">
          <p className="text-error">{errorMessage}</p>
        </section>
      )}
      <nav className="actions">
        <Link to="/">Request a new link</Link>
      </nav>
    </main>
  );
}
