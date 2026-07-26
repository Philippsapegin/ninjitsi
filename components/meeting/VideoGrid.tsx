"use client";

import { useRef } from "react";
import type { ParticipantView } from "@/lib/jitsi/types";
import { useOptimalGrid } from "@/hooks/useOptimalGrid";
import { VideoTile } from "./VideoTile";
import styles from "./VideoGrid.module.css";

interface VideoGridProps {
  focusedParticipantId: string | null;
  onParticipantClick: (participantId: string | null) => void;
  onParticipantVolumeChange: (
    participantId: string,
    volume: number,
  ) => void;
  participantVolumes: Record<string, number>;
  participants: ParticipantView[];
}

export function VideoGrid({
  focusedParticipantId,
  onParticipantClick,
  onParticipantVolumeChange,
  participantVolumes,
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
          <div className={styles.sceneMain}>
            <VideoTile
              activationLabel={`Вернуть сетку из сцены ${focusedParticipant.displayName}`}
              onActivate={() => onParticipantClick(null)}
              onVolumeChange={(volume) =>
                onParticipantVolumeChange(
                  focusedParticipant.id,
                  volume,
                )
              }
              participant={focusedParticipant}
              volume={participantVolumes[focusedParticipant.id] ?? 1}
            />
          </div>

          {otherParticipants.length > 0 && (
            <div
              className={styles.sceneStrip}
              style={{
                gridTemplateColumns: `repeat(${otherParticipants.length}, minmax(0, 1fr))`,
                maxWidth: `${otherParticipants.length * 220 + (otherParticipants.length - 1) * 9}px`,
              }}
            >
              {otherParticipants.map((participant) => (
                <div
                  className={styles.sceneCell}
                  key={participant.id}
                >
                  <VideoTile
                    activationLabel={`Показать на сцене ${participant.displayName}`}
                    onActivate={() => onParticipantClick(participant.id)}
                    onVolumeChange={(volume) =>
                      onParticipantVolumeChange(participant.id, volume)
                    }
                    participant={participant}
                    volume={participantVolumes[participant.id] ?? 1}
                  />
                </div>
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
          <div
            className={styles.cell}
            key={participant.id}
            style={{ height: tileHeight, width: tileWidth }}
          >
            <VideoTile
              activationLabel={`Показать на сцене ${participant.displayName}`}
              onActivate={() => onParticipantClick(participant.id)}
              onVolumeChange={(volume) =>
                onParticipantVolumeChange(participant.id, volume)
              }
              participant={participant}
              volume={participantVolumes[participant.id] ?? 1}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
