"use client";

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  ChevronDown,
  ImageIcon,
  Languages,
  LockKeyhole,
  Mic,
  Settings,
  Speaker,
  Sparkles,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { MeetingStatus, ParticipantView } from "@/lib/jitsi/types";
import { FeedDiagnostics } from "./FeedDiagnostics";
import styles from "./SettingsPanel.module.css";

interface SettingsPanelProps {
  audioInputId: string;
  audioOutputId: string;
  busy: boolean;
  localAudioLevel: number;
  localParticipant?: ParticipantView;
  noiseSuppressionEnabled: boolean;
  noiseSuppressionSupported: boolean;
  onAudioInputChange: (deviceId: string) => Promise<void>;
  onAudioOutputChange: (deviceId: string) => Promise<void>;
  onNoiseSuppressionChange: (enabled: boolean) => Promise<void>;
  onVideoInputChange: (deviceId: string) => Promise<void>;
  onVideoBackgroundChange: (enabled: boolean) => Promise<void>;
  roomPassword: string | null;
  status: MeetingStatus;
  videoBackgroundAvailable: boolean;
  videoBackgroundEnabled: boolean;
  videoInputId: string;
}

function deviceLabel(
  device: MediaDeviceInfo,
  index: number,
  fallback: string,
) {
  return device.label || `${fallback} ${index + 1}`;
}

export function SettingsPanel({
  audioInputId,
  audioOutputId,
  busy,
  localAudioLevel,
  localParticipant,
  noiseSuppressionEnabled,
  noiseSuppressionSupported,
  onAudioInputChange,
  onAudioOutputChange,
  onNoiseSuppressionChange,
  onVideoInputChange,
  onVideoBackgroundChange,
  roomPassword,
  status,
  videoBackgroundAvailable,
  videoBackgroundEnabled,
  videoInputId,
}: SettingsPanelProps) {
  const { locale, setLocale, tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputSupported] = useState(
    () => typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype,
  );
  const [audioOutputPickerSupported] = useState(
    () => typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices) &&
      "selectAudioOutput" in navigator.mediaDevices,
  );
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      const nextDevices = await navigator.mediaDevices
        .enumerateDevices()
        .catch(() => []);

      if (!cancelled) {
        setDevices(nextDevices);
      }
    };

    void refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);

    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !panelRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  const microphones = devices.filter(
    (device) => device.kind === "audioinput",
  );
  const cameras = devices.filter((device) => device.kind === "videoinput");
  const audioOutputs = devices.filter(
    (device) => device.kind === "audiooutput" && device.deviceId !== "default",
  );

  const chooseAudioOutput = async () => {
    const mediaDevices = navigator.mediaDevices as MediaDevices & {
      selectAudioOutput?: () => Promise<MediaDeviceInfo>;
    };

    try {
      const device = await mediaDevices.selectAudioOutput?.();
      if (!device) {
        return;
      }
      await onAudioOutputChange(device.deviceId);
      setDevices(await mediaDevices.enumerateDevices().catch(() => devices));
    } catch {
      // Closing the browser's output picker keeps the current device.
    }
  };

  return (
    <div className={styles.root} ref={panelRef}>
      {open && (
        <section
          aria-label={tr("Device settings", "Настройки устройств")}
          className={styles.panel}
          role="dialog"
        >
          <header>
            <div>
              <span>{tr("Settings", "Настройки")}</span>
              <small>{tr("Meeting devices", "Устройства этой встречи")}</small>
            </div>
            <button
              aria-label={tr("Close settings", "Закрыть настройки")}
              onClick={() => setOpen(false)}
              type="button"
            >
              <X size={16} />
            </button>
          </header>

          <label className={styles.selectField}>
            <span>
              <Mic size={14} />
              {tr("Microphone", "Микрофон")}
            </span>
            <div>
              <select
                aria-label={tr("Select microphone", "Выбрать микрофон")}
                disabled={busy || microphones.length === 0}
                onChange={(event) =>
                  void onAudioInputChange(event.target.value)
                }
                value={audioInputId}
              >
                <option value="">
                  {tr("System default", "Системный по умолчанию")}
                </option>
                {microphones.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {deviceLabel(
                      device,
                      index,
                      tr("Microphone", "Микрофон"),
                    )}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </div>
          </label>

          <label className={styles.selectField}>
            <span>
              <Camera size={14} />
              {tr("Camera", "Камера")}
            </span>
            <div>
              <select
                aria-label={tr("Select camera", "Выбрать камеру")}
                disabled={busy || cameras.length === 0}
                onChange={(event) =>
                  void onVideoInputChange(event.target.value)
                }
                value={videoInputId}
              >
                <option value="">
                  {tr("System default", "Системная по умолчанию")}
                </option>
                {cameras.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {deviceLabel(
                      device,
                      index,
                      tr("Camera", "Камера"),
                    )}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </div>
          </label>

          <label className={styles.selectField}>
            <span>
              <Speaker size={14} />
              {tr("Audio output", "Вывод звука")}
            </span>
            <div>
              <select
                aria-label={tr("Select audio output", "Выбрать вывод звука")}
                disabled={busy || !audioOutputSupported}
                onChange={(event) =>
                  void onAudioOutputChange(event.target.value)
                }
                value={audioOutputId}
              >
                <option value="">
                  {tr("System default", "Системный по умолчанию")}
                </option>
                {audioOutputId && !audioOutputs.some(
                  (device) => device.deviceId === audioOutputId,
                ) && (
                  <option value={audioOutputId}>
                    {tr("Device unavailable", "Устройство недоступно")}
                  </option>
                )}
                {audioOutputs.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {deviceLabel(
                      device,
                      index,
                      tr("Speaker", "Динамик"),
                    )}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </div>
            {!audioOutputSupported && (
              <small>{tr(
                "Not supported by this browser",
                "Не поддерживается браузером",
              )}</small>
            )}
            {audioOutputSupported && audioOutputPickerSupported && (
              <button
                className={styles.outputPicker}
                disabled={busy}
                onClick={() => void chooseAudioOutput()}
                type="button"
              >
                {tr("Choose another output…", "Выбрать другой выход…")}
              </button>
            )}
          </label>

          <div className={styles.toggleRow}>
            <span className={styles.toggleIcon}>
              <Sparkles size={15} />
            </span>
            <div>
              <strong>{tr("Noise suppression", "Шумоподавление")}</strong>
              <small>
                {noiseSuppressionSupported
                  ? tr("RNNoise from Jitsi Meet", "RNNoise из Jitsi Meet")
                  : tr(
                      "Not supported by this browser",
                      "Не поддерживается браузером",
                    )}
              </small>
            </div>
            <button
              aria-checked={noiseSuppressionEnabled}
              aria-label={tr("Noise suppression", "Шумоподавление")}
              className={noiseSuppressionEnabled ? styles.toggleOn : ""}
              disabled={busy || !noiseSuppressionSupported}
              onClick={() =>
                void onNoiseSuppressionChange(!noiseSuppressionEnabled)
              }
              role="switch"
              type="button"
            >
              <i>{noiseSuppressionEnabled && <Check size={11} />}</i>
            </button>
          </div>

          {videoBackgroundAvailable && (
            <div className={styles.toggleRow}>
              <span className={styles.toggleIcon}>
                <ImageIcon size={15} />
              </span>
              <div>
                <strong>
                  {tr("Profile background", "Фон профиля")}
                </strong>
                <small>
                  {tr(
                    "Shown while your camera is off",
                    "Показывается, пока камера выключена",
                  )}
                </small>
              </div>
              <button
                aria-checked={videoBackgroundEnabled}
                aria-label={tr("Profile background", "Фон профиля")}
                className={videoBackgroundEnabled ? styles.toggleOn : ""}
                disabled={busy}
                onClick={() =>
                  void onVideoBackgroundChange(!videoBackgroundEnabled)
                }
                role="switch"
                type="button"
              >
                <i>{videoBackgroundEnabled && <Check size={11} />}</i>
              </button>
            </div>
          )}

          <div className={styles.languageRow}>
            <span className={styles.toggleIcon}>
              <Languages size={15} />
            </span>
            <div>
              <strong>{tr("Language", "Язык")}</strong>
              <small>{tr("Meeting interface", "Интерфейс встречи")}</small>
            </div>
            <div
              aria-label={tr("Language", "Язык")}
              className={styles.languageButtons}
            >
              <button
                aria-label="Русский"
                aria-pressed={locale === "ru"}
                className={locale === "ru" ? styles.languageSelected : ""}
                onClick={() => setLocale("ru")}
                type="button"
              >
                RU
              </button>
              <button
                aria-label="English"
                aria-pressed={locale === "en"}
                className={locale === "en" ? styles.languageSelected : ""}
                onClick={() => setLocale("en")}
                type="button"
              >
                EN
              </button>
            </div>
          </div>

          {roomPassword !== null && (
            <label className={styles.creatorPassword}>
              <span>
                <LockKeyhole size={14} />
                {tr("Room password", "Пароль комнаты")}
              </span>
              <div>
                <button
                  aria-label={tr(
                    "Hold to show password",
                    "Удерживайте, чтобы показать пароль",
                  )}
                  disabled={!roomPassword}
                  onBlur={() => setPasswordVisible(false)}
                  onPointerCancel={() => setPasswordVisible(false)}
                  onPointerDown={() => setPasswordVisible(true)}
                  onPointerLeave={() => setPasswordVisible(false)}
                  onPointerUp={() => setPasswordVisible(false)}
                  type="button"
                >
                  <LockKeyhole size={15} />
                </button>
                <input
                  aria-label={tr("Creator room password", "Пароль комнаты создателя")}
                  placeholder={tr("No password", "Без пароля")}
                  readOnly
                  type={passwordVisible ? "text" : "password"}
                  value={roomPassword}
                />
              </div>
            </label>
          )}

          <FeedDiagnostics
            audioLevel={localAudioLevel}
            localParticipant={localParticipant}
            status={status}
          />
        </section>
      )}

      <button
        aria-expanded={open}
        aria-label={tr("Settings", "Настройки")}
        className={styles.trigger}
        onClick={() => setOpen((current) => !current)}
        title={tr("Settings", "Настройки")}
        type="button"
      >
        <Settings size={20} />
      </button>
    </div>
  );
}
