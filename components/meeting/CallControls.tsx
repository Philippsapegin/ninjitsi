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
import { useI18n } from "@/lib/i18n";
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
  pushToTalkEnabled: boolean;
  pushToTalkPressed: boolean;
  onPushToTalkPress: () => void;
  onPushToTalkRelease: () => void;
}

interface ControlButtonProps {
  active?: boolean;
  audioLevel?: number;
  disabled?: boolean;
  danger?: boolean;
  label: string;
  onClick: () => void;
  toggledOff?: boolean;
  onPress?: () => void;
  onRelease?: () => void;
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
  onPress,
  onRelease,
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
      onPointerDown={onPress ? (event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        onPress();
      } : undefined}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      onLostPointerCapture={onRelease}
      onBlur={onRelease}
      onKeyDown={onPress ? event => {
        if ((event.code === "Space" || event.code === "Enter") && !event.repeat) {
          event.preventDefault(); onPress();
        }
      } : undefined}
      onKeyUp={onRelease ? event => {
        if (event.code === "Space" || event.code === "Enter") { event.preventDefault(); onRelease(); }
      } : undefined}
      style={{
        ...(onPress ? { touchAction: "none" } : {}),
        ...(audioLevel !== undefined ? { "--audio-level": Math.max(0, Math.min(1, audioLevel)) } : {}),
      } as CSSProperties}
      disabled={disabled}
      title={label}
      type="button"
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
  pushToTalkEnabled,
  pushToTalkPressed,
  onPushToTalkPress,
  onPushToTalkRelease,
}: CallControlsProps) {
  const { tr } = useI18n();

  return (
    <footer className={styles.bar}>
      <div className={styles.dock}>
        <ControlButton
          audioLevel={isAudioMuted ? 0 : localAudioLevel}
          disabled={isAudioBusy && !pushToTalkEnabled}
          active={pushToTalkEnabled && pushToTalkPressed}
          onPress={pushToTalkEnabled ? onPushToTalkPress : undefined}
          onRelease={pushToTalkEnabled ? onPushToTalkRelease : undefined}
          label={
            pushToTalkEnabled ? tr("Hold to talk", "Удерживать для разговора") : isAudioBusy
              ? tr("Connecting microphone", "Подключаем микрофон")
              : isAudioMuted
                ? tr("Turn microphone on", "Включить микрофон")
                : tr("Turn microphone off", "Выключить микрофон")
          }
          onClick={pushToTalkEnabled ? () => undefined : onToggleAudio}
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
              ? tr("Connecting camera", "Подключаем камеру")
              : isVideoMuted
                ? tr("Turn camera on", "Включить камеру")
                : tr("Turn camera off", "Выключить камеру")
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
              ? tr("Preparing screen share", "Готовим показ экрана")
              : isScreenSharing
                ? tr("Stop sharing", "Остановить показ")
                : tr("Share screen", "Показать экран")
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
        <ControlButton
          danger
          label={tr("Leave call", "Завершить звонок")}
          onClick={onHangup}
        >
          <PhoneOff size={21} />
        </ControlButton>
      </div>
    </footer>
  );
}
