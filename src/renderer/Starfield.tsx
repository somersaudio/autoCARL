import { useEffect, useRef } from 'react';

// Night-sky backdrop: a field of stars that slowly wheels around a celestial
// pole, the way a long-exposure photo shows the real sky turning. Recognisable
// constellations are drawn among the background stars with faint connecting
// lines. Stars twinkle gently and, once in a while, a meteor crosses.
//
// Realism notes, since "looks realistic" is the brief:
//  - Star colours follow stellar classes (blue-white O/B through orange-red M),
//    weighted the way a naked-eye sky reads — mostly white-ish, a few warm.
//  - Stars are soft radial-gradient sprites, not hard circles; magnitude shows
//    as size AND brightness, skewed heavily toward dim stars.
//  - The whole sky rotates rigidly about one pole (one revolution ≈ 90 min —
//    much faster than the real 24h, or nothing would visibly move, but slow
//    enough to only register if you watch for it).
//  - Twinkle is small-amplitude and desynchronised; bright stars flicker less.

type StarDef = {
  r: number;          // distance from the pole, px
  theta: number;      // angle around the pole at t=0
  size: number;       // sprite half-size, px
  baseAlpha: number;
  twinkleAmp: number;
  twinklePhase: number;
  twinkleSpeed: number;
  sprite: number;     // index into the tinted sprite set
};

// [x, y] pairs in each constellation's own unit square (y grows downward),
// sized/placed per instance below. Lines index into the star list.
type ConstellationDef = {
  stars: Array<[number, number, number]>;  // x, y, relative brightness 0–1
  lines: Array<[number, number]>;
  // Optional per-star sprite override (e.g. Betelgeuse orange, Rigel blue).
  tints?: Record<number, number>;
};

const ORION: ConstellationDef = {
  stars: [
    [0.20, 0.10, 1.0],  // 0 Betelgeuse
    [0.62, 0.14, 0.8],  // 1 Bellatrix
    [0.35, 0.45, 0.7],  // 2 Alnitak
    [0.45, 0.47, 0.75], // 3 Alnilam
    [0.55, 0.49, 0.7],  // 4 Mintaka
    [0.30, 0.85, 0.75], // 5 Saiph
    [0.72, 0.83, 1.0],  // 6 Rigel
  ],
  lines: [[0, 1], [0, 2], [1, 4], [2, 3], [3, 4], [2, 5], [4, 6], [5, 6]],
  tints: { 0: 4, 6: 0 },  // Betelgeuse red-orange, Rigel blue-white
};

const BIG_DIPPER: ConstellationDef = {
  stars: [
    [0.90, 0.15, 0.8],  // 0 Dubhe
    [0.85, 0.35, 0.7],  // 1 Merak
    [0.62, 0.40, 0.7],  // 2 Phecda
    [0.60, 0.22, 0.6],  // 3 Megrez
    [0.42, 0.20, 0.8],  // 4 Alioth
    [0.25, 0.15, 0.8],  // 5 Mizar
    [0.05, 0.25, 0.8],  // 6 Alkaid
  ],
  lines: [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [4, 5], [5, 6]],
};

const CASSIOPEIA: ConstellationDef = {
  stars: [
    [0.05, 0.30, 0.7],  // Segin
    [0.25, 0.45, 0.7],  // Ruchbah
    [0.50, 0.25, 0.85], // Gamma Cas
    [0.72, 0.50, 0.8],  // Schedar
    [0.95, 0.35, 0.75], // Caph
  ],
  lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
  tints: { 3: 3 },      // Schedar is orange
};

const CYGNUS: ConstellationDef = {
  stars: [
    [0.50, 0.06, 1.0],  // 0 Deneb
    [0.50, 0.42, 0.75], // 1 Sadr
    [0.18, 0.60, 0.6],  // 2 Gienah
    [0.80, 0.28, 0.6],  // 3 Delta Cyg
    [0.52, 0.95, 0.7],  // 4 Albireo
  ],
  lines: [[0, 1], [1, 4], [2, 1], [1, 3]],
  tints: { 4: 3 },      // Albireo's famous gold component
};

const LYRA: ConstellationDef = {
  stars: [
    [0.50, 0.08, 1.0],  // 0 Vega
    [0.42, 0.34, 0.55],
    [0.62, 0.40, 0.55],
    [0.48, 0.74, 0.6],
    [0.68, 0.70, 0.6],
  ],
  lines: [[0, 1], [1, 2], [1, 3], [2, 4], [3, 4]],
  tints: { 0: 0 },      // Vega blue-white
};

// Placement across the sky at t=0: centre (fraction of viewport) + size (px).
const CONSTELLATIONS: Array<{ def: ConstellationDef; cx: number; cy: number; scale: number }> = [
  { def: ORION,      cx: 0.74, cy: 0.64, scale: 190 },
  { def: BIG_DIPPER, cx: 0.52, cy: 0.16, scale: 210 },
  { def: CASSIOPEIA, cx: 0.14, cy: 0.56, scale: 150 },
  { def: CYGNUS,     cx: 0.36, cy: 0.82, scale: 160 },
  { def: LYRA,       cx: 0.87, cy: 0.22, scale: 95 },
];

// Stellar-class halo tints, blue-white through red-orange. The sprite core is
// always white — that's how stars actually read; colour lives in the halo.
const TINTS: Array<[number, number, number]> = [
  [170, 196, 255],  // 0 O/B blue-white
  [222, 232, 255],  // 1 A white
  [255, 244, 222],  // 2 F/G warm white
  [255, 214, 164],  // 3 K orange
  [255, 178, 138],  // 4 M red-orange
];
const TINT_WEIGHTS = [0.18, 0.34, 0.26, 0.15, 0.07];

// One revolution of the sky every 90 minutes.
const OMEGA = (2 * Math.PI) / 5400;

function makeSprite(tint: [number, number, number]): HTMLCanvasElement {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.22, `rgba(${tint[0]},${tint[1]},${tint[2]},0.85)`);
  grad.addColorStop(0.55, `rgba(${tint[0]},${tint[1]},${tint[2]},0.22)`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

function pickTint(): number {
  let roll = Math.random();
  for (let i = 0; i < TINT_WEIGHTS.length; i++) {
    roll -= TINT_WEIGHTS[i];
    if (roll <= 0) return i;
  }
  return 1;
}

type Meteor = {
  x: number; y: number;       // head position at birth
  dx: number; dy: number;     // unit direction
  born: number;               // seconds
  life: number;               // seconds
  len: number;                // px
};

export default function Starfield({ opacity = 0.9 }: { opacity?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sprites = TINTS.map(makeSprite);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let w = 0, h = 0;
    let poleX = 0, poleY = 0;
    let stars: StarDef[] = [];
    let lines: Array<[number, number]> = [];  // index pairs into `stars`
    let meteor: Meteor | null = null;
    let nextMeteorAt = 0;

    // Convert an absolute t=0 screen position into pole-relative polar coords,
    // so the rigid rotation is just theta + OMEGA*t at draw time.
    const toPolar = (x: number, y: number) => ({
      r: Math.hypot(x - poleX, y - poleY),
      theta: Math.atan2(y - poleY, x - poleX),
    });

    const init = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Pole sits up-left of centre, like facing north with Polaris high.
      poleX = w * 0.30;
      poleY = h * 0.28;

      // Cover a disc big enough that rotation never sweeps a bare region on
      // screen: radius = farthest corner from the pole, plus margin.
      const R = Math.max(
        Math.hypot(poleX, poleY),
        Math.hypot(w - poleX, poleY),
        Math.hypot(poleX, h - poleY),
        Math.hypot(w - poleX, h - poleY),
      ) + 40;

      stars = [];
      lines = [];

      // Background population, density-matched to the disc's area.
      const count = Math.floor((Math.PI * R * R) / 2600);
      for (let i = 0; i < count; i++) {
        const r = R * Math.sqrt(Math.random());       // uniform over the disc
        const theta = Math.random() * 2 * Math.PI;
        const mag = Math.random();                    // 0 dim … 1 bright, skewed dim
        const bright = mag * mag * mag;
        stars.push({
          r, theta,
          size: 1.6 + bright * 6.5,
          baseAlpha: 0.18 + bright * 0.8,
          twinkleAmp: 0.35 - bright * 0.22,
          twinklePhase: Math.random() * 2 * Math.PI,
          twinkleSpeed: 0.5 + Math.random() * 2.0,
          sprite: pickTint(),
        });
      }

      // Constellations: brighter, named-star tints, and line segments.
      for (const { def, cx, cy, scale } of CONSTELLATIONS) {
        const baseIdx = stars.length;
        def.stars.forEach(([sx, sy, brightness], i) => {
          const { r, theta } = toPolar(cx * w + (sx - 0.5) * scale, cy * h + (sy - 0.5) * scale);
          stars.push({
            r, theta,
            size: 4.5 + brightness * 5.5,
            baseAlpha: 0.75 + brightness * 0.25,
            twinkleAmp: 0.10,
            twinklePhase: Math.random() * 2 * Math.PI,
            twinkleSpeed: 0.4 + Math.random() * 1.2,
            sprite: def.tints?.[i] ?? 1,
          });
        });
        for (const [a, b] of def.lines) lines.push([baseIdx + a, baseIdx + b]);
      }

      nextMeteorAt = performance.now() / 1000 + 8 + Math.random() * 20;
    };
    init();

    const draw = () => {
      const t = performance.now() / 1000;
      const rot = OMEGA * t;

      // Deep-sky gradient — near-black zenith into a faintly lighter horizon.
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#03060c');
      bg.addColorStop(1, '#0a1020');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const cos = Math.cos(rot), sin = Math.sin(rot);
      const px = new Float64Array(stars.length);
      const py = new Float64Array(stars.length);
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        // theta + rot, expanded via the shared cos/sin of the frame's rotation.
        const c0 = Math.cos(s.theta), s0 = Math.sin(s.theta);
        px[i] = poleX + s.r * (c0 * cos - s0 * sin);
        py[i] = poleY + s.r * (s0 * cos + c0 * sin);
      }

      // Constellation lines first, under the stars.
      ctx.strokeStyle = 'rgba(150, 180, 255, 0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [a, b] of lines) {
        ctx.moveTo(px[a], py[a]);
        ctx.lineTo(px[b], py[b]);
      }
      ctx.stroke();

      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        const x = px[i], y = py[i];
        if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
        const tw = 1 + s.twinkleAmp * Math.sin(t * s.twinkleSpeed + s.twinklePhase);
        ctx.globalAlpha = Math.min(1, Math.max(0.05, s.baseAlpha * tw));
        const d = s.size * 2;
        ctx.drawImage(sprites[s.sprite], x - s.size, y - s.size, d, d);
      }
      ctx.globalAlpha = 1;

      // Rare meteor: a fading streak with a bright head.
      if (!meteor && t > nextMeteorAt) {
        const ang = Math.PI * (0.15 + Math.random() * 0.5);  // down-and-across
        meteor = {
          x: Math.random() * w, y: Math.random() * h * 0.5,
          dx: Math.cos(ang), dy: Math.sin(ang),
          born: t, life: 0.6 + Math.random() * 0.5,
          len: 110 + Math.random() * 110,
        };
      }
      if (meteor) {
        const age = (t - meteor.born) / meteor.life;
        if (age >= 1) {
          meteor = null;
          nextMeteorAt = t + 15 + Math.random() * 30;
        } else {
          const dist = age * meteor.len * 2.2;
          const hx = meteor.x + meteor.dx * dist;
          const hy = meteor.y + meteor.dy * dist;
          const tx = hx - meteor.dx * meteor.len;
          const ty = hy - meteor.dy * meteor.len;
          const fade = Math.sin(age * Math.PI);            // in, then out
          const grad = ctx.createLinearGradient(tx, ty, hx, hy);
          grad.addColorStop(0, 'rgba(200, 220, 255, 0)');
          grad.addColorStop(1, `rgba(230, 240, 255, ${0.75 * fade})`);
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(hx, hy);
          ctx.stroke();
        }
      }

      animationRef.current = requestAnimationFrame(draw);
    };
    draw();

    window.addEventListener('resize', init);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      window.removeEventListener('resize', init);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="backdrop-canvas"
      style={{ opacity }}
    />
  );
}
