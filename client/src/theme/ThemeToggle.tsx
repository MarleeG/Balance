import { useTheme } from './theme-provider';
import type { ThemeMode } from './theme-provider';

const OPTIONS: ThemeMode[] = ['system', 'light', 'dark'];

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
          aria-pressed={mode === option}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
