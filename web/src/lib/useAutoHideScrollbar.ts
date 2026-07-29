import { useCallback, useEffect, useRef, type RefObject } from 'react';

function attachScrollFade(el: HTMLElement) {
  let timer: ReturnType<typeof setTimeout>;
  const onScroll = () => {
    el.classList.add('is-scrolling');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('is-scrolling'), 900);
  };
  el.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    el.removeEventListener('scroll', onScroll);
    clearTimeout(timer);
  };
}

/**
 * Pairs with the `.quire-scroll` utility class: the scrollbar stays invisible
 * until the element actually scrolls (or is hovered), then fades away ~900ms
 * after scrolling stops.
 *
 * Without arguments it returns a callback ref (safe for conditionally
 * rendered elements like drawers). Pass an existing ref object instead when
 * the element owns one already and is always mounted.
 */
export function useAutoHideScrollbar<T extends HTMLElement>(externalRef?: RefObject<T | null>) {
  const cleanupRef = useRef<(() => void) | null>(null);

  const callbackRef = useCallback((el: T | null) => {
    cleanupRef.current?.();
    cleanupRef.current = el ? attachScrollFade(el) : null;
  }, []);

  useEffect(() => {
    if (!externalRef?.current) return;
    return attachScrollFade(externalRef.current);
  }, [externalRef]);

  useEffect(() => () => cleanupRef.current?.(), []);

  return callbackRef;
}
