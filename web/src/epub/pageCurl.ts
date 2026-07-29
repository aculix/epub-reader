/**
 * Page-turn mechanics — lift the sheet, then carry it away.
 *
 * The reference has two importantly different surfaces:
 *   - the destination page lies flat and never moves;
 *   - the page being turned is lifted at its trailing edge, then travels over
 *     the destination. Its text moves with the paper.
 *
 * The outer page layers never transform. The moving sheet stays inside the
 * proven clip/counter-translate structure: the clip edge follows the gesture
 * immediately, while a partial counter-translate lets the body of the paper lag
 * during the initial lift and catch up as it is carried. That differential is
 * what separates lifting a sheet from sliding a card, and it costs nothing —
 * every per-frame transform here is affine. See innerTransform.
 *
 * What is deliberately NOT reproduced: the reference foreshortens the lifted
 * sheet in perspective, so its lines splay away from the vertical centre. Play
 * Books can do that because its page is already a GPU texture. Ours is a live
 * document in an iframe, and warping it per frame re-rasterises every glyph.
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
const FOLD_W = 10;
/**
 * A 2D rotation turns every line by the SAME angle instead of splaying them, so
 * it has to stay small — past about 8deg the sheet reads as crooked rather than
 * lifted. This buys a tilt cue for free; see innerTransform for why it must
 * remain a 2D rotate.
 */
const MAX_TILT_DEG = 5;
/**
 * The page body initially lags the hand: first the edge lifts, then the sheet
 * is carried. A power above 1 gives that two-stage travel without a branch.
 */
const CARRY_EXPONENT = 1.3;
/**
 * The sheet stops short of sweeping its full width, so a sliver of the iframe's
 * compositor surface stays on-screen behind the closed clip. Browsers are liable
 * to throttle a fully off-screen iframe and repaint it when a slow drag
 * reverses. This is a flat scale rather than a term that only bites at the end:
 * subtracting e.g. lift^8 collapses the sheet's velocity over the last 20% of
 * the turn, and text braking against a crease that keeps moving is exactly what
 * makes the page look like it is rolling up into a tube.
 */
const TRAVEL_CAP = 0.88;

interface Geometry {
  clipTx: number;
  innerTx: number;
  /** Pivot in the inner surface's own coordinate space */
  originX: number;
  /** Lit edge position (the band sits just inside the crease) */
  edgeTx: number;
  shadeTx: number;
  /** In-plane rotation of the moving sheet, in degrees */
  tilt: number;
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
  const carried = width * TRAVEL_CAP * Math.pow(lift, CARRY_EXPONENT);
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

  // The sheet is flat at rest, most off-axis while it is being carried, and flat
  // again by the time it leaves — so the tilt has to vanish at BOTH ends or an
  // interrupted drag snaps a crooked page back into place.
  const tiltMag = MAX_TILT_DEG * Math.sin(lift * Math.PI);
  const edgeEnvelope = Math.min(1, lift * 12, (1 - lift) * 20);
  const shadeEnvelope = Math.min(1, lift * 5, (1 - lift) * 10);

  return {
    clipTx,
    innerTx,
    originX,
    // The lit edge sits just inside the crease rather than straddling it, so the
    // shadow on the far side is the only thing beyond the fold.
    edgeTx: mirror ? edge : edge - FOLD_W,
    shadeTx: mirror ? edge - SHADE_W : edge,
    tilt: mirror ? -tiltMag : tiltMag,
    edgeOpacity: Math.max(0, edgeEnvelope),
    shadeOpacity: Math.max(0, shadeEnvelope) * 0.72,
  };
}

/**
 * Bake the moving pivot into the matrix so transform-origin itself never
 * animates. With CSS transform-origin fixed at left centre, these translations
 * are exactly equivalent to pivoting at g.originX.
 *
 * The rotation MUST stay a 2D `rotate`. This element contains the live chapter
 * iframe, and the difference between an affine and a projective transform here
 * is the difference between a smooth turn and a flickering one:
 *
 *   rotate()                 preserves scale, so the text is rastered once and
 *                            the compositor just re-orients that texture.
 *   perspective() rotateY()  is non-affine — the effective scale varies across
 *                            the layer and changes every frame, so the browser
 *                            re-shapes and re-rasters all the text per frame.
 *                            On a slow drag that reads as flicker.
 *
 * A projective warp would reproduce the reference's line-splay exactly, but no
 * amount of tuning makes re-rasterising a document per frame cheap, and the
 * iframe cannot be snapshotted to a texture we could warp instead.
 *
 * Rotating inside the clip would normally uncover wedges at the clip's corners;
 * it does not show here because .page-clip is painted opaque in the page colour,
 * so those wedges are the same colour as the paper.
 */
function innerTransform(g: Geometry): string {
  return `translate3d(${g.innerTx + g.originX}px, 0, 0) ` +
    `rotate(${g.tilt}deg) ` +
    `translate3d(${-g.originX}px, 0, 0)`;
}

export function prepareTurn(el: TurnElements, mirror: boolean, mode: TurnMode) {
  el.overLayer.style.zIndex = '3';
  el.overLayer.style.pointerEvents = 'none';
  el.inner.style.transformOrigin = 'left center';
  el.shade.dataset.side = mirror ? 'left' : 'right';
  el.flap.dataset.side = mirror ? 'left' : 'right';
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
