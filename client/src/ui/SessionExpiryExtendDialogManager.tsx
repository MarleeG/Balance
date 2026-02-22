import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, apiClient } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './toast-provider';

const PRE_EXPIRY_WARNING_MS = 30_000;
const TIMER_TICK_MS = 1_000;
const EXTEND_DAY_OPTIONS = [1, 3, 7] as const;

interface ExtendSessionResponse {
  sessionId: string;
  expiresAt: string;
}

interface SessionExpiryExtendDialogManagerProps {
  sessionId?: string;
  expiresAt?: string | null;
  hasAccessToken: boolean;
  onExtended?: (nextExpiresAt: string) => void;
}

interface ExpiredSessionDialogProps {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onExtend: (days: 1 | 3 | 7) => void;
}

function ExpiredSessionDialog({ open, busy, onClose, onExtend }: ExpiredSessionDialogProps) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onClose();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [busy, onClose, open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="modal-overlay" role="presentation" onClick={busy ? undefined : onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="expired-session-title"
        aria-describedby="expired-session-message"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="expired-session-title" className="modal-title">Session expired</h2>
        <p id="expired-session-message" className="modal-message">
          This session reached its TTL. Extend it to keep working without losing your uploaded files.
        </p>

        <div className="session-extend-options" role="group" aria-label="Extend session by days">
          {EXTEND_DAY_OPTIONS.map((days) => (
            <button
              key={`extend-session-${days}`}
              type="button"
              className={`button${days === 1 ? '' : ' button-secondary'}`}
              onClick={() => onExtend(days)}
              disabled={busy}
            >
              {busy ? 'Extending...' : `Extend ${days} day${days === 1 ? '' : 's'}`}
            </button>
          ))}
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Not now
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function SessionExpiryExtendDialogManager({
  sessionId,
  expiresAt,
  hasAccessToken,
  onExtended,
}: SessionExpiryExtendDialogManagerProps) {
  const { showToast } = useToast();
  const [effectiveExpiresAt, setEffectiveExpiresAt] = useState<string | null>(expiresAt ?? null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [showExpiringPrompt, setShowExpiringPrompt] = useState(false);
  const [showExpiredPrompt, setShowExpiredPrompt] = useState(false);
  const [dismissedExpiringPrompt, setDismissedExpiringPrompt] = useState(false);
  const [isExtending, setIsExtending] = useState(false);

  useEffect(() => {
    setEffectiveExpiresAt(expiresAt ?? null);
  }, [expiresAt]);

  const expiresAtMs = useMemo(() => {
    if (!effectiveExpiresAt) {
      return null;
    }

    const parsed = new Date(effectiveExpiresAt).getTime();
    if (Number.isNaN(parsed)) {
      return null;
    }

    return parsed;
  }, [effectiveExpiresAt]);

  const remainingMs = useMemo(() => {
    if (!expiresAtMs) {
      return null;
    }

    return expiresAtMs - nowMs;
  }, [expiresAtMs, nowMs]);

  const remainingSeconds = useMemo(() => {
    if (remainingMs === null) {
      return 0;
    }

    return Math.max(0, Math.ceil(remainingMs / 1000));
  }, [remainingMs]);

  useEffect(() => {
    if (!hasAccessToken || !sessionId || expiresAtMs === null) {
      setShowExpiringPrompt(false);
      setShowExpiredPrompt(false);
      return;
    }

    setNowMs(Date.now());
    const timerId = window.setInterval(() => {
      setNowMs(Date.now());
    }, TIMER_TICK_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, [expiresAtMs, hasAccessToken, sessionId]);

  useEffect(() => {
    if (!hasAccessToken || !sessionId || remainingMs === null) {
      return;
    }

    if (remainingMs <= 0) {
      setShowExpiringPrompt(false);
      setShowExpiredPrompt(true);
      return;
    }

    setShowExpiredPrompt(false);

    if (remainingMs <= PRE_EXPIRY_WARNING_MS) {
      if (!dismissedExpiringPrompt) {
        setShowExpiringPrompt(true);
      }
      return;
    }

    setShowExpiringPrompt(false);
    if (dismissedExpiringPrompt) {
      setDismissedExpiringPrompt(false);
    }
  }, [dismissedExpiringPrompt, hasAccessToken, remainingMs, sessionId]);

  async function extendSession(days: 1 | 3 | 7) {
    if (!sessionId || !hasAccessToken || isExtending) {
      return;
    }

    setIsExtending(true);
    try {
      const response = await apiClient.post<ExtendSessionResponse>(
        `/sessions/${sessionId}/extend`,
        { days },
      );

      const nextExpiresAt = response.expiresAt;
      setEffectiveExpiresAt(nextExpiresAt);
      setNowMs(Date.now());
      setShowExpiringPrompt(false);
      setShowExpiredPrompt(false);
      setDismissedExpiringPrompt(false);
      onExtended?.(nextExpiresAt);
      showToast(
        `Session extended by ${days} day${days === 1 ? '' : 's'}.`,
        'success',
      );
    } catch (error) {
      const message = error instanceof ApiError && error.status === 401
        ? 'To extend this session, continue via email link.'
        : 'Unable to extend this session right now.';
      showToast(message, 'error');
    } finally {
      setIsExtending(false);
    }
  }

  function dismissExpiringPrompt() {
    setShowExpiringPrompt(false);
    setDismissedExpiringPrompt(true);
  }

  return (
    <>
      <ConfirmDialog
        open={showExpiringPrompt && !showExpiredPrompt}
        title="Session expiring soon"
        message={`This session will expire in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}. Extend now?`}
        confirmLabel={isExtending ? 'Extending...' : 'Extend 1 day'}
        busy={isExtending}
        onConfirm={() => void extendSession(1)}
        onCancel={dismissExpiringPrompt}
      />

      <ExpiredSessionDialog
        open={showExpiredPrompt}
        busy={isExtending}
        onClose={() => setShowExpiredPrompt(false)}
        onExtend={(days) => {
          void extendSession(days);
        }}
      />
    </>
  );
}
