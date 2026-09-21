import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';

// A picture full screen, handled the way a phone's photo viewer handles one:
// it opens fitted to the screen, pinch or double-tap zooms, a drag looks
// around once zoomed, and a swipe down or a tap outside the picture closes
// it. On a Mac trackpad a pinch zooms and a two-finger scroll looks around.
// Keys: Esc closes, + and - zoom, 0 fits it again. An animated GIF keeps
// playing, since it's the picture itself on screen and not a copy.
//
// The page never zooms (the web app's viewport turns that off, and the
// desktop app has none), so every gesture here is handled by hand.

type Props = {
  src: string;
  alt: string;
  // Pictures this many pixels across or smaller are pixel art: drawn with
  // hard pixel edges, fitted at a whole-number scale so each source pixel is
  // an even block. 0 = none.
  crispUpTo?: number;
  onClose: () => void;
};

// Zoom is relative to the fitted size: 1 is fitted, MAX_ZOOM is six times it.
const MAX_ZOOM = 6;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;   // from lifting the first tap to landing the second
const TAP_SLOP = 8;          // px a finger may wander and still be a tap
const DISMISS_DRAG = 110;    // px a swipe at fitted size must travel to close
const KEY_ZOOM = 1.5;

type View = { s: number; x: number; y: number };
type Point = { x: number; y: number };
type Gesture =
  | { kind: 'pan' | 'drop'; start: Point; from: View; moved: boolean; onPicture: boolean; down: number }
  | { kind: 'pinch'; dist: number; mid: Point; from: View }
  | { kind: 'done' };   // fingers still down after a pinch at fitted size

const FIT: View = { s: 1, x: 0, y: 0 };

export default function PhotoViewer({ src, alt, crispUpTo = 0, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [screen, setScreen] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [view, setViewState] = useState<View>(FIT);
  const [drop, setDropState] = useState(0);     // swipe-to-close travel, fitted size only
  const [animate, setAnimate] = useState(false);
  const viewRef = useRef(view);
  const dropRef = useRef(0);
  const setDrop = (d: number) => { dropRef.current = d; setDropState(d); };
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ t: number; p: Point } | null>(null);
  const lastPointerType = useRef('');

  // The fitted size: the whole picture on screen, edge to edge on a phone
  // and with a margin on anything wider. Pixel art is fitted at the largest
  // whole-number scale that fits.
  const margin = screen.w < 600 ? 0 : 32;
  const crisp = !!natural && crispUpTo > 0 && Math.max(natural.w, natural.h) <= crispUpTo;
  let fit = natural
    ? Math.min((screen.w - 2 * margin) / natural.w, (screen.h - 2 * margin) / natural.h)
    : 1;
  if (crisp && fit >= 1) fit = Math.floor(fit);
  const base = natural ? { w: natural.w * fit, h: natural.h * fit } : null;
  const baseRef = useRef(base);
  baseRef.current = base;
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // Zoomed in, the picture can be dragged until its edge meets the screen's,
  // never past it; at fitted size it stays centred.
  const clamp = (v: View): View => {
    const b = baseRef.current;
    const sc = screenRef.current;
    const s = Math.min(MAX_ZOOM, Math.max(1, v.s));
    if (!b) return { s, x: 0, y: 0 };
    const maxX = Math.max(0, (b.w * s - sc.w) / 2);
    const maxY = Math.max(0, (b.h * s - sc.h) / 2);
    return { s, x: Math.min(maxX, Math.max(-maxX, v.x)), y: Math.min(maxY, Math.max(-maxY, v.y)) };
  };
  const setView = (v: View, animated = false) => {
    const next = clamp(v);
    viewRef.current = next;
    setAnimate(animated);
    setViewState(next);
  };
  const centre = (): Point => {
    const r = stage.current?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
  };
  // Zoom to `s`, keeping the spot under `at` where it is on screen.
  const zoomAt = (s: number, at: Point, from: View = viewRef.current, animated = false) => {
    const c = centre();
    const k = Math.min(MAX_ZOOM, Math.max(1, s)) / from.s;
    setView({
      s: from.s * k,
      x: at.x - c.x - (at.x - c.x - from.x) * k,
      y: at.y - c.y - (at.y - c.y - from.y) * k,
    }, animated);
  };

  const toggleZoom = (at: Point) => {
    if (viewRef.current.s > 1) setView(FIT, true);
    else zoomAt(DOUBLE_TAP_ZOOM, at, viewRef.current, true);
  };

  // A close from a finger or the mouse on the picture: the browser's own click
  // for that touch comes next, and must not land on whatever the viewer was
  // covering (the Buddy Info window closes on a click outside it).
  const closeFromGesture = () => {
    const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', swallow, true);
    window.setTimeout(() => window.removeEventListener('click', swallow, true), 400);
    onCloseRef.current();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    lastPointerType.current = e.pointerType;
    // Keep getting this finger's moves when it strays off the picture. Not
    // being able to is harmless, so a refusal is ignored.
    try { stage.current?.setPointerCapture(e.pointerId); } catch { /* moves still arrive while over the stage */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 1) {
      const v = viewRef.current;
      gesture.current = {
        kind: v.s > 1 ? 'pan' : 'drop',
        start: pts[0],
        from: v,
        moved: false,
        onPicture: e.target === picture.current,
        down: e.timeStamp,
      };
    } else if (pts.length === 2) {
      setDrop(0);
      gesture.current = { kind: 'pinch', dist: distance(pts[0], pts[1]), mid: midpoint(pts[0], pts[1]), from: viewRef.current };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g || g.kind === 'done') return;
    if (g.kind === 'pinch') {
      const pts = [...pointers.current.values()];
      if (pts.length < 2 || g.dist === 0) return;
      const mid = midpoint(pts[0], pts[1]);
      // Scale about where the pinch started, then follow the fingers' travel.
      const c = centre();
      const k = Math.min(MAX_ZOOM, Math.max(1, g.from.s * distance(pts[0], pts[1]) / g.dist)) / g.from.s;
      setView({
        s: g.from.s * k,
        x: g.mid.x - c.x - (g.mid.x - c.x - g.from.x) * k + (mid.x - g.mid.x),
        y: g.mid.y - c.y - (g.mid.y - c.y - g.from.y) * k + (mid.y - g.mid.y),
      });
      return;
    }
    const dx = e.clientX - g.start.x;
    const dy = e.clientY - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) > TAP_SLOP) g.moved = true;
    if (!g.moved) return;
    if (g.kind === 'pan') setView({ ...g.from, x: g.from.x + dx, y: g.from.y + dy });
    else { setAnimate(false); setDrop(dy); }
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    const left = [...pointers.current.values()];
    if (!g) return;
    if (g.kind === 'pinch' || g.kind === 'done') {
      // One finger still down after a pinch carries on looking around a
      // zoomed picture, and does nothing at fitted size. With more still
      // down, the pinch picks up from the two that are.
      const v = viewRef.current;
      if (left.length >= 2) {
        gesture.current = { kind: 'pinch', dist: distance(left[0], left[1]), mid: midpoint(left[0], left[1]), from: v };
      } else if (left.length === 1) {
        gesture.current = v.s > 1
          ? { kind: 'pan', start: left[0], from: v, moved: true, onPicture: false, down: e.timeStamp }
          : { kind: 'done' };
      } else {
        gesture.current = null;
      }
      return;
    }
    if (left.length > 0) return;
    gesture.current = null;
    if (g.kind === 'drop' && g.moved) {
      if (Math.abs(dropRef.current) > DISMISS_DRAG) { closeFromGesture(); return; }
      setAnimate(true);
      setDrop(0);
      return;
    }
    if (g.moved || e.type !== 'pointerup') return;
    // A tap. On a touch screen two in quick succession on the picture zoom in
    // there, or back out; a mouse goes by the system's double-click speed
    // instead (see onDoubleClick).
    const p = { x: e.clientX, y: e.clientY };
    const prev = lastTap.current;
    const touch = e.pointerType !== 'mouse';
    if (touch && g.onPicture && prev && g.down - prev.t < DOUBLE_TAP_MS && distance(prev.p, p) < 30) {
      lastTap.current = null;
      toggleZoom(p);
      return;
    }
    lastTap.current = touch && g.onPicture ? { t: e.timeStamp, p } : null;
    // A tap beside the picture closes it, as long as it isn't zoomed in.
    if (!g.onPicture && viewRef.current.s === 1) closeFromGesture();
  };

  // The mouse's double-click, at whatever speed the system is set to. The
  // stage has the pointer, so the click lands there; only one on the picture
  // counts.
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (lastPointerType.current !== 'mouse') return;
    const r = picture.current?.getBoundingClientRect();
    if (!r || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    toggleZoom({ x: e.clientX, y: e.clientY });
  };

  // Wheel and Safari's trackpad gestures need listeners that can cancel the
  // page's own handling, which React's are not. They sit on the whole viewer,
  // close button included, so a scroll or pinch anywhere on it never reaches
  // the page underneath. Everything they read is in a ref, so the first
  // render's handlers stay current.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // A trackpad pinch arrives as a run of wheel events with Ctrl held
    // (Chromium, and so the desktop app). Each zooms from where the run
    // began, as a finger pinch does, so the spot under the pointer stays put
    // even while the picture is held centred on an axis it still fits.
    let run: { from: View; s: number; at: number; left: View } | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? screenRef.current.h : 1;
      const v = viewRef.current;
      if (e.ctrlKey) {
        if (!run || e.timeStamp - run.at > 150 || run.left !== v) run = { from: v, s: v.s, at: 0, left: v };
        run.s = Math.min(MAX_ZOOM, Math.max(1, run.s * Math.exp(-e.deltaY * unit * 0.01)));
        zoomAt(run.s, { x: e.clientX, y: e.clientY }, run.from);
        run.at = e.timeStamp;
        run.left = viewRef.current;
      } else if (v.s > 1) {
        // An ordinary scroll looks around a zoomed picture.
        setView({ ...v, x: v.x - e.deltaX * unit, y: v.y - e.deltaY * unit });
      }
    };
    // Safari reports a trackpad pinch as gesture events instead. On a phone a
    // pinch sends these too, alongside the two fingers' pointer events, which
    // already zoom.
    type SafariGesture = Event & { scale: number; clientX: number; clientY: number };
    let gestureFrom = FIT;
    const onGestureStart = (e: Event) => { e.preventDefault(); gestureFrom = viewRef.current; };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (pointers.current.size >= 2) return;
      const ge = e as SafariGesture;
      zoomAt(gestureFrom.s * ge.scale, { x: ge.clientX, y: ge.clientY }, gestureFrom);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
    };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // Keys go to the viewer first: the window underneath closes on Esc too, and
  // Esc here must close only the picture. Tab stays on the close button, the
  // one control here, rather than wandering to the window underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = viewRef.current;
      if (e.key === 'Escape') onCloseRef.current();
      else if (e.key === 'Tab') closeBtn.current?.focus();
      else if (e.key === '+' || e.key === '=') zoomAt(v.s * KEY_ZOOM, centre(), v, true);
      else if (e.key === '-' || e.key === '_') zoomAt(v.s / KEY_ZOOM, centre(), v, true);
      else if (e.key === '0') setView(FIT, true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onResize = () => setScreen({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // A new screen size moves the edges a zoomed picture may reach.
  useLayoutEffect(() => { setView(viewRef.current); }, [screen.w, screen.h, natural]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Focus comes in to the viewer so keys and screen readers land here, and
  // goes back to what opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    return () => { opener?.focus?.(); };
  }, []);

  const shade = Math.max(0, 1 - Math.abs(drop) / 400);
  const transform = `translate(-50%, -50%) translate(${view.x}px, ${view.y + drop}px) scale(${view.s})`;
  return createPortal(
    <div
      ref={root}
      className="photo-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      style={{ backgroundColor: `rgba(0, 0, 0, ${shade.toFixed(3)})` }}
    >
      <div
        ref={stage}
        onDoubleClick={onDoubleClick}
        className={`photo-viewer-stage${view.s > 1 ? ' is-zoomed' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
      >
        <img
          ref={picture}
          className={`photo-viewer-img${crisp ? ' is-crisp' : ''}${animate ? ' is-animating' : ''}`}
          src={src}
          alt={alt}
          draggable={false}
          style={base
            ? { width: base.w, height: base.h, transform }
            : { visibility: 'hidden' }}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
        />
      </div>
      <button ref={closeBtn} className="photo-viewer-close" aria-label="Close" onClick={onClose}>×</button>
    </div>,
    document.body,
  );
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
