import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Focus management for dialogs, drawers and popovers: moves focus inside on
 * open, keeps Tab cycling within the container, and restores focus to the
 * trigger on close. Pair with `inert` on the background content for full
 * modal semantics.
 */
export function useDialogFocus<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  // Held outside the effect so StrictMode's double-invoke (and any re-run)
  // can't overwrite the real trigger with an element inside the dialog.
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      triggerRef.current = null;
      return;
    }
    const container = ref.current;
    if (!container) return;

    const active = document.activeElement as HTMLElement | null;
    if (!triggerRef.current && active && !container.contains(active)) {
      triggerRef.current = active;
    }

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0
      );

    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    (focusables()[0] ?? container).focus();

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
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
        // Focus escaped (e.g. clicked outside, then Tab) — pull it back in
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeydown, true);
    return () => {
      document.removeEventListener('keydown', onKeydown, true);
      const trigger = triggerRef.current;
      if (!trigger?.isConnected) return;
      triggerRef.current = null;
      // The dialog may still be animating out, and detaching the focused node
      // drops focus to <body> after the first attempt — verify and retry for a
      // few frames until the trigger actually holds focus.
      let attempts = 0;
      const restore = () => {
        if (document.activeElement === trigger) return;
        const current = document.activeElement;
        const focusIsLoose = !current || current === document.body || container.contains(current);
        if (focusIsLoose) trigger.focus();
        if (++attempts < 8 && document.activeElement !== trigger) {
          requestAnimationFrame(restore);
        }
      };
      requestAnimationFrame(restore);
    };
  }, [open]);

  return ref;
}
