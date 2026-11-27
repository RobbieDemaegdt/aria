/** Keyboard focus that follows a small form or a confirmation as it opens and closes, so it doesn't fall back to the page. */
import { useEffect, useRef, type RefObject } from "react";

/**
 * A ref, and a call that moves the focus to its element once it's rendered: ask before the state change that shows the
 * element (a form's trigger coming back on Cancel, Keep appearing on a delete), and the focus lands there after it.
 */
export function useFocusLater<T extends HTMLElement>(): [RefObject<T | null>, () => void] {
  const ref = useRef<T>(null);
  const wanted = useRef(false);
  useEffect(() => {
    if (!wanted.current || !ref.current) return;
    wanted.current = false;
    ref.current.focus();
  });
  return [
    ref,
    () => {
      wanted.current = true;
    },
  ];
}
