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
  topologyWidth = width,
): GridMetrics {
  if (!width || !height || !itemCount) {
    return EMPTY_METRICS;
  }

  const gap = itemCount > 12 ? 8 : itemCount > 6 ? 10 : 12;
  let best = EMPTY_METRICS;
  let bestArea = 0;
  const layoutWidth = Math.max(width, topologyWidth);

  for (let columns = 1; columns <= itemCount; columns += 1) {
    const rows = Math.ceil(itemCount / columns);
    const widthByColumns =
      (layoutWidth - gap * (columns - 1)) / columns;
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
      const fittedWidth = Math.floor(tileWidth);
      const fittedHeight = fittedWidth * (9 / 16);

      bestArea = area;
      best = {
        columns,
        gap,
        tileHeight: fittedHeight,
        tileWidth: fittedWidth,
      };
    }
  }

  const stableColumns = itemCount === 2 ? 2 : best.columns;
  const rows = Math.ceil(itemCount / stableColumns);
  const widthByColumns =
    (width - gap * (stableColumns - 1)) / stableColumns;
  const heightByRows = (height - gap * (rows - 1)) / rows;
  const fittedWidth = Math.max(
    0,
    Math.floor(Math.min(widthByColumns, heightByRows * (16 / 9))),
  );

  return {
    columns: stableColumns,
    gap,
    tileHeight: fittedWidth * (9 / 16),
    tileWidth: fittedWidth,
  };
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
          document.documentElement.clientWidth - horizontalPadding,
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
