// Themes apply by overwriting CSS variables on document.documentElement.
// The base palette lives in styles.css; everything here just overrides those
// vars when a non-default theme is active. Panels are kept semi-translucent
// for themes that include a background effect (digital-rain), so the canvas
// shows through the cards subtly.

export type ThemeId = 'default' | 'digital-rain' | 'constellation' | 'icy-camo';

export type Theme = {
  id: ThemeId;
  name: string;
  // Maps directly to CSS variables under :root. Any keys you set here override
  // styles.css; anything you omit falls through to the original value.
  vars: Record<string, string>;
  // Which full-window canvas App.tsx mounts behind everything, if any.
  backdrop?: 'rain' | 'stars' | 'camo';
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
      '--bg': '#0a1020',   // matches the starfield gradient's horizon end
      '--panel': 'rgba(10, 16, 30, 0.72)',
      '--panel-2': 'rgba(14, 22, 40, 0.78)',
      '--border': 'rgba(140, 170, 255, 0.20)',
      '--text': '#ffffff',
      '--text-subtle': 'rgba(255, 255, 255, 0.62)',
      // No --ct-gold override: the accent stays the true CT brand gold from
      // styles.css. (A paler "starlight" gold was tried and read as washed out.)
    },
  },
  {
    id: 'default',
    name: 'CT Gold',
    // Dark black base (John's call — the sky-navy fallback read as blue);
    // everything else stays on styles.css defaults.
    vars: { '--bg': '#000000' },
  },
  {
    id: 'digital-rain',
    name: 'Digital Rain',
    backdrop: 'rain',
    vars: {
      '--bg': '#000000',
      '--panel': 'rgba(0, 16, 4, 0.72)',
      '--panel-2': 'rgba(0, 26, 8, 0.78)',
      '--border': 'rgba(0, 255, 70, 0.22)',
      '--text': '#ffffff',
      '--text-subtle': 'rgba(255, 255, 255, 0.6)',
      // Wherever the CT Gold theme uses gold (tab pill, accents), digital
      // rain swaps in THE rain's own phosphor green — the same rgb(0,255,70)
      // MatrixRain paints, so the UI accent and the falling code match.
      '--ct-gold': '#00ff46',
    },
  },
  {
    id: 'icy-camo',
    name: 'Icy Blue Camo',
    backdrop: 'camo',
    vars: {
      '--bg': '#0e141c',
      '--panel': 'rgba(18, 26, 38, 0.84)',
      '--panel-2': 'rgba(26, 36, 50, 0.86)',
      '--border': 'rgba(164, 184, 205, 0.26)',
      '--text': '#eef2f7',
      '--text-subtle': 'rgba(198, 211, 226, 0.66)',
      // Accent role (the CT Gold slot): the swatch's icy highlight blue.
      '--ct-gold': '#a9c9ec',
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
  // The page's BASE layer — what shows past the backdrop during overscroll
  // and in any strip iOS composes beyond the document — must be the theme's
  // own color: pure black under the digital rain, the sky's horizon under
  // the stars. (index.html pre-paints a static color; this corrects it the
  // moment the theme applies.)
  const base = theme.vars['--bg'] || '#0a1020';
  root.style.backgroundColor = base;
  document.body.style.backgroundColor = base;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', base);
}
