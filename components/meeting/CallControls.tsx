import {
  Camera,
  CameraOff,
  LoaderCircle,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
} from "lucide-react";
import type { CSSProperties } from "react";
import styles from "./CallControls.module.css";

interface CallControlsProps {
  isAudioBusy: boolean;
  isAudioMuted: boolean;
  localAudioLevel: number;
  isScreenShareBusy: boolean;
  isScreenSharing: boolean;
  isVideoBusy: boolean;
  isVideoMuted: boolean;
  onHangup: () => void;
  onToggleAudio: () => void;
  onToggleScreenShare: () => void;
  onToggleVideo: () => void;
}

interface ControlButtonProps {
  active?: boolean;
  audioLevel?: number;
  disabled?: boolean;
  danger?: boolean;
  label: string;
  onClick: () => void;
  toggledOff?: boolean;
  children: React.ReactNode;
}

function ControlButton({
  active = false,
  audioLevel,
  children,
  danger = false,
  disabled = false,
  label,
  onClick,
  toggledOff = false,
}: ControlButtonProps) {
  return (
    <button
      aria-label={label}
      className={`${styles.control} ${active ? styles.active : ""} ${
        danger ? styles.danger : ""
      } ${toggledOff ? styles.off : ""} ${
        audioLevel !== undefined ? styles.audioReactive : ""
      }`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      type="button"
      style={
        audioLevel === undefined
          ? undefined
          : ({
              "--audio-level": Math.max(0, Math.min(1, audioLevel)),
            } as CSSProperties)
      }
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

export function CallControls({
  isAudioBusy,
  isAudioMuted,
  localAudioLevel,
  isScreenShareBusy,
  isScreenSharing,
  isVideoBusy,
  isVideoMuted,
  onHangup,
  onToggleAudio,
  onToggleScreenShare,
  onToggleVideo,
}: CallControlsProps) {
  return (
    <footer className={styles.bar}>
      <div className={styles.dock}>
        <ControlButton
          audioLevel={isAudioMuted ? 0 : localAudioLevel}
          disabled={isAudioBusy}
          label={
            isAudioBusy
              ? "Подключаем микрофон"
              : isAudioMuted
                ? "Включить микрофон"
                : "Выключить микрофон"
          }
          onClick={onToggleAudio}
          toggledOff={isAudioMuted}
        >
          {isAudioBusy ? (
            <LoaderCircle className={styles.spinner} size={20} />
          ) : isAudioMuted ? (
            <MicOff size={20} />
          ) : (
            <Mic size={20} />
          )}
        </ControlButton>
        <ControlButton
          disabled={isVideoBusy}
          label={
            isVideoBusy
              ? "Подключаем камеру"
              : isVideoMuted
                ? "Включить камеру"
                : "Выключить камеру"
          }
          onClick={onToggleVideo}
          toggledOff={isVideoMuted}
        >
          {isVideoBusy ? (
            <LoaderCircle className={styles.spinner} size={20} />
          ) : isVideoMuted ? (
            <CameraOff size={20} />
          ) : (
            <Camera size={20} />
          )}
        </ControlButton>
        <ControlButton
          active={isScreenSharing}
          disabled={isScreenShareBusy}
          label={
            isScreenShareBusy
              ? "Готовим показ экрана"
              : isScreenSharing
                ? "Остановить показ"
                : "Показать экран"
          }
          onClick={onToggleScreenShare}
        >
          {isScreenShareBusy ? (
            <LoaderCircle className={styles.spinner} size={20} />
          ) : (
            <MonitorUp size={20} />
          )}
        </ControlButton>
        <span className={styles.divider} />
        <ControlButton danger label="Завершить звонок" onClick={onHangup}>
          <PhoneOff size={21} />
        </ControlButton>
      </div>
    </footer>
  );
}
