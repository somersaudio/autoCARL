import { useEffect, useRef } from 'react';
import { blendIntoBase, safeAreaBottom } from './backdrop-blend';

// "For the Girls" — a painted pastel dusk, structured like the reference
// photo: deep-blue sky up top melting through lavender into pink, streaky
// sunset clouds, a sliver of moon, and a foam line washing over sand at the
// bottom. Painted once per size (no animation), then calmed under a plum
// veil so the UI reads clearly on top.

export default function SunsetField({ opacity = 1 }: { opacity?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const paint = () => {
      const w = canvas.width = canvas.clientWidth || window.innerWidth;
      const h = canvas.height = canvas.clientHeight || window.innerHeight;
      const horizon = h * 0.72;   // clouds live above this line

      // One unbroken wash, sky into sand — no seams, no bands: dusk blue →
      // periwinkle → lavender → pink → pale glow → warm sand.
      const wash = ctx.createLinearGradient(0, 0, 0, h);
      wash.addColorStop(0.00, '#4a6fb5');
      wash.addColorStop(0.22, '#7d84c4');
      wash.addColorStop(0.40, '#b795cd');
      wash.addColorStop(0.58, '#ee9ec0');
      wash.addColorStop(0.72, '#f6dae3');
      wash.addColorStop(0.84, '#e0b7ae');
      wash.addColorStop(1.00, '#cfa48c');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, w, h);

      // Clouds: long soft streaks, pinker near the horizon, wispier high up.
      for (let i = 0; i < 26; i++) {
        const t = Math.random();                 // 0 top … 1 near horizon
        const y = t * t * horizon * 0.96;
        const cw = w * (0.25 + Math.random() * 0.6);
        const ch = 6 + Math.random() * (10 + 26 * (y / horizon));
        const x = Math.random() * w - cw / 4;
        const pink = y / horizon;
        const r = Math.round(238 + 14 * pink);
        const g = Math.round(170 + 40 * (1 - pink) * 0.5);
        const b = Math.round(205 + 20 * (1 - pink));
        const grad = ctx.createRadialGradient(x + cw / 2, y, 0, x + cw / 2, y, cw / 2);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${0.38 + 0.32 * pink})`);
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grad;
        ctx.save();
        ctx.translate(x + cw / 2, y);
        ctx.scale(1, ch / (cw / 2));            // squash the glow into a streak
        ctx.beginPath();
        ctx.arc(0, 0, cw / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // The little crescent moon, high and off-center like the photo.
      const mx = w * 0.55, my = h * 0.16, mr = Math.max(4, w * 0.008);
      ctx.fillStyle = 'rgba(252, 248, 240, 0.9)';
      ctx.beginPath();
      ctx.arc(mx, my, mr, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(90, 118, 182, 0.85)';   // sky tone bites the crescent
      ctx.beginPath();
      ctx.arc(mx + mr * 0.5, my - mr * 0.25, mr * 0.9, 0, Math.PI * 2);
      ctx.fill();

      // Plum veil — the app floats above the postcard.
      ctx.fillStyle = 'rgba(34, 20, 38, 0.46)';
      ctx.fillRect(0, 0, w, h);

      // #7f625d is the wash's sand bottom (#cfa48c) under the plum veil —
      // and the theme's --bg, the color iOS paints the home-indicator strip.
      blendIntoBase(ctx, w, h, safeAreaBottom(), '#7f625d');
    };

    paint();
    window.addEventListener('resize', paint);
    return () => window.removeEventListener('resize', paint);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="backdrop-canvas"
      style={{ opacity }}
    />
  );
}
