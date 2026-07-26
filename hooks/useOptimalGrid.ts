"use client";

import { RefObject, useLayoutEffect, useState } from "react";

interface GridMetrics {
  columns: number;
  gap: number;
  tileHeight: number;
  tileWidth: number;
}

const EMPTY_METRICS: GridMetrics = {
  columns: 1,
  gap: 12,
  tileHeight: 0,
  tileWidth: 0,
};

function calculateGrid(
  width: number,
  height: number,
  itemCount: number,
): GridMetrics {
  if (!width || !height || !itemCount) {
    return EMPTY_METRICS;
  }

  const gap = itemCount > 12 ? 8 : itemCount > 6 ? 10 : 12;
  let best = EMPTY_METRICS;
  let bestArea = 0;

  for (let columns = 1; columns <= itemCount; columns += 1) {
    const rows = Math.ceil(itemCount / columns);
    const widthByColumns = (width - gap * (columns - 1)) / columns;
    const heightFromWidth = widthByColumns * (9 / 16);
    const heightByRows = (height - gap * (rows - 1)) / rows;
    const tileHeight = Math.min(heightFromWidth, heightByRows);
    const tileWidth = tileHeight * (16 / 9);
    const area = tileWidth * tileHeight;

    if (
      tileWidth <= widthByColumns + 0.5 &&
      tileHeight <= heightByRows + 0.5 &&
      area > bestArea
    ) {
      bestArea = area;
      best = {
        columns,
        gap,
        tileHeight: Math.floor(tileHeight),
        tileWidth: Math.floor(tileWidth),
      };
    }
  }

  return best;
}

export function useOptimalGrid(
  containerRef: RefObject<HTMLElement | null>,
  itemCount: number,
) {
  const [metrics, setMetrics] = useState<GridMetrics>(EMPTY_METRICS);

  useLayoutEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const update = () => {
      const bounds = container.getBoundingClientRect();
      const styles = window.getComputedStyle(container);
      const horizontalPadding =
        Number.parseFloat(styles.paddingLeft) +
        Number.parseFloat(styles.paddingRight);
      const verticalPadding =
        Number.parseFloat(styles.paddingTop) +
        Number.parseFloat(styles.paddingBottom);

      setMetrics(
        calculateGrid(
          bounds.width - horizontalPadding,
          bounds.height - verticalPadding,
          itemCount,
        ),
      );
    };
    const observer = new ResizeObserver(update);

    observer.observe(container);
    update();

    return () => observer.disconnect();
  }, [containerRef, itemCount]);

  return metrics;
}
