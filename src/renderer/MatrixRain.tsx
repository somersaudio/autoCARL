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
        };
      }
    };
    initDrops();

    // ONE phosphor green, movie-style — columns differ only in brightness
    // along the trail, never in hue (the old per-column hue mix read as
    // "weird green"). The head glyph is WHITE with a halo, always.
    const GREEN = [0, 255, 70] as const;
    const trailColor = (trailIdx: number, trailLen: number) => {
      // Concave fade: the column holds near-full green through most of its
      // length (like the film) and only dims toward the tail, to ~15%.
      const x = (trailIdx - 1) / Math.max(1, trailLen - 1);
      const f = Math.max(0.15, 1 - Math.pow(x, 1.7) * 0.9);
      return `rgb(${Math.floor(GREEN[0] * f)}, ${Math.floor(GREEN[1] * f)}, ${Math.floor(GREEN[2] * f)})`;
    };

    const draw = () => {
      // Full black fill each frame — gives a hard background since we sit
      // inside a fixed canvas that the rest of the UI floats above.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // The film mirrors its glyphs — flipping the whole canvas mirrors
      // every character (and costs nothing per glyph).
      ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < drops.length; i++) {
        const drop = drops[i];
        const headY = drop.y * fontSize;
        const len = drop.chars.length;

        // Trail: single green hue with a soft phosphor glow, dimming down
        // the tail. One shadow state per column keeps phones smooth.
        ctx.shadowColor = 'rgba(0, 255, 70, 0.8)';
        ctx.shadowBlur = 6;
        for (let t = 1; t < len; t++) {
          const charY = headY - t * fontSize;
          if (charY < 0 || charY > canvas.height + fontSize) continue;
          ctx.fillStyle = trailColor(t, len);
          ctx.fillText(drop.chars[t], i * columnWidth, charY);
        }

        // The falling head: white-hot with a wider halo, like the film.
        if (headY >= 0 && headY <= canvas.height + fontSize) {
          ctx.shadowColor = 'rgba(200, 255, 210, 0.9)';
          ctx.shadowBlur = 10;
          ctx.fillStyle = '#f4fff5';
          ctx.fillText(drop.chars[0], i * columnWidth, headY);
        }

        drop.y += drop.speed * speedRef.current;

        if ((drop.y - len) * fontSize > canvas.height && Math.random() > 0.975) {
          drop.y = Math.random() * -20;
          drop.speed = (0.5 + Math.random() * 1.5) / 8;
          drop.chars = randomChars(8 + Math.floor(Math.random() * 18));
        }
      }
      ctx.shadowBlur = 0;

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
