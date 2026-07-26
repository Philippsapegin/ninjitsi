"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Check, ChevronDown, Mic, Settings, Sparkles, X } from "lucide-react";
import styles from "./SettingsPanel.module.css";

interface SettingsPanelProps {
  audioInputId: string;
  busy: boolean;
  noiseSuppressionEnabled: boolean;
  noiseSuppressionSupported: boolean;
  onAudioInputChange: (deviceId: string) => Promise<void>;
  onNoiseSuppressionChange: (enabled: boolean) => Promise<void>;
  onVideoInputChange: (deviceId: string) => Promise<void>;
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
  videoInputId,
}: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
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
          aria-label="Настройки устройств"
          className={styles.panel}
          role="dialog"
        >
          <header>
            <div>
              <span>Настройки</span>
              <small>Устройства этой встречи</small>
            </div>
            <button
              aria-label="Закрыть настройки"
              onClick={() => setOpen(false)}
              type="button"
            >
              <X size={16} />
            </button>
          </header>

          <label className={styles.selectField}>
            <span>
              <Mic size={14} />
              Микрофон
            </span>
            <div>
              <select
                aria-label="Выбрать микрофон"
                disabled={busy || microphones.length === 0}
                onChange={(event) =>
                  void onAudioInputChange(event.target.value)
                }
                value={audioInputId}
              >
                <option value="">Системный по умолчанию</option>
                {microphones.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {deviceLabel(device, index, "Микрофон")}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </div>
          </label>

          <label className={styles.selectField}>
            <span>
              <Camera size={14} />
              Камера
            </span>
            <div>
              <select
                aria-label="Выбрать камеру"
                disabled={busy || cameras.length === 0}
                onChange={(event) =>
                  void onVideoInputChange(event.target.value)
                }
                value={videoInputId}
              >
                <option value="">Системная по умолчанию</option>
                {cameras.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {deviceLabel(device, index, "Камера")}
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
              <strong>Шумоподавление</strong>
              <small>
                {noiseSuppressionSupported
                  ? "RNNoise из Jitsi Meet"
                  : "Не поддерживается браузером"}
              </small>
            </div>
            <button
              aria-checked={noiseSuppressionEnabled}
              aria-label="Шумоподавление"
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
        </section>
      )}

      <button
        aria-expanded={open}
        aria-label="Настройки"
        className={styles.trigger}
        onClick={() => setOpen((current) => !current)}
        title="Настройки"
        type="button"
      >
        <Settings size={20} />
      </button>
    </div>
  );
}
