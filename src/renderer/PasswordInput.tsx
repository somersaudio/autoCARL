import { useState } from 'react';

// Password input with a built-in "Show/Hide" toggle. Drop-in replacement for
// the standard `<input type="password" />` we use across Setup and Settings —
// users can verify they're typing what they think they're typing (catches the
// invisible-trailing-space / wrong-caps-lock / O-vs-0 class of bugs).
type Props = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
};

export default function PasswordInput({ value, onChange, placeholder, autoComplete, disabled }: Props) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-input">
      <input
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setShown((s) => !s)}
        tabIndex={-1}
        aria-label={shown ? 'Hide password' : 'Show password'}
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
