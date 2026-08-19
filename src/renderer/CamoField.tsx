import { useEffect, useRef } from 'react';

// Icy-blue digital camouflage backdrop, generated procedurally so it fits
// any screen without tiling seams. The palette is sampled from John's
// reference swatch: icy light, two gray-blues, a steel navy, and sparse
// near-black accents. Painted once per size (no animation), then dimmed
// under a dark veil so cards and text stay readable on top.

const CELL = 10;   // px per camo "pixel" — matches the reference's chunkiness

// [color, blob count per 100x100 cells, blob size range]
const LAYERS: Array<[string, number, [number, number]]> = [
  ['#7c8792', 90, [12, 70]],    // mid gray-blue
  ['#3f5a80', 70, [12, 80]],    // steel navy
  ['#9aa6b2', 55, [8, 45]],     // light-mid haze
  ['#15171c', 16, [4, 18]],     // near-black accents, small and sparse
];

const BASE = '#c4cdd8';         // icy light base

export default function CamoField({ opacity = 1 }: { opacity?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const paint = () => {
      canvas.width = canvas.clientWidth || window.innerWidth;
      canvas.height = canvas.clientHeight || window.innerHeight;
      const cols = Math.ceil(canvas.width / CELL) + 1;
      const rows = Math.ceil(canvas.height / CELL) + 1;

      ctx.fillStyle = BASE;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Each blob is a random walk on the cell grid — the walk's clumping is
      // what gives digital camo its stepped, blocky silhouettes.
      const cellArea = (cols * rows) / (100 * 100);
      for (const [color, per100, [minSize, maxSize]] of LAYERS) {
        ctx.fillStyle = color;
        const blobs = Math.max(4, Math.round(per100 * cellArea));
        for (let b = 0; b < blobs; b++) {
          let x = Math.floor(Math.random() * cols);
          let y = Math.floor(Math.random() * rows);
          const steps = minSize + Math.floor(Math.random() * (maxSize - minSize));
          // Momentum makes runs of same-direction steps → oblong patches
          // like the reference, not round splats.
          let dx = Math.random() < 0.5 ? 1 : -1;
          let dy = 0;
          // A fat brush (mostly 2×2 cells, sometimes 3×2) turns the walk
          // into the chunky patches of the reference instead of thin paths.
          for (let i = 0; i < steps; i++) {
            const bw = Math.random() < 0.3 ? 3 : 2;
            const bh = 2;
            ctx.fillRect(x * CELL, y * CELL, bw * CELL, bh * CELL);
            if (Math.random() < 0.25) {
              const horizontal = Math.random() < 0.6;   // camo runs wide
              dx = horizontal ? (Math.random() < 0.5 ? 1 : -1) : 0;
              dy = horizontal ? 0 : (Math.random() < 0.5 ? 1 : -1);
            }
            x = Math.min(cols - 1, Math.max(0, x + dx));
            y = Math.min(rows - 1, Math.max(0, y + dy));
          }
        }
      }

      // Single-cell speckle pass — the fine grain in the reference.
      const speckles = Math.round(cols * rows * 0.01);
      for (let i = 0; i < speckles; i++) {
        const layer = LAYERS[Math.floor(Math.random() * LAYERS.length)];
        ctx.fillStyle = layer[0];
        ctx.fillRect(
          Math.floor(Math.random() * cols) * CELL,
          Math.floor(Math.random() * rows) * CELL,
          CELL, CELL,
        );
      }

      // Dark veil: the UI floats above the pattern, not inside it.
      ctx.fillStyle = 'rgba(8, 12, 18, 0.66)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
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
