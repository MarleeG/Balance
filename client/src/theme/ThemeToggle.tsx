import { useTheme } from './theme-provider';
import type { ThemeMode } from './theme-provider';

const OPTIONS: ThemeMode[] = ['system', 'light', 'dark'];
const LABELS: Record<ThemeMode, string> = {
  system: 'System theme',
  light: 'Light theme',
  dark: 'Dark theme',
};

function SystemIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="13" rx="2" ry="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 20h6M12 17v3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20 14.1A8 8 0 1 1 9.9 4 6.4 6.4 0 0 0 20 14.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Icon({ mode }: { mode: ThemeMode }) {
  if (mode === 'light') {
    return <SunIcon />;
  }
  if (mode === 'dark') {
    return <MoonIcon />;
  }
  return <SystemIcon />;
}

export function ThemeToggle() {
  const { mode, setMode } = useTheme();

  return (
    <div className="theme-toggle" role="group" aria-label="Theme mode">
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className={mode === option ? 'is-active' : ''}
          onClick={() => setMode(option)}
          aria-label={LABELS[option]}
          title={LABELS[option]}
          aria-pressed={mode === option}
        >
          <span className="theme-toggle-icon">
            <Icon mode={option} />
          </span>
          <span className="sr-only">{LABELS[option]}</span>
        </button>
      ))}
    </div>
  );
}
