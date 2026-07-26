"use client";

import { useRef } from "react";
import type { ParticipantView } from "@/lib/jitsi/types";
import { useOptimalGrid } from "@/hooks/useOptimalGrid";
import { VideoTile } from "./VideoTile";
import styles from "./VideoGrid.module.css";

interface VideoGridProps {
  participants: ParticipantView[];
}

export function VideoGrid({ participants }: VideoGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { columns, gap, tileHeight, tileWidth } = useOptimalGrid(
    containerRef,
    participants.length,
  );
  const rows = Math.ceil(participants.length / columns);
  const gridWidth = columns * tileWidth + (columns - 1) * gap;
  const gridHeight = rows * tileHeight + (rows - 1) * gap;

  return (
    <div className={styles.viewport} ref={containerRef}>
      <div
        className={styles.grid}
        style={{
          gap,
          height: gridHeight,
          width: gridWidth,
        }}
      >
        {participants.map((participant) => (
          <div
            className={styles.cell}
            key={participant.id}
            style={{ height: tileHeight, width: tileWidth }}
          >
            <VideoTile participant={participant} />
          </div>
        ))}
      </div>
    </div>
  );
}
