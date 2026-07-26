import { MicOff, MonitorUp, ShieldCheck } from "lucide-react";
import type { ParticipantView } from "@/lib/jitsi/types";
import { VideoTrack } from "./MediaTrack";
import styles from "./VideoTile.module.css";

interface VideoTileProps {
  participant: ParticipantView;
}

const gradients = [
  ["#485d78", "#1f2835"],
  ["#6b576f", "#2e2533"],
  ["#6d614b", "#30291f"],
  ["#466b5f", "#1f302b"],
  ["#735153", "#312225"],
  ["#52606b", "#232a31"],
];

function participantGradient(id: string) {
  const hash = [...id].reduce((total, character) => {
    return (total * 31 + character.charCodeAt(0)) | 0;
  }, 0);
  const [start, end] = gradients[Math.abs(hash) % gradients.length];

  return `radial-gradient(circle at 50% 34%, ${start}, ${end} 78%)`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");
}

export function VideoTile({ participant }: VideoTileProps) {
  const hasVisibleVideo =
    participant.videoTrack && !participant.videoMuted;

  return (
    <article
      className={styles.tile}
      data-video-tile
      style={{ background: participantGradient(participant.id) }}
    >
      {hasVisibleVideo ? (
        <div
          className={`${styles.video} ${
            participant.isScreenSharing ? styles.screenVideo : ""
          } ${participant.isLocal ? styles.localVideo : ""}`}
        >
          <VideoTrack
            isLocal={participant.isLocal}
            track={participant.videoTrack!}
          />
        </div>
      ) : (
        <div className={styles.avatar} aria-hidden="true">
          {participant.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img alt="" src={participant.avatarUrl} />
          ) : (
            initials(participant.displayName)
          )}
        </div>
      )}

      <div className={styles.scrim} />

      <div className={styles.identity}>
        <span className={styles.name}>
          {participant.displayName}
          {participant.isLocal && <em>вы</em>}
        </span>
        {participant.isModerator && (
          <ShieldCheck
            aria-label="Модератор"
            className={styles.moderator}
            size={14}
          />
        )}
      </div>

      <div className={styles.badges}>
        {participant.isScreenSharing && (
          <span className={styles.screenBadge}>
            <MonitorUp size={13} />
            экран
          </span>
        )}
        {participant.audioMuted && (
          <span className={styles.mutedBadge} title="Микрофон выключен">
            <MicOff size={14} />
          </span>
        )}
      </div>
    </article>
  );
}
