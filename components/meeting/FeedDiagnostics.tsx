"use client";

import { useEffect, useState } from "react";
import { Activity, ChevronDown, Mic, Video } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { JitsiTrackLike, MeetingStatus, ParticipantView } from "@/lib/jitsi/types";
import { VideoTrack } from "./MediaTrack";
import styles from "./FeedDiagnostics.module.css";

const STORAGE_KEY = "ninjitsi.feedDiagnosticsExpanded";

function isTrackLive(track: JitsiTrackLike | undefined) {
  if (!track || track.isMuted()) {
    return false;
  }

  const nativeTrack = track.getTrack?.();
  return !nativeTrack || (
    nativeTrack.readyState === "live" &&
    nativeTrack.enabled &&
    !nativeTrack.muted
  );
}

interface FeedDiagnosticsProps {
  audioLevel: number;
  localParticipant?: ParticipantView;
  status: MeetingStatus;
}

export function FeedDiagnostics({
  audioLevel,
  localParticipant,
  status,
}: FeedDiagnosticsProps) {
  const { tr } = useI18n();
  const [expanded, setExpanded] = useState(
    () => typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY) === "true",
  );
  const [, refreshTrackState] = useState(0);
  const audioTrack = localParticipant?.audioTrack;
  const videoTrack = localParticipant?.videoTrack;

  useEffect(() => {
    const nativeTracks = [audioTrack?.getTrack?.(), videoTrack?.getTrack?.()]
      .filter((track): track is MediaStreamTrack => Boolean(track));
    const refresh = () => refreshTrackState((value) => value + 1);

    for (const track of nativeTracks) {
      track.addEventListener("ended", refresh);
      track.addEventListener("mute", refresh);
      track.addEventListener("unmute", refresh);
    }

    return () => {
      for (const track of nativeTracks) {
        track.removeEventListener("ended", refresh);
        track.removeEventListener("mute", refresh);
        track.removeEventListener("unmute", refresh);
      }
    };
  }, [audioTrack, videoTrack]);

  const connected = status === "joined";
  const audioLive = connected && isTrackLive(audioTrack);
  const videoLive = connected && isTrackLive(videoTrack);
  const level = audioLive ? Math.round(Math.min(1, Math.max(0, audioLevel)) * 100) : 0;

  const statusLabel = (track: JitsiTrackLike | undefined, live: boolean) => {
    if (!connected) {
      return tr("Connecting", "Подключение");
    }
    if (!track || track.isMuted()) {
      return tr("Off", "Выключен");
    }
    return live
      ? tr("Feed active", "Поток активен")
      : tr("No feed", "Нет потока");
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    localStorage.setItem(STORAGE_KEY, String(next));
  };

  return (
    <section className={styles.root}>
      <button
        aria-expanded={expanded}
        className={styles.heading}
        onClick={toggle}
        type="button"
      >
        <span className={styles.headingIcon}><Activity size={15} /></span>
        <span>{tr("Feed diagnostics", "Диагностика потоков")}</span>
        <ChevronDown className={expanded ? styles.chevronOpen : ""} size={15} />
      </button>

      {expanded && (
        <div className={styles.content}>
          <div className={styles.feedRow}>
            <Mic size={15} />
            <div>
              <strong>{tr("Microphone", "Микрофон")}</strong>
              <span className={audioLive ? styles.active : ""}>
                {statusLabel(audioTrack, audioLive)}
              </span>
            </div>
            <div
              aria-label={tr("Microphone level", "Уровень микрофона")}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={level}
              className={styles.meter}
              role="meter"
            >
              <i style={{ width: `${level}%` }} />
            </div>
          </div>
          <div className={styles.feedRow}>
            <Video size={15} />
            <div>
              <strong>
                {localParticipant?.isScreenSharing
                  ? tr("Screen", "Экран")
                  : tr("Video", "Видео")}
              </strong>
              <span className={videoLive ? styles.active : ""}>
                {statusLabel(videoTrack, videoLive)}
              </span>
            </div>
          </div>
          {videoLive && videoTrack && (
            <div className={styles.preview}>
              <VideoTrack isLocal track={videoTrack} />
            </div>
          )}
          <p>
            {tr(
              "Shows your local feed. Reception by others also depends on the connection.",
              "Показывает локальный поток. Получение другими зависит и от соединения.",
            )}
          </p>
        </div>
      )}
    </section>
  );
}
