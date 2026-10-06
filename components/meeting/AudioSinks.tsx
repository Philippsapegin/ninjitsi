"use client";

import { useCallback, useState } from "react";
import { Volume2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { ParticipantView } from "@/lib/jitsi/types";
import { AudioTrack } from "./MediaTrack";
import styles from "./AudioSinks.module.css";

interface AudioSinksProps {
  outputDeviceId: string;
  participantVolumes: Record<string, number>;
  participants: ParticipantView[];
}

export function AudioSinks({
  outputDeviceId,
  participantVolumes,
  participants,
}: AudioSinksProps) {
  const { tr } = useI18n();
  const [blockedTracks, setBlockedTracks] = useState<Set<string>>(() => new Set());
  const reportBlocked = useCallback((key: string, blocked: boolean) => {
    setBlockedTracks((current) => {
      if (current.has(key) === blocked) {
        return current;
      }
      const next = new Set(current);
      if (blocked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const remoteTracks = participants
    .filter((participant) => !participant.isLocal)
    .flatMap((participant) => (
      participant.audioTracks ?? (participant.audioTrack ? [participant.audioTrack] : [])
    ).map((track, index) => ({
      key: `${participant.id}-${track.getId?.() ?? track.getTrack?.()?.id ?? index}`,
      participant,
      track,
    })));

  return (
    <>
      <div aria-hidden="true">
        {remoteTracks.map(({ key, participant, track }) => (
          <AudioTrack
            key={key}
            onPlaybackBlocked={(blocked) => reportBlocked(key, blocked)}
            outputDeviceId={outputDeviceId}
            participantId={participant.id}
            track={track}
            volume={participantVolumes[participant.id] ?? 1}
          />
        ))}
      </div>
      {blockedTracks.size > 0 && (
        <button
          className={styles.retry}
          onClick={() => document.dispatchEvent(new Event("ninjitsi:retry-audio"))}
          type="button"
        >
          <Volume2 size={18} />
          {tr("Enable meeting audio", "Включить звук встречи")}
        </button>
      )}
    </>
  );
}
