// Decides whether to nudge a visitor to Add to Home Screen. Apple exposes
// no install API (Safari never adopted beforeinstallprompt), so the best a
// page can do is show precise instructions — and only to the people they
// apply to. Pure function: the banner component feeds it the real globals,
// tests can feed it anything.

export type InstallHint = 'safari' | 'other-browser';

export function installHintFor(env: {
  ua: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
}): InstallHint | null {
  const iPhone = /iPhone|iPod/.test(env.ua);
  // iPadOS 13+ masquerades as a Mac; the touch points give it away.
  const iPad = /iPad/.test(env.ua) || (env.platform === 'MacIntel' && env.maxTouchPoints > 1);
  if (!iPhone && !iPad) return null;      // Android/desktop: no iOS steps
  if (env.standalone) return null;        // already installed
  // Non-Safari iOS browsers and in-app webviews (Chrome/Firefox/Edge/Opera,
  // Facebook, Instagram, Line) hide or cripple Add to Home Screen — point
  // them at Safari instead of giving steps that dead-end.
  if (/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|FBAN|FBAV|Instagram|Line\//.test(env.ua)) {
    return 'other-browser';
  }
  return 'safari';
}
