"use client";

import { useEffect, useState, type ReactNode } from "react";
import { WifiOff } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import styles from "./MeetingRoom.module.css";

const TOAST_DURATION_MS = 6_000;

function Toast({ message, reconnecting = false, icon }: {
  message: string;
  reconnecting?: boolean;
  icon?: ReactNode;
}) {
  const { tr } = useI18n();
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!visible) return;
    const timeout = window.setTimeout(() => setVisible(false), TOAST_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [visible]);

  if (!visible) return null;
  return (
    <div role={reconnecting ? "status" : "alert"}>
      <button
        aria-label={`${message} ${tr("Dismiss notification", "Закрыть уведомление")}`}
        className={reconnecting ? styles.reconnecting : styles.toast}
        onClick={() => setVisible(false)}
        type="button"
      >
        {icon}
        {message}
      </button>
    </div>
  );
}

export function MeetingToasts({ conferenceError, widgetError, botUnavailable, reconnecting }: {
  conferenceError?: string | null;
  widgetError?: string;
  botUnavailable?: boolean;
  reconnecting?: boolean;
}) {
  const { tr } = useI18n();
  return (
    <div className={styles.toastStack}>
      {conferenceError && <Toast key={`conference:${conferenceError}`} message={conferenceError} />}
      {widgetError && <Toast key={`widget:${widgetError}`} message={widgetError} />}
      {botUnavailable && (
        <Toast message={tr(
          "Bot connection unavailable. The meeting chat is still working. Rejoin if this persists.",
          "Нет связи с API ботов. Чат встречи работает. Если ошибка не исчезает, перезайдите.",
        )} />
      )}
      {reconnecting && (
        <Toast reconnecting icon={<WifiOff aria-hidden size={15} />} message={tr(
          "Connection interrupted. Reconnecting…",
          "Связь прервалась. Восстанавливаем…",
        )} />
      )}
    </div>
  );
}
