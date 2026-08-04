// Themes apply by overwriting CSS variables on document.documentElement.
// The base palette lives in styles.css; everything here just overrides those
// vars when a non-default theme is active. Panels are kept semi-translucent
// for themes that include a background effect (digital-rain), so the canvas
// shows through the cards subtly.

export type ThemeId = 'default' | 'digital-rain' | 'constellation';

export type Theme = {
  id: ThemeId;
  name: string;
  // Maps directly to CSS variables under :root. Any keys you set here override
  // styles.css; anything you omit falls through to the original value.
  vars: Record<string, string>;
  // Which full-window canvas App.tsx mounts behind everything, if any.
  backdrop?: 'rain' | 'stars';
};

// Constellations leads: it's the default for fresh installs, the fallback for
// unknown ids, and first in the Settings picker. The id 'default' is kept on
// CT Gold for compatibility — configs that saved it long ago still resolve.
export const THEMES: Theme[] = [
  {
    id: 'constellation',
    name: 'Constellations',
    backdrop: 'stars',
    vars: {
      '--bg': '#04070d',
      '--panel': 'rgba(10, 16, 30, 0.72)',
      '--panel-2': 'rgba(14, 22, 40, 0.78)',
      '--border': 'rgba(140, 170, 255, 0.20)',
      '--text': '#ffffff',
      '--text-subtle': 'rgba(255, 255, 255, 0.62)',
      // The accent role: a pale starlight gold, warm against the deep blue.
      '--ct-gold': '#ffd782',
    },
  },
  {
    id: 'default',
    name: 'CT Gold',
    vars: {}, // use styles.css defaults
  },
  {
    id: 'digital-rain',
    name: 'Digital Rain',
    backdrop: 'rain',
    vars: {
      '--bg': '#000000',
      '--panel': 'rgba(0, 16, 4, 0.72)',
      '--panel-2': 'rgba(0, 26, 8, 0.78)',
      '--border': 'rgba(0, 255, 102, 0.22)',
      '--text': '#ffffff',
      '--text-subtle': 'rgba(255, 255, 255, 0.6)',
      // Wherever the CT Gold theme uses gold (tab pill, accents), digital
      // rain swaps in the bright matrix-green instead — keeps the "accent"
      // role consistent across themes.
      '--ct-gold': '#00ff66',
    },
  },
];

export function findTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

// Apply (or clear) a theme's CSS-var overrides on :root.
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  // Wipe any previously-applied overrides so themes don't leak into each other.
  const prevList = root.getAttribute('data-theme-vars');
  if (prevList) {
    for (const key of prevList.split(',')) root.style.removeProperty(key);
  }
  const keys = Object.keys(theme.vars);
  for (const key of keys) root.style.setProperty(key, theme.vars[key]);
  root.setAttribute('data-theme', theme.id);
  root.setAttribute('data-theme-vars', keys.join(','));
}
