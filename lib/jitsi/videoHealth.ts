export interface VideoHealthSample {
  now: number;
  frames: number;
  height: number;
  active: boolean;
  screen: boolean;
}

// Monotonic time, bounded retries, no call-duration timer and no recordings.
export function createVideoHealthMonitor() {
  let frames = -1;
  let progressAt = 0;
  let recoveredAt = -Infinity;
  let bestHeight = 0;
  let lowSince: number | null = null;
  let reattached = false;
  return (sample: VideoHealthSample): "reattach" | "resubscribe" | undefined => {
    if (!sample.active || sample.screen || frames < 0 || sample.frames > frames) {
      if (!sample.active || sample.screen || frames < 0) {
        bestHeight = 0;
        lowSince = null;
      }
      frames = sample.frames;
      progressAt = sample.now;
      reattached = false;
      if (!sample.active || sample.screen) return;
    }
    frames = sample.frames;
    bestHeight = Math.max(bestHeight, sample.height);
    if (bestHeight >= 360 && sample.height > 0 && sample.height <= bestHeight / 2) {
      lowSince ??= sample.now;
    } else {
      lowSince = null;
    }
    if (sample.now - recoveredAt < 60_000) return;
    if (lowSince !== null && sample.now - lowSince >= 60_000) {
      recoveredAt = sample.now;
      lowSince = sample.now;
      return "resubscribe";
    }
    if (sample.now - progressAt >= 12_000) {
      progressAt = sample.now;
      if (!reattached) {
        reattached = true;
        return "reattach";
      }
      recoveredAt = sample.now;
      return "resubscribe";
    }
  };
}
