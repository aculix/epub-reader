import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Open dialogs, innermost last. Only the top of the stack traps Tab — with two
 * traps active (a confirm dialog over the detail modal) each would drag focus
 * back to itself and Tab would deadlock.
 */
const openDialogs: HTMLElement[] = [];

/**
 * Focus management for dialogs, drawers and popovers: moves focus inside on
 * open, keeps Tab cycling within the topmost surface, and restores focus to
 * the trigger on close. Pair with `inert` on the background content for full
 * modal semantics.
 */
export function useDialogFocus<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  // Held outside the effect so StrictMode's double-invoke (and any re-run)
  // can't overwrite the real trigger with an element inside the dialog.
  const triggerRef = useRef<HTMLElement | null>(null);
  const pendingRestore = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open) {
      // A real close: let the restore queued by the cleanup run.
      triggerRef.current = null;
      return;
    }
    // Re-entering while still open is StrictMode's synthetic remount, not a
    // close — abandon the restore its cleanup queued.
    pendingRestore.current = null;
    const container = ref.current;
    if (!container) return;

    const active = document.activeElement as HTMLElement | null;
    // document.body means the trigger already unmounted — no restore target
    if (!triggerRef.current && active && active !== document.body && !container.contains(active)) {
      triggerRef.current = active;
    }

    openDialogs.push(container);

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0
      );

    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    (focusables()[0] ?? container).focus();

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // Only the innermost open dialog owns the trap
      if (openDialogs[openDialogs.length - 1] !== container) return;
      const els = focusables();
      if (!els.length) {
        e.preventDefault();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === container)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      } else if (current && !container.contains(current)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeydown, true);
    return () => {
      document.removeEventListener('keydown', onKeydown, true);
      const i = openDialogs.indexOf(container);
      if (i !== -1) openDialogs.splice(i, 1);

      const trigger = triggerRef.current;
      if (!trigger?.isConnected) return;

      // The dialog may still be animating out, and detaching the focused node
      // drops focus to <body> after the first attempt — verify and retry until
      // the trigger actually holds focus.
      let attempts = 0;
      const restore = () => {
        // Cancelled by a re-entering effect (StrictMode's synthetic remount)
        if (pendingRestore.current !== restore) return;
        if (document.activeElement === trigger) return;
        const current = document.activeElement;
        const focusIsLoose = !current || current === document.body || container.contains(current);
        if (focusIsLoose && trigger.isConnected) trigger.focus();
        if (++attempts < 8 && document.activeElement !== trigger) {
          // Both schedulers: rAF is throttled in background tabs, timeouts are not
          requestAnimationFrame(restore);
          setTimeout(restore, 32);
        }
      };
      pendingRestore.current = restore;
      // Deferred by one task so a StrictMode remount can cancel it first
      setTimeout(restore, 0);
    };
  }, [open]);

  return ref;
}
