import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  MicOff,
  MonitorUp,
  ShieldCheck,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { ParticipantView } from "@/lib/jitsi/types";
import { useI18n } from "@/lib/i18n";
import { VideoTrack } from "./MediaTrack";
import styles from "./VideoTile.module.css";

interface VideoTileProps {
  activationLabel: string;
  onActivate: () => void;
  onVolumeChange: (volume: number) => void;
  participant: ParticipantView;
  volume: number;
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

export function VideoTile({
  activationLabel,
  onActivate,
  onVolumeChange,
  participant,
  volume,
}: VideoTileProps) {
  const { tr } = useI18n();
  const [volumeOpen, setVolumeOpen] = useState(false);
  const volumeControlRef = useRef<HTMLDivElement>(null);
  const hasVisibleVideo =
    participant.videoTrack && !participant.videoMuted;
  const volumePercent = Math.round(volume * 100);

  useEffect(() => {
    if (!volumeOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !volumeControlRef.current?.contains(event.target)
      ) {
        setVolumeOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () =>
      document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [volumeOpen]);

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

      <button
        aria-label={activationLabel}
        className={styles.activationSurface}
        onClick={onActivate}
        type="button"
      />

      <div className={styles.identity} ref={volumeControlRef}>
        {participant.isLocal ? (
          <span className={styles.name}>{participant.displayName}</span>
        ) : (
          <button
            aria-expanded={volumeOpen}
            aria-label={`${tr("Volume for", "Громкость участника")} ${participant.displayName}: ${volumePercent}%`}
            className={styles.nameButton}
            onClick={() => setVolumeOpen((current) => !current)}
            type="button"
          >
            {participant.displayName}
          </button>
        )}
        {participant.isModerator && (
          <ShieldCheck
            aria-label={tr("Moderator", "Модератор")}
            className={styles.moderator}
            size={14}
          />
        )}

        {!participant.isLocal && volumeOpen && (
          <section
            aria-label={`${tr("Volume", "Громкость")} ${participant.displayName}`}
            className={styles.volumeControl}
          >
            <header>
              <span>{tr("Volume", "Громкость")}</span>
              <strong>{volumePercent}%</strong>
            </header>
            <div>
              {volumePercent === 0 ? (
                <VolumeX size={14} />
              ) : (
                <Volume2 size={14} />
              )}
              <input
                aria-label={`${tr("Volume", "Громкость")} ${participant.displayName}`}
                data-participant-volume={participant.id}
                max="200"
                min="0"
                onChange={(event) =>
                  onVolumeChange(Number(event.target.value) / 100)
                }
                step="1"
                style={
                  {
                    "--volume-progress": `${volumePercent / 2}%`,
                  } as CSSProperties
                }
                type="range"
                value={volumePercent}
              />
            </div>
            <button onClick={() => onVolumeChange(1)} type="button">
              {tr("Reset to 100%", "Сбросить на 100%")}
            </button>
          </section>
        )}
      </div>

      <div className={styles.badges}>
        {participant.isScreenSharing && (
          <span className={styles.screenBadge}>
            <MonitorUp size={13} />
            {tr("screen", "экран")}
          </span>
        )}
        {participant.audioMuted && (
          <span
            className={styles.mutedBadge}
            title={tr("Microphone is off", "Микрофон выключен")}
          >
            <MicOff size={14} />
          </span>
        )}
      </div>
    </article>
  );
}
