import { useEffect, useRef } from 'react';

// Half-width katakana + digits 0–9 + a few latin letters — the classic glyph
// set from the Matrix opening credits. Each column picks one drop's worth of
// chars at random, so columns don't sync up.
const GLYPHS =
  'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン' +
  '0123456789' +
  'ABCDEFZ';

type Drop = {
  y: number;
  speed: number;
  chars: string[];
  greenShade: number;
};

function randomChars(len: number): string[] {
  const out: string[] = new Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = GLYPHS.charAt(Math.floor(Math.random() * GLYPHS.length));
  }
  return out;
}

// Fixed full-window canvas. `opacity` controls how visible the rain is behind
// the rest of the UI (default 0.18 leaves cards still readable).
export default function MatrixRain({ opacity = 0.18, speed = 1 }: { opacity?: number; speed?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | undefined>(undefined);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const fontSize = 14;
    const columnWidth = fontSize;

    const resize = () => {
      // Element box (100vw × 100lvh), not the window — on iOS the window
      // height changes with Safari's toolbar and can undersize the bitmap.
      canvas.width = canvas.clientWidth || window.innerWidth;
      canvas.height = canvas.clientHeight || window.innerHeight;
    };
    resize();

    let columns = Math.floor(canvas.width / columnWidth);
    let drops: Drop[] = [];

    const initDrops = () => {
      columns = Math.floor(canvas.width / columnWidth);
      drops = new Array(columns);
      for (let i = 0; i < columns; i++) {
        drops[i] = {
          y: Math.random() * -50,
          speed: (0.5 + Math.random() * 1.5) / 8,
          chars: randomChars(8 + Math.floor(Math.random() * 18)),
          greenShade: Math.floor(Math.random() * 6),
        };
      }
    };
    initDrops();

    const baseGreens: [number, number, number][] = [
      [0, 255, 0], [0, 204, 0], [0, 153, 0],
      [51, 255, 51], [0, 255, 102], [102, 255, 0],
    ];

    const getColor = (shade: number, trailIdx: number, trailLen: number) => {
      const base = baseGreens[shade % baseGreens.length];
      const f = 1 - trailIdx / trailLen;
      return `rgb(${Math.floor(base[0] * f)}, ${Math.floor(base[1] * f)}, ${Math.floor(base[2] * f)})`;
    };

    const draw = () => {
      // Full black fill each frame — gives a hard background since we sit
      // inside a fixed canvas that the rest of the UI floats above.
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < drops.length; i++) {
        const drop = drops[i];
        const headY = drop.y * fontSize;
        const len = drop.chars.length;

        for (let t = 0; t < len; t++) {
          const charY = headY - t * fontSize;
          if (charY < 0 || charY > canvas.height + fontSize) continue;
          ctx.fillStyle = getColor(drop.greenShade, t, len);
          ctx.fillText(drop.chars[t], i * columnWidth, charY);
        }

        // Random head-flash to bright white — gives the column a "pulse".
        if (Math.random() > 0.98) {
          ctx.fillStyle = '#ffffff';
          ctx.fillText(drop.chars[0], i * columnWidth, headY);
        }

        drop.y += drop.speed * speedRef.current;

        if ((drop.y - len) * fontSize > canvas.height && Math.random() > 0.975) {
          drop.y = Math.random() * -20;
          drop.speed = (0.5 + Math.random() * 1.5) / 8;
          drop.chars = randomChars(8 + Math.floor(Math.random() * 18));
          drop.greenShade = Math.floor(Math.random() * 6);
        }
      }

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    const handleResize = () => {
      resize();
      initDrops();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      window.removeEventListener('resize', handleResize);
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
