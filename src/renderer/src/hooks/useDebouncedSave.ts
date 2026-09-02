import { useEffect, useRef } from "react";
import { useCanvasStoreApi } from "./useCanvasStore";

/**
 * Flush `save()` once changes go quiet — with a ceiling on how long that can be
 * deferred.
 *
 * A plain debounce is wrong here: every streamed token marks the canvas dirty,
 * so during a long response the timer was rearmed hundreds of times a second and
 * the canvas was never written until the stream stopped. A crash or quit mid-run
 * lost the whole turn. `maxWaitMs` guarantees a write even while changes keep
 * arriving.
 */
export function useDebouncedSave(delayMs = 1200, maxWaitMs = 10_000) {
  const storeApi = useCanvasStoreApi();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPendingAtRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimer = (): void => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const flush = (): void => {
      clearTimer();
      firstPendingAtRef.current = null;
      void storeApi.getState().save();
    };

    const unsub = storeApi.subscribe(
      (s) => s.dirty.lastChangeAt,
      () => {
        const now = Date.now();
        if (firstPendingAtRef.current === null) firstPendingAtRef.current = now;

        // Never let continuous activity postpone a write indefinitely.
        if (now - firstPendingAtRef.current >= maxWaitMs) {
          flush();
          return;
        }

        clearTimer();
        timerRef.current = setTimeout(flush, delayMs);
      }
    );

    const onUnload = (): void => {
      void storeApi.getState().save();
    };
    window.addEventListener("beforeunload", onUnload);

    return () => {
      unsub();
      window.removeEventListener("beforeunload", onUnload);
      clearTimer();
    };
  }, [delayMs, maxWaitMs, storeApi]);
}
