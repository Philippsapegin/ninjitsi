"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  LoaderCircle,
  Maximize2,
  Radio,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import { Brand } from "@/components/brand/Brand";
import { useCallTimer } from "@/hooks/useCallTimer";
import { useJitsiConference } from "@/lib/jitsi/useJitsiConference";
import type { JoinOptions } from "@/lib/jitsi/useJitsiConference";
import { readPendingJoin } from "@/lib/room";
import { authorizeRoom, getRoom, RoomApiError } from "@/lib/roomApi";
import { useRoomApiEnabled } from "@/lib/runtimeConfig";
import { AudioSinks } from "./AudioSinks";
import { CallControls } from "./CallControls";
import { ChatSidebar } from "./ChatSidebar";
import { ConnectionSummary } from "./ConnectionSummary";
import { JoinOverlay } from "./JoinOverlay";
import { SettingsPanel } from "./SettingsPanel";
import { VideoGrid } from "./VideoGrid";
import styles from "./MeetingRoom.module.css";

const EMPTY_JOIN_DETAILS: JoinOptions = {
  avatarDataUrl: "",
  displayName: "",
  password: "",
  profileId: "",
  startAudioMuted: false,
  startVideoMuted: false,
};

interface MeetingRoomProps {
  roomName: string;
}

type RoomGate =
  | { status: "checking"; error: null }
  | { status: "ready"; error: null }
  | { status: "failed"; error: string };

export function MeetingRoom({ roomName }: MeetingRoomProps) {
  const conference = useJitsiConference(roomName);
  const roomApiEnabled = useRoomApiEnabled();
  const [joinDetails, setJoinDetails] =
    useState<JoinOptions>(EMPTY_JOIN_DETAILS);
  const [joinDetailsReady, setJoinDetailsReady] = useState(false);
  const [protectedRoom, setProtectedRoom] = useState(false);
  const [copied, setCopied] = useState(false);
  const [admissionError, setAdmissionError] = useState("");
  const [isAdmissionBusy, setIsAdmissionBusy] = useState(false);
  const [roomCheckAttempt, setRoomCheckAttempt] = useState(0);
  const [focusedParticipantId, setFocusedParticipantId] = useState<
    string | null
  >(null);
  const [participantVolumes, setParticipantVolumes] = useState<
    Record<string, number>
  >({});
  const [roomGate, setRoomGate] = useState<RoomGate>({
    status: "checking",
    error: null,
  });
  const callIsActive =
    conference.status === "joined" ||
    conference.status === "reconnecting";
  const timer = useCallTimer(callIsActive);
  const showJoinOverlay =
    conference.status === "idle" ||
    conference.status === "loading" ||
    conference.status === "connecting" ||
    conference.status === "failed";

  const activeFocusedParticipantId =
    focusedParticipantId &&
    conference.participants.some(
      (participant) => participant.id === focusedParticipantId,
    )
      ? focusedParticipantId
      : null;

  useEffect(() => {
    if (!callIsActive || !("wakeLock" in navigator)) {
      return;
    }

    let cancelled = false;
    let wakeLock: WakeLockSentinel | null = null;

    const requestWakeLock = async () => {
      if (
        cancelled ||
        document.visibilityState !== "visible" ||
        wakeLock
      ) {
        return;
      }

      try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener(
          "release",
          () => {
            wakeLock = null;
          },
          { once: true },
        );
      } catch {
        // The meeting remains usable if the browser or OS rejects wake lock.
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void requestWakeLock();
      }
    };

    void requestWakeLock();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void wakeLock?.release();
      wakeLock = null;
    };
  }, [callIsActive]);

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

  useEffect(() => {
    let cancelled = false;

    if (!roomApiEnabled) {
      queueMicrotask(() => {
        if (!cancelled) {
          setRoomGate({ status: "ready", error: null });
        }
      });

      return () => {
        cancelled = true;
      };
    }

    queueMicrotask(() => {
      if (!cancelled) {
        setRoomGate({ status: "checking", error: null });
      }
    });

    void getRoom(roomName)
      .then((room) => {
        if (cancelled) {
          return;
        }

        setProtectedRoom(room.passwordRequired);
        setRoomGate({ status: "ready", error: null });
      })
      .catch((caughtError) => {
        if (cancelled) {
          return;
        }

        setRoomGate({
          status: "failed",
          error:
            caughtError instanceof RoomApiError
              ? caughtError.message
              : "Не удалось проверить комнату на сервере.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [roomApiEnabled, roomCheckAttempt, roomName]);

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

    if (!roomApiEnabled) {
      setProtectedRoom(Boolean(details.password));
    }

    localStorage.setItem("ninjitsi.displayName", details.displayName);
    setAdmissionError("");
    setIsAdmissionBusy(true);

    try {
      if (roomApiEnabled) {
        const room = await authorizeRoom(roomName, details.password);

        setProtectedRoom(room.passwordRequired);
      }

      await conference.join(details);
    } catch (caughtError) {
      setAdmissionError(
        caughtError instanceof RoomApiError
          ? caughtError.message
          : "Сервер не разрешил вход в комнату.",
      );
    } finally {
      setIsAdmissionBusy(false);
    }
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

  function setParticipantVolume(participantId: string, volume: number) {
    setParticipantVolumes((current) => ({
      ...current,
      [participantId]: Math.min(2, Math.max(0, volume)),
    }));
  }

  if (roomGate.status !== "ready") {
    return (
      <main className={styles.room}>
        <div className={styles.roomGate}>
          <Brand />
          {roomGate.status === "checking" ? (
            <>
              <LoaderCircle className={styles.gateSpinner} size={28} />
              <h1>Проверяем комнату</h1>
              <p>Сверяем код с локальным сервером Ninjitsi.</p>
            </>
          ) : (
            <>
              <WifiOff size={28} />
              <h1>Войти не получилось</h1>
              <p>{roomGate.error}</p>
              <div className={styles.gateActions}>
                <button
                  onClick={() => window.location.assign("/")}
                  type="button"
                >
                  <ArrowLeft size={16} />
                  На главную
                </button>
                <button
                  className={styles.gatePrimary}
                  onClick={() => setRoomCheckAttempt((attempt) => attempt + 1)}
                  type="button"
                >
                  <RefreshCw size={16} />
                  Проверить снова
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    );
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

        <ConnectionSummary
          participantLabel={participantLabel}
          participants={conference.participantConnections}
          protectedRoom={protectedRoom}
          timer={timer}
        />

        <div className={styles.headerActions}>
          <button onClick={() => void copyLink()} type="button">
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? "Скопировано" : "Скопировать ссылку"}
          </button>
          <SettingsPanel
            audioInputId={conference.audioInputId}
            busy={conference.isDeviceSwitchBusy}
            noiseSuppressionEnabled={conference.noiseSuppressionEnabled}
            noiseSuppressionSupported={conference.noiseSuppressionSupported}
            onAudioInputChange={conference.setAudioInputDevice}
            onNoiseSuppressionChange={conference.setNoiseSuppressionEnabled}
            onVideoInputChange={conference.setVideoInputDevice}
            videoInputId={conference.videoInputId}
          />
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

      <div className={styles.workspace}>
        <section className={styles.stage}>
          {conference.participants.length > 0 ? (
            <VideoGrid
              focusedParticipantId={activeFocusedParticipantId}
              onParticipantClick={setFocusedParticipantId}
              onParticipantVolumeChange={setParticipantVolume}
              participantVolumes={participantVolumes}
              participants={conference.participants}
            />
          ) : (
            <div className={styles.emptyStage}>
              <Radio size={26} />
              <span>Ожидаем участников</span>
            </div>
          )}
        </section>

        <ChatSidebar
          disabled={conference.status !== "joined"}
          isSendingAttachment={conference.isSendingAttachment}
          messages={conference.chatMessages}
          onSend={conference.sendChatMessage}
          onSendAttachment={conference.sendChatAttachment}
          participants={conference.participants}
        />
      </div>

      <CallControls
        isAudioBusy={conference.isAudioBusy}
        isAudioMuted={conference.isAudioMuted}
        isScreenShareBusy={conference.isScreenShareBusy}
        isScreenSharing={conference.isScreenSharing}
        isVideoBusy={conference.isVideoBusy}
        isVideoMuted={conference.isVideoMuted}
        localAudioLevel={conference.localAudioLevel}
        onHangup={() => void hangup()}
        onToggleAudio={() => void conference.toggleAudio()}
        onToggleScreenShare={() => void conference.toggleScreenShare()}
        onToggleVideo={() => void conference.toggleVideo()}
      />

      <AudioSinks
        participantVolumes={participantVolumes}
        participants={conference.participants}
      />

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
          error={admissionError || conference.error}
          initialDetails={joinDetails}
          isDemo={conference.isDemo}
          key={`${joinDetails.profileId}-${joinDetails.displayName}-${joinDetails.password}-${conference.status === "failed"}`}
          onJoin={join}
          roomName={roomName}
          status={isAdmissionBusy ? "loading" : conference.status}
        />
      )}
    </main>
  );
}
