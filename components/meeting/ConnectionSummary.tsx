import { LockKeyhole, Users } from "lucide-react";
import type { ParticipantConnectionInfo } from "@/lib/jitsi/types";
import { useI18n } from "@/lib/i18n";
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
  const { tr } = useI18n();
  const level = qualityLevel(quality);

  return (
    <span
      aria-label={
        quality === null
          ? tr("Connection strength unknown", "Сила соединения неизвестна")
          : `${tr("Connection", "Соединение")} ${quality}%`
      }
      className={styles.strength}
      title={
        quality === null ? tr("No data", "Нет данных") : `${quality}%`
      }
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
  const { tr } = useI18n();

  return (
    <div
      aria-label={tr("Connection statistics", "Статистика соединения")}
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
          <span>{tr("password protected", "с паролем")}</span>
        </>
      )}

      <section className={styles.popover}>
        <header>
          <strong>{tr("Connection", "Соединение")}</strong>
          <span>
            {tr(
              "Ping updates during the meeting",
              "Пинг обновляется во время встречи",
            )}
          </span>
        </header>
        <div className={styles.table}>
          {participants.map((participant) => (
            <div className={styles.row} key={participant.id}>
              <span title={participant.displayName}>
                {participant.displayName}
              </span>
              <ConnectionStrength quality={participant.quality} />
              <strong data-participant-ping={participant.id}>
                {participant.pingMs === null
                  ? "—"
                  : `${participant.pingMs} ${tr("ms", "мс")}`}
              </strong>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
