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
import { ProfileEditor } from "@/components/profile/ProfileEditor";
import { saveClientProfile } from "@/lib/profiles";
import type { ProfileDraft } from "@/lib/profiles";
import { useI18n } from "@/lib/i18n";
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
  const { tr } = useI18n();
  const [profile, setProfile] = useState<ProfileDraft>({
    avatarDataUrl: initialDetails.avatarDataUrl,
    displayName: initialDetails.displayName,
    profileId: initialDetails.profileId,
  });
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

    if (!profile.displayName.trim() || isBusy) {
      return;
    }

    const savedProfile = saveClientProfile(profile);

    void onJoin({
      avatarDataUrl: savedProfile.avatarDataUrl,
      displayName: savedProfile.displayName,
      password,
      profileId: savedProfile.id,
      startAudioMuted,
      startVideoMuted,
    });
  }

  return (
    <div
      aria-label={tr("Join room", "Вход в комнату")}
      className={styles.overlay}
      role="dialog"
    >
      <div className={styles.ambient} />
      <div className={styles.topBrand}>
        <Brand />
      </div>

      <div className={styles.card}>
        <div className={styles.roomBadge}>
          <span />
          {roomName}
        </div>
        <h1>
          {isBusy
            ? tr("Connecting", "Подключаемся")
            : tr("Ready to join", "Можно входить")}
        </h1>
        <p>
          {isBusy
            ? tr(
                "Requesting devices and preparing the meeting.",
                "Запрашиваем устройства и собираем видеокомнату.",
              )
            : tr(
                "Introduce yourself and check your devices.",
                "Представьтесь и проверьте, с чем хотите войти.",
              )}
        </p>

        {isBusy ? (
          <div className={styles.loading}>
            <LoaderCircle size={27} />
            <span>
              {isDemo
                ? tr("Preparing the demo", "Готовим демонстрацию")
                : tr("Connecting to Jitsi", "Связываемся с Jitsi")}
            </span>
          </div>
        ) : (
          <form onSubmit={submit}>
            <ProfileEditor autoFocus onChange={setProfile} value={profile} />

            <label className={styles.field}>
              <span className={styles.optionalLabel}>
                {tr("Room password", "Пароль комнаты")}
                <em>{tr("if set", "если установлен")}</em>
              </span>
              <div className={styles.passwordField}>
                <LockKeyhole size={16} />
                <input
                  autoComplete="off"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={tr(
                    "You can leave this empty",
                    "Можно оставить пустым",
                  )}
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
                  {tr("Microphone", "Микрофон")}
                  <em>
                    {startAudioMuted
                      ? tr("off", "выключен")
                      : tr("on", "включён")}
                  </em>
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
                  {tr("Camera", "Камера")}
                  <em>
                    {startVideoMuted
                      ? tr("off", "выключена")
                      : tr("on", "включена")}
                  </em>
                </span>
              </button>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <button
              className={styles.joinButton}
              disabled={!profile.displayName.trim()}
              type="submit"
            >
              {tr("Join room", "Войти в комнату")}
              <ArrowRight size={18} />
            </button>
          </form>
        )}

        {isDemo && (
          <div className={styles.demoNote}>
            {tr(
              "Demo mode: no Jitsi server URL is configured.",
              "Демонстрационный режим: адрес Jitsi-сервера пока не задан.",
            )}
          </div>
        )}
      </div>
    </div>
  );
}
