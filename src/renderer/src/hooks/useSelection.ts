import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

type SelectionPosition = {
  x: number;
  y: number;
};

export type SelectionSnapshot = {
  text: string;
  position: SelectionPosition;
  relativeTop: number;
  clear: (options?: { removeRange?: boolean }) => void;
};

type UseSelectionOptions = {
  disabled?: boolean;
  offset?: number;
};

const DEFAULT_OFFSET = 8;

export function useSelection(
  containerRef: RefObject<HTMLElement | null>,
  { disabled = false, offset = DEFAULT_OFFSET }: UseSelectionOptions = {},
): SelectionSnapshot | null {
  const [selectedText, setSelectedText] = useState("");
  const [selectionPosition, setSelectionPosition] = useState<SelectionPosition>(
    { x: 0, y: 0 },
  );
  const [relativeTop, setRelativeTop] = useState(0);
  const [showSelection, setShowSelection] = useState(false);

  const selectionRangeRef = useRef<Range | null>(null);

  const hideSelection = useCallback(() => {
    setShowSelection(false);
    selectionRangeRef.current = null;
  }, []);

  const clearSelection = useCallback(
    (options?: { removeRange?: boolean }) => {
      hideSelection();
      setSelectedText("");
      selectionRangeRef.current = null;
      if (options?.removeRange && typeof window !== "undefined") {
        window.getSelection()?.removeAllRanges();
      }
    },
    [hideSelection],
  );

  useEffect(() => {
    if (disabled) hideSelection();
  }, [disabled, hideSelection]);

  const computeSelectionMetrics = useCallback(
    (range: Range, containerRect: DOMRect) => {
      const baseRect = range.getBoundingClientRect();
      const rect = baseRect.height || baseRect.width ? baseRect : containerRect;

      let endMidY = Math.round((rect.top + rect.bottom) / 2);
      const endRange = range.cloneRange();
      endRange.collapse(false);
      const endRects = endRange.getClientRects();
      if (endRects && endRects.length > 0) {
        const endRect = endRects[endRects.length - 1];
        if (endRect && (endRect.height || endRect.width)) {
          endMidY = Math.round((endRect.top + endRect.bottom) / 2);
        }
      }

      const relative = endMidY - containerRect.top;
      const position = {
        x: Math.round(containerRect.right + offset),
        y: endMidY,
      };

      return { relativeTop: relative, position };
    },
    [offset],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleSelectionChange = (): void => {
      if (disabled) {
        hideSelection();
        return;
      }

      const selection = window.getSelection();
      if (!selection) {
        hideSelection();
        return;
      }

      const rawText = selection.toString();
      if (!rawText.trim()) {
        hideSelection();
        return;
      }

      const container = containerRef.current;
      const anchor = selection.anchorNode;
      const focus = selection.focusNode;
      if (!container || !anchor || !focus) {
        hideSelection();
        return;
      }

      const inside = container.contains(anchor) && container.contains(focus);
      if (!inside) {
        clearSelection();
        return;
      }

      const range =
        selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
      if (!range) {
        clearSelection();
        return;
      }

      const boxRect = container.getBoundingClientRect();
      const metrics = computeSelectionMetrics(range, boxRect);

      selectionRangeRef.current = range;
      setSelectedText(rawText);
      setRelativeTop(metrics.relativeTop);
      setSelectionPosition(metrics.position);
      setShowSelection(true);
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mouseup", handleSelectionChange);
    document.addEventListener("keyup", handleSelectionChange);

    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mouseup", handleSelectionChange);
      document.removeEventListener("keyup", handleSelectionChange);
    };
  }, [
    containerRef,
    disabled,
    computeSelectionMetrics,
    clearSelection,
    hideSelection,
  ]);

  useEffect(() => {
    if (!showSelection) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    let frameId = 0;
    let scheduled = false;

    const updateFromStoredRange = (): void => {
      const range = selectionRangeRef.current;
      if (!range) return;

      const boxRect = container.getBoundingClientRect();
      const { relativeTop: nextRelativeTop, position: nextPosition } =
        computeSelectionMetrics(range, boxRect);

      setRelativeTop((prev) =>
        Math.abs(prev - nextRelativeTop) > 0.5 ? nextRelativeTop : prev,
      );

      setSelectionPosition((prev) =>
        Math.abs(prev.x - nextPosition.x) > 0.5 ||
        Math.abs(prev.y - nextPosition.y) > 0.5
          ? nextPosition
          : prev,
      );
    };

    // Coalesce every source of movement into at most one measurement per
    // frame. A free-running rAF loop would force layout on every frame for as
    // long as the selection exists, even when nothing moved.
    const schedule = (): void => {
      if (scheduled) return;
      scheduled = true;
      frameId = requestAnimationFrame(() => {
        scheduled = false;
        updateFromStoredRange();
      });
    };

    updateFromStoredRange();

    // Panning/zooming the canvas and dragging the node both rewrite an inline
    // transform rather than firing scroll events, so watch those attributes.
    const transformTargets = [
      container,
      container.closest(".react-flow__viewport"),
      container.closest(".react-flow__node"),
    ].filter((el): el is Element => el !== null);

    const observers = transformTargets.map((el) => {
      const observer = new MutationObserver(schedule);
      observer.observe(el, { attributes: true, attributeFilter: ["style"] });
      return observer;
    });

    // Content streaming in above the selection shifts it as well.
    const contentObserver = new MutationObserver(schedule);
    contentObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    observers.push(contentObserver);

    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);

    return () => {
      cancelAnimationFrame(frameId);
      for (const observer of observers) observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [showSelection, computeSelectionMetrics, containerRef]);

  return useMemo(() => {
    if (!showSelection || !selectedText.trim()) return null;

    return {
      text: selectedText,
      position: selectionPosition,
      relativeTop,
      clear: clearSelection,
    };
  }, [showSelection, selectedText, selectionPosition, relativeTop, clearSelection]);
}
