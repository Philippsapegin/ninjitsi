"use client";

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  ChevronDown,
  Languages,
  LockKeyhole,
  Mic,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import styles from "./SettingsPanel.module.css";

interface SettingsPanelProps {
  audioInputId: string;
  busy: boolean;
  noiseSuppressionEnabled: boolean;
  noiseSuppressionSupported: boolean;
  onAudioInputChange: (deviceId: string) => Promise<void>;
  onNoiseSuppressionChange: (enabled: boolean) => Promise<void>;
  onVideoInputChange: (deviceId: string) => Promise<void>;
  roomPassword: string | null;
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
  busy,
  noiseSuppressionEnabled,
  noiseSuppressionSupported,
  onAudioInputChange,
  onNoiseSuppressionChange,
  onVideoInputChange,
  roomPassword,
  videoInputId,
}: SettingsPanelProps) {
  const { locale, setLocale, tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
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
