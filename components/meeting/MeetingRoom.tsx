"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  LockKeyhole,
  Maximize2,
  Radio,
  Users,
  WifiOff,
} from "lucide-react";
import { Brand } from "@/components/brand/Brand";
import { useCallTimer } from "@/hooks/useCallTimer";
import { useJitsiConference } from "@/lib/jitsi/useJitsiConference";
import type { JoinOptions } from "@/lib/jitsi/useJitsiConference";
import { readPendingJoin } from "@/lib/room";
import { AudioSinks } from "./AudioSinks";
import { CallControls } from "./CallControls";
import { JoinOverlay } from "./JoinOverlay";
import { VideoGrid } from "./VideoGrid";
import styles from "./MeetingRoom.module.css";

const EMPTY_JOIN_DETAILS: JoinOptions = {
  displayName: "",
  password: "",
  startAudioMuted: false,
  startVideoMuted: false,
};

interface MeetingRoomProps {
  roomName: string;
}

export function MeetingRoom({ roomName }: MeetingRoomProps) {
  const conference = useJitsiConference(roomName);
  const [joinDetails, setJoinDetails] =
    useState<JoinOptions>(EMPTY_JOIN_DETAILS);
  const [joinDetailsReady, setJoinDetailsReady] = useState(false);
  const [protectedRoom, setProtectedRoom] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useCallTimer(conference.status === "joined");
  const showJoinOverlay =
    conference.status === "idle" ||
    conference.status === "loading" ||
    conference.status === "connecting" ||
    conference.status === "failed";

  useEffect(() => {
    queueMicrotask(() => {
      const pending = readPendingJoin();
      const rememberedName =
        localStorage.getItem("ninjitsi.displayName") ?? "";

      setJoinDetails(
        pending ?? {
          ...EMPTY_JOIN_DETAILS,
          displayName: rememberedName,
        },
      );
      setJoinDetailsReady(true);
    });
  }, []);

  const participantLabel = useMemo(() => {
    const count = conference.participants.length;
    const lastTwoDigits = count % 100;
    const lastDigit = count % 10;
    let noun = "участников";

    if (lastTwoDigits < 11 || lastTwoDigits > 14) {
      if (lastDigit === 1) {
        noun = "участник";
      } else if (lastDigit >= 2 && lastDigit <= 4) {
        noun = "участника";
      }
    }

    return `${count} ${noun}`;
  }, [conference.participants.length]);

  async function join(details: JoinOptions) {
    setJoinDetails(details);
    setProtectedRoom(Boolean(details.password));
    localStorage.setItem("ninjitsi.displayName", details.displayName);
    await conference.join(details);
  }

  async function hangup() {
    await conference.leave();
    window.location.assign("/");
  }

  async function copyLink() {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  }

  return (
    <main className={styles.room}>
      <header className={styles.topbar}>
        <div className={styles.roomIdentity}>
          <Brand compact />
          <span className={styles.separator} />
          <div>
            <strong>{roomName}</strong>
            <span>
              {conference.isDemo ? "демонстрация интерфейса" : "Jitsi-комната"}
            </span>
          </div>
        </div>

        <div className={styles.callMeta}>
          <span className={styles.liveDot} />
          <strong>{timer}</strong>
          <span className={styles.metaDivider} />
          <Users size={14} />
          <span>{participantLabel}</span>
          {protectedRoom && (
            <>
              <span className={styles.metaDivider} />
              <LockKeyhole size={13} />
              <span>с паролем</span>
            </>
          )}
        </div>

        <div className={styles.headerActions}>
          <button onClick={() => void copyLink()} type="button">
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? "Скопировано" : "Скопировать ссылку"}
          </button>
          <button
            aria-label="Полноэкранный режим"
            className={styles.iconButton}
            onClick={() => void toggleFullscreen()}
            title="Полноэкранный режим"
            type="button"
          >
            <Maximize2 size={16} />
          </button>
        </div>
      </header>

      <section className={styles.stage}>
        {conference.participants.length > 0 ? (
          <VideoGrid participants={conference.participants} />
        ) : (
          <div className={styles.emptyStage}>
            <Radio size={26} />
            <span>Ожидаем участников</span>
          </div>
        )}
      </section>

      <CallControls
        isAudioBusy={conference.isAudioBusy}
        isAudioMuted={conference.isAudioMuted}
        isScreenShareBusy={conference.isScreenShareBusy}
        isScreenSharing={conference.isScreenSharing}
        isVideoBusy={conference.isVideoBusy}
        isVideoMuted={conference.isVideoMuted}
        onHangup={() => void hangup()}
        onToggleAudio={() => void conference.toggleAudio()}
        onToggleScreenShare={() => void conference.toggleScreenShare()}
        onToggleVideo={() => void conference.toggleVideo()}
      />

      <AudioSinks participants={conference.participants} />

      {conference.status === "reconnecting" && (
        <div className={styles.reconnecting}>
          <WifiOff size={15} />
          Связь прервалась. Восстанавливаем…
        </div>
      )}

      {conference.error && conference.status === "joined" && (
        <div className={styles.toast}>{conference.error}</div>
      )}

      {showJoinOverlay && joinDetailsReady && (
        <JoinOverlay
          error={conference.error}
          initialDetails={joinDetails}
          isDemo={conference.isDemo}
          key={`${joinDetails.displayName}-${joinDetails.password}-${conference.status === "failed"}`}
          onJoin={join}
          roomName={roomName}
          status={conference.status}
        />
      )}
    </main>
  );
}
