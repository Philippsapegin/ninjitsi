import {
  Camera,
  CameraOff,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
} from "lucide-react";
import styles from "./CallControls.module.css";

interface CallControlsProps {
  isAudioMuted: boolean;
  isScreenSharing: boolean;
  isVideoMuted: boolean;
  onHangup: () => void;
  onToggleAudio: () => void;
  onToggleScreenShare: () => void;
  onToggleVideo: () => void;
}

interface ControlButtonProps {
  active?: boolean;
  danger?: boolean;
  label: string;
  onClick: () => void;
  toggledOff?: boolean;
  children: React.ReactNode;
}

function ControlButton({
  active = false,
  children,
  danger = false,
  label,
  onClick,
  toggledOff = false,
}: ControlButtonProps) {
  return (
    <button
      aria-label={label}
      className={`${styles.control} ${active ? styles.active : ""} ${
        danger ? styles.danger : ""
      } ${toggledOff ? styles.off : ""}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

export function CallControls({
  isAudioMuted,
  isScreenSharing,
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
          label={isAudioMuted ? "Включить микрофон" : "Выключить микрофон"}
          onClick={onToggleAudio}
          toggledOff={isAudioMuted}
        >
          {isAudioMuted ? <MicOff size={20} /> : <Mic size={20} />}
        </ControlButton>
        <ControlButton
          label={isVideoMuted ? "Включить камеру" : "Выключить камеру"}
          onClick={onToggleVideo}
          toggledOff={isVideoMuted}
        >
          {isVideoMuted ? <CameraOff size={20} /> : <Camera size={20} />}
        </ControlButton>
        <ControlButton
          active={isScreenSharing}
          label={isScreenSharing ? "Остановить показ" : "Показать экран"}
          onClick={onToggleScreenShare}
        >
          <MonitorUp size={20} />
        </ControlButton>
        <span className={styles.divider} />
        <ControlButton danger label="Завершить звонок" onClick={onHangup}>
          <PhoneOff size={21} />
        </ControlButton>
      </div>
    </footer>
  );
}
