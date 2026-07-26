"use client";

import { useRef } from "react";
import type { ParticipantView } from "@/lib/jitsi/types";
import { useOptimalGrid } from "@/hooks/useOptimalGrid";
import { VideoTile } from "./VideoTile";
import styles from "./VideoGrid.module.css";

interface VideoGridProps {
  focusedParticipantId: string | null;
  onParticipantClick: (participantId: string | null) => void;
  participants: ParticipantView[];
}

export function VideoGrid({
  focusedParticipantId,
  onParticipantClick,
  participants,
}: VideoGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { columns, gap, tileHeight, tileWidth } = useOptimalGrid(
    containerRef,
    participants.length,
  );
  const rows = Math.ceil(participants.length / columns);
  const gridWidth = columns * tileWidth + (columns - 1) * gap;
  const gridHeight = rows * tileHeight + (rows - 1) * gap;
  const focusedParticipant = participants.find(
    (participant) => participant.id === focusedParticipantId,
  );

  if (focusedParticipant) {
    const otherParticipants = participants.filter(
      (participant) => participant.id !== focusedParticipant.id,
    );

    return (
      <div className={`${styles.viewport} ${styles.sceneViewport}`}>
        <div className={styles.scene}>
          <button
            aria-label={`Вернуть сетку из сцены ${focusedParticipant.displayName}`}
            className={styles.sceneMain}
            onClick={() => onParticipantClick(null)}
            type="button"
          >
            <VideoTile participant={focusedParticipant} />
          </button>

          {otherParticipants.length > 0 && (
            <div
              className={styles.sceneStrip}
              style={{
                gridTemplateColumns: `repeat(${otherParticipants.length}, minmax(0, 1fr))`,
                maxWidth: `${otherParticipants.length * 220 + (otherParticipants.length - 1) * 9}px`,
              }}
            >
              {otherParticipants.map((participant) => (
                <button
                  aria-label={`Показать на сцене ${participant.displayName}`}
                  className={styles.sceneCell}
                  key={participant.id}
                  onClick={() => onParticipantClick(participant.id)}
                  type="button"
                >
                  <VideoTile participant={participant} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

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
          <button
            aria-label={`Показать на сцене ${participant.displayName}`}
            className={styles.cell}
            key={participant.id}
            onClick={() => onParticipantClick(participant.id)}
            style={{ height: tileHeight, width: tileWidth }}
            type="button"
          >
            <VideoTile participant={participant} />
          </button>
        ))}
      </div>
    </div>
  );
}
