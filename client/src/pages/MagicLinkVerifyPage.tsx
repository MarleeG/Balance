import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiClient, setAccessToken } from '../api';
import { AppLayout } from '../ui/AppLayout';
import { useToast } from '../ui/toast-provider';

interface VerifiedSession {
  sessionId: string;
  expiresAt: string;
  status: string;
}

interface VerifyResponse {
  ok?: boolean;
  accessToken: string;
  expiresIn: number;
  sessions: VerifiedSession[];
}

const INVALID_LINK_MESSAGE = 'This link is invalid or expired. Request a new link.';
const VERIFYING_MESSAGE = 'Verifying your secure link...';
const VERIFY_SUCCESS_MESSAGE = 'Secure link verified. Redirecting to your sessions.';

async function verifyMagicLink(token: string, signal: AbortSignal): Promise<VerifyResponse> {
  return apiClient.post<VerifyResponse>(
    '/auth/verify',
    { token },
    {
      skipAuth: true,
      signal,
      credentials: 'include',
    },
  );
}

export function MagicLinkVerifyPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(true);

  useEffect(() => {
    if (!token) {
      setErrorMessage(INVALID_LINK_MESSAGE);
      setIsVerifying(false);
      showToast(INVALID_LINK_MESSAGE, 'error');
      return;
    }

    let isActive = true;
    const abortController = new AbortController();

    const verify = async () => {
      setIsVerifying(true);
      try {
        const response = await verifyMagicLink(token, abortController.signal);
        if (!isActive) {
          return;
        }

        if (!response.accessToken?.trim()) {
          throw new Error('Missing access token in verify response.');
        }
        if (response.ok === false) {
          throw new Error('Verify response returned not ok.');
        }

        setAccessToken(response.accessToken);
        showToast(VERIFY_SUCCESS_MESSAGE, 'success');
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
      } finally {
        if (isActive) {
          setIsVerifying(false);
        }
      }
    };

    verify();

    return () => {
      isActive = false;
      abortController.abort();
    };
  }, [navigate, showToast, token]);

  return (
    <AppLayout>
      <h1>Magic Link Verification</h1>
      {isVerifying && !errorMessage && <p className="muted page-lead" role="status">{VERIFYING_MESSAGE}</p>}
      {errorMessage && (
        <section className="card">
          <p className="text-error" role="alert">{errorMessage}</p>
          <div className="actions">
            <Link className="button button-secondary" to="/#continue-session">Request new link</Link>
          </div>
        </section>
      )}
    </AppLayout>
  );
}
