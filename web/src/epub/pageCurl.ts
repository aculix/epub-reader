/**
 * Page-turn mechanics.
 *
 * A turn needs two stacked page layers: the moving page pivots in 3D around
 * the spine edge while the destination page sits underneath, revealed as the
 * paper swings away. Perspective on the stage is what makes the text fan and
 * slant like real paper rather than sliding flat.
 *
 * Progress runs 0 → 1, where 0 is "page lying flat" and 1 is "page fully
 * turned". A forward turn animates the OUTGOING page 0 → 1; a backward turn
 * animates the INCOMING page 1 → 0, so both read as the same physical motion.
 *
 * Performance rules this file follows, because the moving layer contains a
 * live iframe full of text:
 *  - the transform is a plain rotateY, so the compositor gets one stable
 *    matrix to interpolate rather than a per-frame cocktail of properties;
 *  - the page is never faded — blending a full-screen iframe every frame is
 *    expensive, and `backface-visibility` hides it past edge-on for free;
 *  - only the small gradient overlays animate opacity.
 */

/** Stop just past edge-on: with the backface hidden there is nothing to show. */
const MAX_DEG = 96;

/** 'curl' pivots the page in 3D; 'slide' pushes it flat (cheapest possible). */
export type TurnMode = 'curl' | 'slide';

export interface CurlElements {
  /** The pivoting page wrapper */
  page: HTMLElement;
  /** Gradient painted over the moving page: shading as it rolls away */
  gloss: HTMLElement;
  /** Shadow the lifted page casts onto the page beneath it */
  cast: HTMLElement;
}

const transformFor = (p: number, rtl: boolean, mode: TurnMode) => {
  const t = Math.min(1, Math.max(0, p));
  if (mode === 'slide') {
    // Pure 2D translate: no re-rasterising, the cheapest thing a compositor does
    const pct = 100 * t;
    return `translate3d(${rtl ? pct : -pct}%, 0, 0)`;
  }
  const deg = MAX_DEG * t;
  return `rotateY(${rtl ? deg : -deg}deg)`;
};

const glossFor = (p: number) => Math.min(0.6, Math.max(0, p) * 1.5);
/** Peaks mid-turn, when the lifted page hangs over the one below. */
const castFor = (p: number) => Math.sin(Math.min(1, Math.max(0, p)) * Math.PI) * 0.45;

export function prepareCurl(el: CurlElements, rtl: boolean, mode: TurnMode = 'curl') {
  el.page.style.transformOrigin = mode === 'slide' ? 'center center' : rtl ? 'right center' : 'left center';
  el.page.style.zIndex = '3';
  // Input would land on a page that is mid-flight
  el.page.style.pointerEvents = 'none';
}

/** Set the turn directly — used while a finger is dragging the page. */
export function setCurlProgress(el: CurlElements, p: number, rtl: boolean, mode: TurnMode = 'curl') {
  el.page.style.transform = transformFor(p, rtl, mode);
  el.gloss.style.opacity = String(glossFor(p));
  el.cast.style.opacity = String(castFor(p));
}

export function clearCurl(el: CurlElements) {
  el.page.style.transform = '';
  el.page.style.zIndex = '';
  el.page.style.pointerEvents = '';
  el.gloss.style.opacity = '0';
  el.cast.style.opacity = '0';
}

export interface CurlRun {
  cancel: () => void;
}

/**
 * Animate the turn between two progress values.
 *
 * Always settles via a timeout: a hand-rolled rAF loop silently stalls in a
 * backgrounded tab and would strand the reader mid-turn.
 */
export function runCurl(
  el: CurlElements,
  from: number,
  to: number,
  durationMs: number,
  rtl: boolean,
  onDone: () => void,
  mode: TurnMode = 'curl'
): CurlRun {
  const options: KeyframeAnimationOptions = {
    duration: durationMs,
    easing: 'cubic-bezier(0.25, 0.9, 0.35, 1)',
    fill: 'forwards',
  };

  // Rotation is linear in progress, so two keyframes describe it exactly and
  // the easing shapes the timing.
  const anims = [
    el.page.animate(
      [{ transform: transformFor(from, rtl, mode) }, { transform: transformFor(to, rtl, mode) }],
      options
    ),
    el.gloss.animate([{ opacity: glossFor(from) }, { opacity: glossFor(to) }], options),
    // The cast shadow peaks mid-turn, so it needs a midpoint keyframe
    el.cast.animate(
      [
        { opacity: castFor(from) },
        { opacity: castFor((from + to) / 2) },
        { opacity: castFor(to) },
      ],
      options
    ),
  ];

  let settled = false;
  const stop = () => {
    for (const a of anims) {
      try { a.cancel(); } catch { /* already gone */ }
    }
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    stop();
    // onDone writes the resting styles itself, so cancelling first is safe
    onDone();
  };

  anims[0].onfinish = finish;
  const timer = setTimeout(finish, durationMs + 150);

  return {
    cancel: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
    },
  };
}
