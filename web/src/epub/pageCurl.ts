/**
 * Page-curl mechanics.
 *
 * A turn needs two stacked page layers: the moving page pivots in 3D around
 * the spine edge while the destination page sits underneath, revealed as the
 * paper lifts away. Perspective on the stage is what makes the text fan and
 * slant like a real turning page rather than sliding flat.
 *
 * Progress runs 0 → 1, where 0 is "page lying flat" and 1 is "page fully
 * turned". A forward turn animates the OUTGOING page 0 → 1; a backward turn
 * animates the INCOMING page 1 → 0, so both read as the same physical motion.
 */

/** How far the paper swings before it is edge-on and out of sight. */
const MAX_DEG = 164;
/** Slight lift toward the reader so the page doesn't shear into the surface. */
const MAX_LIFT_PX = 26;
/** The paper fades out as it turns edge-on, so no mirrored text is ever shown. */
const FADE_FROM = 0.5;
const FADE_TO = 0.78;

export interface CurlElements {
  /** The pivoting page wrapper */
  page: HTMLElement;
  /** Gradient painted over the moving page: shading as it rolls away */
  gloss: HTMLElement;
  /** Shadow the lifted page casts onto the page beneath it */
  cast: HTMLElement;
}

interface CurlValues {
  transform: string;
  pageOpacity: number;
  gloss: number;
  cast: number;
}

function curlValues(p: number, rtl: boolean): CurlValues {
  const t = Math.min(1, Math.max(0, p));
  const deg = MAX_DEG * t;
  const lift = Math.sin(t * Math.PI) * MAX_LIFT_PX;
  return {
    transform: `translateZ(${lift}px) rotateY(${rtl ? deg : -deg}deg)`,
    pageOpacity: t <= FADE_FROM ? 1 : Math.max(0, 1 - (t - FADE_FROM) / (FADE_TO - FADE_FROM)),
    gloss: Math.min(0.55, t * 1.35),
    // Peaks mid-turn, when the lifted page hangs over the one below
    cast: Math.sin(t * Math.PI) * 0.5,
  };
}

export function prepareCurl(el: CurlElements, rtl: boolean) {
  el.page.style.transformOrigin = rtl ? 'right center' : 'left center';
  el.page.style.willChange = 'transform, opacity';
  el.page.style.zIndex = '3';
}

/** Set the curl directly — used while a finger is dragging the page. */
export function setCurlProgress(el: CurlElements, p: number, rtl: boolean) {
  const v = curlValues(p, rtl);
  el.page.style.transform = v.transform;
  el.page.style.opacity = String(v.pageOpacity);
  el.gloss.style.opacity = String(v.gloss);
  el.cast.style.opacity = String(v.cast);
}

export function clearCurl(el: CurlElements) {
  el.page.style.transform = '';
  el.page.style.opacity = '';
  el.page.style.willChange = '';
  el.page.style.zIndex = '';
  el.gloss.style.opacity = '0';
  el.cast.style.opacity = '0';
}

export interface CurlRun {
  cancel: () => void;
}

/**
 * Animate the curl between two progress values.
 *
 * Uses the Web Animations API with sampled keyframes (the shading peaks
 * mid-turn, so a plain two-point transition would miss it), and always
 * settles via a timeout — a hand-rolled rAF loop silently stalls in a
 * backgrounded tab and would strand the reader mid-turn.
 */
export function runCurl(
  el: CurlElements,
  from: number,
  to: number,
  durationMs: number,
  rtl: boolean,
  onDone: () => void
): CurlRun {
  const SAMPLES = 12;
  const page: Keyframe[] = [];
  const gloss: Keyframe[] = [];
  const cast: Keyframe[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const v = curlValues(from + (to - from) * (i / SAMPLES), rtl);
    page.push({ transform: v.transform, opacity: v.pageOpacity });
    gloss.push({ opacity: v.gloss });
    cast.push({ opacity: v.cast });
  }

  const options: KeyframeAnimationOptions = {
    duration: durationMs,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'forwards',
  };

  const anims = [
    el.page.animate(page, options),
    el.gloss.animate(gloss, options),
    el.cast.animate(cast, options),
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
