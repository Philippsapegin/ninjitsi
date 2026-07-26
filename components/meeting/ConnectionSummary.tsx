import { LockKeyhole, Users } from "lucide-react";
import type { ParticipantConnectionInfo } from "@/lib/jitsi/types";
import styles from "./ConnectionSummary.module.css";

interface ConnectionSummaryProps {
  participantLabel: string;
  participants: ParticipantConnectionInfo[];
  protectedRoom: boolean;
  timer: string;
}

function qualityLevel(quality: number | null) {
  if (quality === null) {
    return 0;
  }

  return Math.max(1, Math.min(4, Math.ceil(quality / 25)));
}

function ConnectionStrength({ quality }: { quality: number | null }) {
  const level = qualityLevel(quality);

  return (
    <span
      aria-label={
        quality === null ? "Сила соединения неизвестна" : `Соединение ${quality}%`
      }
      className={styles.strength}
      title={quality === null ? "Нет данных" : `${quality}%`}
    >
      {[1, 2, 3, 4].map((bar) => (
        <i className={bar <= level ? styles.filled : ""} key={bar} />
      ))}
    </span>
  );
}

export function ConnectionSummary({
  participantLabel,
  participants,
  protectedRoom,
  timer,
}: ConnectionSummaryProps) {
  return (
    <div
      aria-label="Статистика соединения"
      className={styles.root}
      data-connection-summary
      tabIndex={0}
    >
      <span className={styles.liveDot} />
      <strong>{timer}</strong>
      <span className={styles.divider} />
      <Users size={14} />
      <span>{participantLabel}</span>
      {protectedRoom && (
        <>
          <span className={styles.divider} />
          <LockKeyhole size={13} />
          <span>с паролем</span>
        </>
      )}

      <section className={styles.popover}>
        <header>
          <strong>Соединение</strong>
          <span>Пинг обновляется во время встречи</span>
        </header>
        <div className={styles.table}>
          {participants.map((participant) => (
            <div className={styles.row} key={participant.id}>
              <span title={participant.displayName}>
                {participant.isLocal ? "Вы" : participant.displayName}
              </span>
              <ConnectionStrength quality={participant.quality} />
              <strong data-participant-ping={participant.id}>
                {participant.pingMs === null
                  ? "—"
                  : `${participant.pingMs} мс`}
              </strong>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
