// Standalone iOS composes the home-indicator strip (the bottom safe-area
// inset) with the page's flat background color — painted over fixed content,
// so no canvas pixel can show there. The constellation theme never showed a
// bar only because its starfield happens to end at exactly its --bg color.
// This gives every backdrop that same property: melt the art into the
// theme's base color just above the strip, so the strip continues the
// picture instead of cutting across it. Zero-inset environments (desktop,
// plain browser tabs) skip the blend entirely.

// styles.css pins --sab: env(safe-area-inset-bottom) on :root so canvas JS
// can read the inset. Call per paint, not per animation frame.
export function safeAreaBottom(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--sab');
  const px = parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : 0;
}

// `base` must be a 6-digit hex equal to the theme's --bg — that is the color
// iOS paints the strip with, and matching it exactly is the whole trick.
export function blendIntoBase(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  inset: number,
  base: string,
): void {
  if (inset <= 0) return;
  const FADE = 56;
  const solidTop = Math.max(0, h - inset);
  const fadeTop = Math.max(0, solidTop - FADE);
  const grad = ctx.createLinearGradient(0, fadeTop, 0, solidTop);
  grad.addColorStop(0, `${base}00`);   // same hue, fully transparent
  grad.addColorStop(1, base);
  ctx.fillStyle = grad;
  ctx.fillRect(0, fadeTop, w, solidTop - fadeTop);
  ctx.fillStyle = base;
  ctx.fillRect(0, solidTop, w, h - solidTop);
}
