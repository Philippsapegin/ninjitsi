"use client";

import { FormEvent, useState } from "react";
import {
  ArrowRight,
  Camera,
  CameraOff,
  LoaderCircle,
  LockKeyhole,
  Mic,
  MicOff,
} from "lucide-react";
import type { JoinOptions } from "@/lib/jitsi/useJitsiConference";
import type { MeetingStatus } from "@/lib/jitsi/types";
import { Brand } from "@/components/brand/Brand";
import styles from "./JoinOverlay.module.css";

interface JoinOverlayProps {
  error: string | null;
  initialDetails: JoinOptions;
  isDemo: boolean;
  onJoin: (details: JoinOptions) => Promise<void>;
  roomName: string;
  status: MeetingStatus;
}

export function JoinOverlay({
  error,
  initialDetails,
  isDemo,
  onJoin,
  roomName,
  status,
}: JoinOverlayProps) {
  const [displayName, setDisplayName] = useState(initialDetails.displayName);
  const [password, setPassword] = useState(initialDetails.password);
  const [startAudioMuted, setStartAudioMuted] = useState(
    initialDetails.startAudioMuted,
  );
  const [startVideoMuted, setStartVideoMuted] = useState(
    initialDetails.startVideoMuted,
  );
  const isBusy = status === "loading" || status === "connecting";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!displayName.trim() || isBusy) {
      return;
    }

    void onJoin({
      displayName: displayName.trim(),
      password,
      startAudioMuted,
      startVideoMuted,
    });
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.ambient} />
      <div className={styles.topBrand}>
        <Brand />
      </div>

      <div className={styles.card}>
        <div className={styles.roomBadge}>
          <span />
          {roomName}
        </div>
        <h1>{isBusy ? "Подключаемся" : "Можно входить"}</h1>
        <p>
          {isBusy
            ? "Запрашиваем устройства и собираем видеокомнату."
            : "Представьтесь и проверьте, с чем хотите войти."}
        </p>

        {isBusy ? (
          <div className={styles.loading}>
            <LoaderCircle size={27} />
            <span>
              {isDemo ? "Готовим демонстрацию" : "Связываемся с Jitsi"}
            </span>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label className={styles.field}>
              <span>Ваше имя</span>
              <input
                autoFocus
                autoComplete="name"
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Например, Алексей"
                value={displayName}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.optionalLabel}>
                Пароль комнаты
                <em>если установлен</em>
              </span>
              <div className={styles.passwordField}>
                <LockKeyhole size={16} />
                <input
                  autoComplete="off"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Можно оставить пустым"
                  type="password"
                  value={password}
                />
              </div>
            </label>

            <div className={styles.deviceChoice}>
              <button
                className={startAudioMuted ? styles.deviceOff : ""}
                onClick={() => setStartAudioMuted((muted) => !muted)}
                type="button"
              >
                {startAudioMuted ? <MicOff size={18} /> : <Mic size={18} />}
                <span>
                  Микрофон
                  <em>{startAudioMuted ? "выключен" : "включён"}</em>
                </span>
              </button>
              <button
                className={startVideoMuted ? styles.deviceOff : ""}
                onClick={() => setStartVideoMuted((muted) => !muted)}
                type="button"
              >
                {startVideoMuted ? (
                  <CameraOff size={18} />
                ) : (
                  <Camera size={18} />
                )}
                <span>
                  Камера
                  <em>{startVideoMuted ? "выключена" : "включена"}</em>
                </span>
              </button>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <button
              className={styles.joinButton}
              disabled={!displayName.trim()}
              type="submit"
            >
              Войти в комнату
              <ArrowRight size={18} />
            </button>
          </form>
        )}

        {isDemo && (
          <div className={styles.demoNote}>
            Демонстрационный режим: адрес Jitsi-сервера пока не задан.
          </div>
        )}
      </div>
    </div>
  );
}
