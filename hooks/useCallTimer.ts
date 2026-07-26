"use client";

import { useEffect, useState } from "react";

export function useCallTimer(active: boolean) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) {
      return;
    }

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [active]);

  const visibleSeconds = active ? seconds : 0;
  const hours = Math.floor(visibleSeconds / 3600);
  const minutes = Math.floor((visibleSeconds % 3600) / 60);
  const rest = visibleSeconds % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}
