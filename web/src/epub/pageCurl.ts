/**
 * Page-turn mechanics — a peel, not a swing.
 *
 * The previous implementation rotated the whole page, which reads as a panel
 * sliding rather than paper lifting, and forced the browser to re-rasterise a
 * live iframe on every frame (the flicker on slow drags).
 *
 * This model matches what a real page does:
 *   - the page you are leaving stays FLAT AND STILL — never transformed;
 *   - a fold line travels across the sheet;
 *   - the destination page is uncovered behind the fold;
 *   - the turned-over portion lands on top of what remains, showing the
 *     back of the paper.
 *
 * Nothing containing text ever moves on screen. The destination page sits in
 * a clip container that is translated, with its content counter-translated by
 * the same amount, so the text is pinned to the viewport while only the clip
 * edge sweeps. Every animated property is a compositor transform, so no page
 * is re-rasterised or pushed off-screen (where browsers throttle iframe
 * rendering and then repaint on re-entry — the other half of the flicker).
 *
 * Progress runs 0 → 1: 0 = nothing turned, 1 = the turn is complete. Forward
 * turns uncover the new page from the trailing edge; backward turns uncover it
 * from the spine edge, which is the same motion mirrored.
 */

export type TurnMode = 'curl' | 'slide';

export interface TurnElements {
  /** The layer being revealed (raised above the resting page) */
  overLayer: HTMLElement;
  /** Clip window over the revealed page — this is what actually sweeps */
  clip: HTMLElement;
  /** Content inside the clip, counter-translated so the text never moves */
  inner: HTMLElement;
  /** The turned-over portion of paper, lying on what remains */
  flap: HTMLElement;
  /** Shadow the fold casts onto the newly uncovered page */
  shade: HTMLElement;
}

const SHADE_W = 64;
/** Width of the lit crease where the sheet bends. */
const FOLD_W = 30;
/** How far the settling page is still tilted when the fold starts out. */
const MAX_TILT_DEG = 3.5;

interface Geometry {
  fold: number;
  clipTx: number;
  innerTx: number;
  /** Crease position (the band is centred on the fold) */
  foldTx: number;
  shadeTx: number;
  /** Tilt of the page still settling out of the fold, in degrees */
  tilt: number;
}

/**
 * `fromRight` is a forward turn in a left-to-right book: the sheet is lifted
 * at its trailing edge and folded back toward the spine.
 */
function geometryFor(p: number, width: number, fromRight: boolean): Geometry {
  const t = Math.min(1, Math.max(0, p));
  // The sheet is still bent early in the turn and lies flat by the end
  const tiltMag = MAX_TILT_DEG * (1 - t);
  if (fromRight) {
    const fold = width * (1 - t);
    return {
      fold,
      clipTx: fold,
      innerTx: -fold,
      foldTx: fold - FOLD_W / 2,
      shadeTx: fold,
      tilt: -tiltMag,
    };
  }
  const fold = width * t;
  return {
    fold,
    clipTx: fold - width,
    innerTx: width - fold,
    foldTx: fold - FOLD_W / 2,
    shadeTx: fold - SHADE_W,
    tilt: tiltMag,
  };
}

export function prepareTurn(el: TurnElements, fromRight: boolean, mode: TurnMode) {
  el.overLayer.style.zIndex = '3';
  el.overLayer.style.pointerEvents = 'none';
  el.shade.dataset.side = fromRight ? 'right' : 'left';
  // Explicit 'block': setting '' falls back to the stylesheet's display:none
  const showPaper = mode === 'curl' ? 'block' : 'none';
  el.flap.style.display = showPaper;
  el.shade.style.display = showPaper;
}

export function setTurnProgress(
  el: TurnElements,
  p: number,
  width: number,
  fromRight: boolean,
  mode: TurnMode
) {
  const t = Math.min(1, Math.max(0, p));

  if (mode === 'slide') {
    // The whole destination page rides in from the edge
    const off = width * (1 - t);
    el.clip.style.transform = `translate3d(${fromRight ? off : -off}px, 0, 0)`;
    el.inner.style.transform = 'translate3d(0, 0, 0)';
    return;
  }

  const g = geometryFor(t, width, fromRight);
  el.clip.style.transform = `translate3d(${g.clipTx}px, 0, 0)`;
  // Anchor the bend at the crease, so the page hinges out of the fold
  el.inner.style.transformOrigin = `${g.fold}px center`;
  el.inner.style.transform = `translate3d(${g.innerTx}px, 0, 0) rotate(${g.tilt}deg)`;
  el.flap.style.transform = `translate3d(${g.foldTx}px, 0, 0)`;
  el.flap.style.opacity = t > 0.01 && t < 0.995 ? '1' : '0';
  el.shade.style.transform = `translate3d(${g.shadeTx}px, 0, 0)`;
  el.shade.style.opacity = String(Math.min(1, t * 4) * 0.85);
}

export function clearTurn(el: TurnElements) {
  el.overLayer.style.zIndex = '';
  el.overLayer.style.pointerEvents = '';
  el.clip.style.transform = '';
  el.inner.style.transform = '';
  el.inner.style.transformOrigin = '';
  el.flap.style.transform = '';
  el.flap.style.opacity = '0';
  el.flap.style.display = 'none';
  el.shade.style.transform = '';
  el.shade.style.opacity = '0';
  el.shade.style.display = 'none';
}

export interface TurnRun {
  cancel: () => void;
}

/**
 * Animate the fold between two progress values.
 *
 * Sampled keyframes: the clip and its counter-translate must stay exactly in
 * step or the text visibly drifts. Always settles via a timeout — a rAF loop
 * stalls in a backgrounded tab and would strand the reader mid-turn.
 */
export function runTurn(
  el: TurnElements,
  from: number,
  to: number,
  width: number,
  durationMs: number,
  fromRight: boolean,
  mode: TurnMode,
  onDone: () => void
): TurnRun {
  const SAMPLES = 10;
  const clip: Keyframe[] = [];
  const inner: Keyframe[] = [];
  const flap: Keyframe[] = [];
  const shade: Keyframe[] = [];

  for (let i = 0; i <= SAMPLES; i++) {
    const t = from + (to - from) * (i / SAMPLES);
    if (mode === 'slide') {
      const off = width * (1 - t);
      clip.push({ transform: `translate3d(${fromRight ? off : -off}px, 0, 0)` });
      inner.push({ transform: 'translate3d(0, 0, 0)' });
      continue;
    }
    const g = geometryFor(t, width, fromRight);
    clip.push({ transform: `translate3d(${g.clipTx}px, 0, 0)` });
    inner.push({
      transformOrigin: `${g.fold}px center`,
      transform: `translate3d(${g.innerTx}px, 0, 0) rotate(${g.tilt}deg)`,
    });
    flap.push({
      transform: `translate3d(${g.foldTx}px, 0, 0)`,
      opacity: t > 0.01 && t < 0.995 ? 1 : 0,
    });
    shade.push({
      transform: `translate3d(${g.shadeTx}px, 0, 0)`,
      opacity: Math.min(1, t * 4) * 0.85,
    });
  }

  const options: KeyframeAnimationOptions = {
    duration: durationMs,
    easing: 'cubic-bezier(0.25, 0.9, 0.35, 1)',
    fill: 'forwards',
  };

  const anims = [el.clip.animate(clip, options), el.inner.animate(inner, options)];
  if (mode === 'curl') {
    anims.push(el.flap.animate(flap, options), el.shade.animate(shade, options));
  }

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
