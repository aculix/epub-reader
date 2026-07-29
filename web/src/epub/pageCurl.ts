/**
 * Page-turn mechanics — lift the sheet, then carry it away.
 *
 * The reference has two importantly different surfaces:
 *   - the destination page lies flat and never moves;
 *   - the page being turned is lifted at its trailing edge, then travels over
 *     the destination. Its text moves with the paper and is foreshortened in
 *     perspective (top and bottom lines converge toward the vertical centre).
 *
 * The outer page layers still never transform. The moving sheet remains inside
 * the proven clip/counter-translate structure: the clip edge follows the
 * gesture immediately, while a partial counter-translate lets the body of the
 * paper lag during the initial lift and catch up during the turn. The only
 * deformation is a shallow rotateY on that clipped inner surface. It never
 * approaches edge-on, never fades, and never uses backface culling — avoiding
 * the expensive full-layer swing which made the iframe flicker.
 *
 * Progress runs 0 → 1 for both directions. A forward turn lifts the outgoing
 * sheet from flat to gone; a backward turn plays that same path in reverse,
 * bringing the previous sheet back and laying it flat.
 */

export type TurnMode = 'curl' | 'slide';

export interface TurnElements {
  /** The layer containing the sheet that is lifted */
  overLayer: HTMLElement;
  /** Clip window whose travelling edge exposes the page underneath */
  clip: HTMLElement;
  /** The live page surface inside the clip */
  inner: HTMLElement;
  /** Narrow highlight on the lifted edge (historic name: flap) */
  flap: HTMLElement;
  /** Shadow the lifted edge casts onto the page underneath */
  shade: HTMLElement;
}

const SHADE_W = 72;
/** Width of the lit paper edge. Keep in step with .turn-flap in reader.css. */
const FOLD_W = 22;
/** The reference stays face-on enough to remain readable throughout. */
const MAX_TILT_DEG = 34;
/** Camera distance as a multiple of the viewport width. */
const PERSPECTIVE_RATIO = 2.5;
/** Avoid an over-aggressive projection on narrow phone viewports. */
const MIN_PERSPECTIVE_PX = 1100;
/**
 * The page body initially lags the hand: first the edge lifts, then the sheet
 * is carried. A power above 1 gives that two-stage travel without a branch.
 */
const CARRY_EXPONENT = 1.45;
/**
 * Leave a sliver of the iframe's compositor surface on-screen even after its
 * clip closes. Browsers are liable to throttle a fully off-screen iframe and
 * repaint it when a slow drag reverses; the closed clip hides this guard.
 */
const RASTER_GUARD = 0.14;

interface Geometry {
  clipTx: number;
  innerTx: number;
  /** Pivot in the inner surface's own coordinate space */
  originX: number;
  /** Lit edge position (the band is centred on it) */
  edgeTx: number;
  shadeTx: number;
  /** Vertical-axis tilt of the moving sheet, in degrees */
  tilt: number;
  perspective: number;
  edgeOpacity: number;
  shadeOpacity: number;
}

/**
 * 'lift' is a forward turn: the sheet you are reading is picked up and carried
 * away, uncovering the next page beneath it.
 * 'lay' is a backward turn: the previous sheet is brought back over and laid
 * down flat again. Same motion, played the other way.
 */
export type TurnPhase = 'lift' | 'lay';

/**
 * Geometry is expressed as one physical "lift" value:
 *   0 = the sheet lies flat; 1 = it has left the viewport.
 *
 * Forward progress raises lift from 0 → 1. Backward progress lowers it from
 * 1 → 0, so a backward turn is the exact reverse path rather than a different
 * animation that merely happens to travel the other way.
 */
function geometryFor(p: number, width: number, phase: TurnPhase, mirror: boolean): Geometry {
  const t = Math.min(1, Math.max(0, p));
  const lift = phase === 'lift' ? t : 1 - t;
  const swept = width * lift;
  const carried = width * (
    Math.pow(lift, CARRY_EXPONENT) -
    RASTER_GUARD * Math.pow(lift, 8)
  );
  const direction = mirror ? 1 : -1;

  // The clip edge travels with the hand. The page body travels less at first,
  // which is the visual difference between lifting a sheet and sliding a card.
  const clipTx = direction * swept;
  const pageTx = direction * carried;
  const innerTx = pageTx - clipTx;

  // Screen-space position of the lifted edge. Pivoting the page at this point
  // keeps the deformed text welded to the crease instead of swimming through
  // it as the partial counter-translation changes.
  const edge = mirror ? swept : width - swept;
  const originX = edge - pageTx;

  // A vertical-axis perspective tilt is what creates the reference's tell:
  // upper lines slope toward the centre one way, lower lines the other way.
  const tiltMag = MAX_TILT_DEG * Math.sin(lift * Math.PI / 2);
  const edgeEnvelope = Math.min(1, lift * 12, (1 - lift) * 20);
  const shadeEnvelope = Math.min(1, lift * 5, (1 - lift) * 10);

  return {
    clipTx,
    innerTx,
    originX,
    edgeTx: edge - FOLD_W / 2,
    shadeTx: mirror ? edge - SHADE_W : edge,
    tilt: mirror ? -tiltMag : tiltMag,
    perspective: Math.max(MIN_PERSPECTIVE_PX, width * PERSPECTIVE_RATIO),
    edgeOpacity: Math.max(0, edgeEnvelope),
    shadeOpacity: Math.max(0, shadeEnvelope) * 0.72,
  };
}

/**
 * Bake the moving pivot into the matrix so transform-origin itself never
 * animates. With CSS transform-origin fixed at left centre, these translations
 * are exactly equivalent to pivoting at g.originX.
 */
function innerTransform(g: Geometry): string {
  return `translate3d(${g.innerTx + g.originX}px, 0, 0) ` +
    `perspective(${g.perspective}px) rotateY(${g.tilt}deg) ` +
    `translate3d(${-g.originX}px, 0, 0)`;
}

export function prepareTurn(el: TurnElements, mirror: boolean, mode: TurnMode) {
  el.overLayer.style.zIndex = '3';
  el.overLayer.style.pointerEvents = 'none';
  el.inner.style.transformOrigin = 'left center';
  el.shade.dataset.side = mirror ? 'left' : 'right';
  // Explicit 'block': setting '' falls back to the stylesheet's display:none.
  const showPaper = mode === 'curl' ? 'block' : 'none';
  el.flap.style.display = showPaper;
  el.shade.style.display = showPaper;
}

export function setTurnProgress(
  el: TurnElements,
  p: number,
  width: number,
  phase: TurnPhase,
  mirror: boolean,
  mode: TurnMode
) {
  const t = Math.min(1, Math.max(0, p));

  if (mode === 'slide') {
    // Preserve the existing flat reveal: its text stays pinned while the clip
    // edge travels. Only Curl adds the lifted-sheet deformation.
    const fold = phase === 'lift' ? width * (1 - t) : width * t;
    const off = mirror ? width - fold : fold - width;
    el.clip.style.transform = `translate3d(${off}px, 0, 0)`;
    el.inner.style.transform = `translate3d(${-off}px, 0, 0)`;
    return;
  }

  const g = geometryFor(t, width, phase, mirror);
  el.clip.style.transform = `translate3d(${g.clipTx}px, 0, 0)`;
  el.inner.style.transform = innerTransform(g);
  el.flap.style.transform = `translate3d(${g.edgeTx}px, 0, 0)`;
  el.flap.style.opacity = String(g.edgeOpacity);
  el.shade.style.transform = `translate3d(${g.shadeTx}px, 0, 0)`;
  el.shade.style.opacity = String(g.shadeOpacity);
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
 * Animate the turn between two progress values.
 *
 * Sampled keyframes keep the non-linear carry, moving pivot, and clip edge on
 * one trajectory. Always settles via a timeout — a rAF loop stalls in a
 * backgrounded tab and would strand the reader mid-turn.
 */
export function runTurn(
  el: TurnElements,
  from: number,
  to: number,
  width: number,
  durationMs: number,
  phase: TurnPhase,
  mirror: boolean,
  mode: TurnMode,
  onDone: () => void
): TurnRun {
  const SAMPLES = 12;
  const clip: Keyframe[] = [];
  const inner: Keyframe[] = [];
  const flap: Keyframe[] = [];
  const shade: Keyframe[] = [];

  for (let i = 0; i <= SAMPLES; i++) {
    const t = from + (to - from) * (i / SAMPLES);
    if (mode === 'slide') {
      const fold = phase === 'lift' ? width * (1 - t) : width * t;
      const off = mirror ? width - fold : fold - width;
      clip.push({ transform: `translate3d(${off}px, 0, 0)` });
      inner.push({ transform: `translate3d(${-off}px, 0, 0)` });
      continue;
    }
    const g = geometryFor(t, width, phase, mirror);
    clip.push({ transform: `translate3d(${g.clipTx}px, 0, 0)` });
    inner.push({ transform: innerTransform(g) });
    flap.push({
      transform: `translate3d(${g.edgeTx}px, 0, 0)`,
      opacity: g.edgeOpacity,
    });
    shade.push({
      transform: `translate3d(${g.shadeTx}px, 0, 0)`,
      opacity: g.shadeOpacity,
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
