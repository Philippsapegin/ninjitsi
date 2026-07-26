"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useJitsiServerUrl } from "@/lib/runtimeConfig";
import { loadJitsiRuntime } from "./loader";
import {
  readMediaPreferences,
  saveMediaPreferences,
} from "./mediaPreferences";
import {
  isNoiseSuppressionSupported,
  JitsiNoiseSuppressionEffect,
} from "./noiseSuppression";
import type {
  ChatAttachment,
  ChatMessage,
  JitsiConferenceLike,
  JitsiConnectionLike,
  JitsiMeetJSLibrary,
  JitsiTrackLike,
  MeetingStatus,
  ParticipantConnectionInfo,
  ParticipantView,
} from "./types";

export interface JoinOptions {
  avatarDataUrl: string;
  displayName: string;
  password: string;
  profileId: string;
  startAudioMuted: boolean;
  startVideoMuted: boolean;
}

interface ConferenceController {
  audioInputId: string;
  chatMessages: ChatMessage[];
  error: string | null;
  isAudioBusy: boolean;
  isAudioMuted: boolean;
  isDemo: boolean;
  isDeviceSwitchBusy: boolean;
  isSendingAttachment: boolean;
  isScreenShareBusy: boolean;
  isScreenSharing: boolean;
  isVideoBusy: boolean;
  isVideoMuted: boolean;
  localAudioLevel: number;
  noiseSuppressionEnabled: boolean;
  noiseSuppressionSupported: boolean;
  participantConnections: ParticipantConnectionInfo[];
  sendChatAttachment: (file: File) => Promise<void>;
  sendChatMessage: (text: string) => void;
  setAudioInputDevice: (deviceId: string) => Promise<void>;
  setNoiseSuppressionEnabled: (enabled: boolean) => Promise<void>;
  setVideoInputDevice: (deviceId: string) => Promise<void>;
  join: (options: JoinOptions) => Promise<void>;
  leave: () => Promise<void>;
  participants: ParticipantView[];
  status: MeetingStatus;
  toggleAudio: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
  toggleVideo: () => Promise<void>;
  videoInputId: string;
}

const demoNames = [
  "Лера К.",
  "Михаил",
  "Таня",
  "Костя",
  "Анна",
  "Сергей",
];

const ATTACHMENT_MESSAGE_PREFIX = "__ninjitsi_attachment_v1__:";
const PING_MESSAGE_PREFIX = "__ninjitsi_ping_v1__:";
const ATTACHMENT_CHUNK_SIZE = 12_000;
export const MAX_CHAT_ATTACHMENT_SIZE = 2 * 1024 * 1024;

type AttachmentWireMessage =
  | {
      id: string;
      kind: "start";
      mimeType: string;
      name: string;
      size: number;
      totalChunks: number;
    }
  | {
      data: string;
      id: string;
      index: number;
      kind: "chunk";
    }
  | {
      id: string;
      kind: "end";
    };

interface IncomingAttachment {
  avatarUrl: string;
  chunks: string[];
  id: string;
  mimeType: string;
  name: string;
  senderId: string;
  senderName: string;
  size: number;
  timestamp: number;
  totalChunks: number;
}

type PingWireMessage =
  | {
      id: string;
      kind: "request";
      to: string;
    }
  | {
      id: string;
      kind: "response";
      to: string;
    };

type LocalMediaDevice = "audio" | "video" | "desktop";

function parseAttachmentWireMessage(text: string) {
  if (!text.startsWith(ATTACHMENT_MESSAGE_PREFIX)) {
    return null;
  }

  try {
    return JSON.parse(
      text.slice(ATTACHMENT_MESSAGE_PREFIX.length),
    ) as AttachmentWireMessage;
  } catch {
    return null;
  }
}

function attachmentMessage(message: AttachmentWireMessage) {
  return `${ATTACHMENT_MESSAGE_PREFIX}${JSON.stringify(message)}`;
}

function parsePingWireMessage(text: string) {
  if (!text.startsWith(PING_MESSAGE_PREFIX)) {
    return null;
  }

  try {
    return JSON.parse(text.slice(PING_MESSAGE_PREFIX.length)) as PingWireMessage;
  } catch {
    return null;
  }
}

function pingMessage(message: PingWireMessage) {
  return `${PING_MESSAGE_PREFIX}${JSON.stringify(message)}`;
}

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Не удалось прочитать вложение"));
      }
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Не удалось прочитать вложение")),
    );
    reader.readAsDataURL(file);
  });
}

function mediaName(device: LocalMediaDevice) {
  if (device === "audio") {
    return "микрофон";
  }

  return device === "video" ? "камеру" : "демонстрацию экрана";
}

function mediaErrorMessage(device: LocalMediaDevice, caughtError: unknown) {
  const rawError =
    caughtError && typeof caughtError === "object"
      ? `${"name" in caughtError ? String(caughtError.name) : ""} ${
          "message" in caughtError ? String(caughtError.message) : ""
        }`
      : String(caughtError ?? "");
  const normalized = rawError.toLowerCase();
  const target = mediaName(device);

  if (
    normalized.includes("permission") ||
    normalized.includes("notallowed") ||
    normalized.includes("denied")
  ) {
    return `Нет разрешения на ${target}. Разрешите доступ в адресной строке Chrome.`;
  }

  if (
    normalized.includes("notfound") ||
    normalized.includes("devicesnotfound") ||
    normalized.includes("no device")
  ) {
    return `Не удалось найти ${target}. Проверьте подключение устройства.`;
  }

  if (
    normalized.includes("notreadable") ||
    normalized.includes("trackstart") ||
    normalized.includes("could not start")
  ) {
    return `Не удалось запустить ${target}: возможно, устройство занято другим приложением.`;
  }

  if (
    device === "desktop" &&
    (normalized.includes("abort") || normalized.includes("cancel"))
  ) {
    return "Выбор экрана отменён.";
  }

  return `Не удалось подключить ${target}.`;
}

async function createLocalTrack(
  library: JitsiMeetJSLibrary,
  device: LocalMediaDevice,
  deviceId = "",
) {
  const tracks = await library.createLocalTracks({
    devices: [device],
    ...(device === "audio"
      ? { micDeviceId: deviceId || "default" }
      : {}),
    ...(device === "video" && deviceId ? { cameraDeviceId: deviceId } : {}),
    ...(device === "video" ? { resolution: 720 } : {}),
  });
  const track = tracks.find((candidate) =>
    device === "desktop"
      ? candidate.getVideoType?.() === "desktop"
      : candidate.getType() === device,
  );
  const unusedTracks = tracks.filter((candidate) => candidate !== track);

  await Promise.allSettled(
    unusedTracks.map((unusedTrack) => unusedTrack.dispose()),
  );

  if (!track) {
    throw new Error(`Jitsi did not create a ${device} track`);
  }

  return track;
}

function pickPreferredVideo(tracks: JitsiTrackLike[]) {
  const videoTracks = tracks.filter((track) => track.getType() === "video");
  const activeDesktop = videoTracks.find(
    (track) =>
      track.getVideoType?.() === "desktop" &&
      !track.isMuted(),
  );
  const camera = videoTracks.find(
    (track) => track.getVideoType?.() !== "desktop",
  );

  return activeDesktop ?? camera ?? videoTracks[0];
}

function createDemoParticipants(
  displayName: string,
  avatarUrl: string,
): ParticipantView[] {
  const people = [displayName, ...demoNames];

  return people.map((name, index) => ({
    audioMuted: index === 3,
    avatarUrl: index === 0 ? avatarUrl : "",
    displayName: name,
    id: index === 0 ? "local" : `demo-${index}`,
    isDominantSpeaker: index === 1,
    isLocal: index === 0,
    isModerator: index === 0,
    isScreenSharing: false,
    videoMuted: index === 4,
  }));
}

export function useJitsiConference(roomName: string): ConferenceController {
  const serverUrl = useJitsiServerUrl();
  const isDemo = !serverUrl;
  const [status, setStatus] = useState<MeetingStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<ParticipantView[]>([]);
  const [isAudioBusy, setIsAudioBusy] = useState(false);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoBusy, setIsVideoBusy] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [isScreenShareBusy, setIsScreenShareBusy] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [localAudioLevel, setLocalAudioLevel] = useState(0);
  const [audioInputId, setAudioInputIdState] = useState("");
  const [videoInputId, setVideoInputIdState] = useState("");
  const [noiseSuppressionEnabled, setNoiseSuppressionState] = useState(false);
  const [noiseSuppressionSupported, setNoiseSuppressionSupported] =
    useState(false);
  const [isDeviceSwitchBusy, setIsDeviceSwitchBusy] = useState(false);
  const [isSendingAttachment, setIsSendingAttachment] = useState(false);
  const [connectionStats, setConnectionStats] = useState<
    Record<string, { pingMs: number | null; quality: number | null }>
  >({});
  const connectionRef = useRef<JitsiConnectionLike | null>(null);
  const conferenceRef = useRef<JitsiConferenceLike | null>(null);
  const libraryRef = useRef<JitsiMeetJSLibrary | null>(null);
  const localIdRef = useRef("local");
  const localNameRef = useRef("Вы");
  const localAvatarRef = useRef("");
  const dominantSpeakerRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const desktopRemovalRef = useRef(new WeakSet<JitsiTrackLike>());
  const audioBusyRef = useRef(false);
  const videoBusyRef = useRef(false);
  const screenShareBusyRef = useRef(false);
  const audioLevelTracksRef = useRef(new WeakSet<JitsiTrackLike>());
  const audioInputIdRef = useRef("");
  const videoInputIdRef = useRef("");
  const noiseSuppressionEnabledRef = useRef(false);
  const incomingAttachmentsRef = useRef(
    new Map<string, IncomingAttachment>(),
  );
  const pendingPingsRef = useRef(
    new Map<string, { participantId: string; startedAt: number }>(),
  );
  const pingIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      const preferences = readMediaPreferences();

      audioInputIdRef.current = preferences.audioInputId;
      videoInputIdRef.current = preferences.videoInputId;
      noiseSuppressionEnabledRef.current =
        preferences.noiseSuppressionEnabled;
      setAudioInputIdState(preferences.audioInputId);
      setVideoInputIdState(preferences.videoInputId);
      setNoiseSuppressionState(preferences.noiseSuppressionEnabled);
      setNoiseSuppressionSupported(isNoiseSuppressionSupported());
    });
  }, []);

  const persistMediaPreferences = useCallback(() => {
    saveMediaPreferences({
      audioInputId: audioInputIdRef.current,
      noiseSuppressionEnabled: noiseSuppressionEnabledRef.current,
      videoInputId: videoInputIdRef.current,
    });
  }, []);

  const watchLocalAudioLevel = useCallback((track?: JitsiTrackLike) => {
    const eventName = libraryRef.current?.events.track.TRACK_AUDIO_LEVEL_CHANGED;

    if (
      !track ||
      !eventName ||
      !track.addEventListener ||
      audioLevelTracksRef.current.has(track)
    ) {
      return;
    }

    audioLevelTracksRef.current.add(track);
    track.addEventListener(eventName, (rawLevel) => {
      const level =
        typeof rawLevel === "number" && Number.isFinite(rawLevel)
          ? Math.max(0, Math.min(1, rawLevel))
          : 0;

      setLocalAudioLevel(track.isMuted() ? 0 : level);
    });
  }, []);

  const setMediaBusy = useCallback(
    (device: LocalMediaDevice, busy: boolean) => {
      if (device === "audio") {
        audioBusyRef.current = busy;
        setIsAudioBusy(busy);
      } else if (device === "video") {
        videoBusyRef.current = busy;
        setIsVideoBusy(busy);
      } else {
        screenShareBusyRef.current = busy;
        setIsScreenShareBusy(busy);
      }
    },
    [],
  );

  const syncParticipants = useCallback(() => {
    const conference = conferenceRef.current;

    if (!conference) {
      return;
    }

    const localTracks = conference.getLocalTracks();
    const localVideo = pickPreferredVideo(localTracks);
    const localAudio = localTracks.find((track) => track.getType() === "audio");
    watchLocalAudioLevel(localAudio);
    const remote = conference
      .getParticipants()
      .filter((participant) => !participant.isHidden?.())
      .map<ParticipantView>((participant) => {
        const tracks = participant.getTracks();
        const videoTrack = pickPreferredVideo(tracks);
        const audioTrack = tracks.find((track) => track.getType() === "audio");

        return {
          audioMuted: participant.isAudioMuted(),
          audioTrack,
          avatarUrl:
            typeof participant.getProperty?.("avatarURL") === "string"
              ? String(participant.getProperty?.("avatarURL"))
              : "",
          displayName: participant.getDisplayName() || "Без имени",
          id: participant.getId(),
          isDominantSpeaker:
            participant.getId() === dominantSpeakerRef.current,
          isLocal: false,
          isModerator: participant.getRole() === "moderator",
          isScreenSharing: videoTrack?.getVideoType?.() === "desktop",
          videoMuted: videoTrack
            ? videoTrack.isMuted()
            : participant.isVideoMuted(),
          videoTrack,
        };
      });

    const audioMuted = !localAudio || localAudio.isMuted();
    if (audioMuted) {
      setLocalAudioLevel(0);
    }
    const cameraTracks = localTracks.filter(
      (track) =>
        track.getType() === "video" &&
        track.getVideoType?.() !== "desktop",
    );
    const videoMuted =
      cameraTracks.length === 0 || cameraTracks.every((track) => track.isMuted());
    const sharing = localTracks.some(
      (track) =>
        track.getType() === "video" &&
        track.getVideoType?.() === "desktop" &&
        !track.isMuted(),
    );

    setIsAudioMuted(audioMuted);
    setIsVideoMuted(videoMuted);
    setIsScreenSharing(sharing);
    setParticipants([
      {
        audioMuted,
        audioTrack: localAudio,
        avatarUrl: localAvatarRef.current,
        displayName: localNameRef.current,
        id: localIdRef.current,
        isDominantSpeaker:
          localIdRef.current === dominantSpeakerRef.current,
        isLocal: true,
        isModerator: conference.isModerator(),
        isScreenSharing: localVideo?.getVideoType?.() === "desktop",
        videoMuted: localVideo ? localVideo.isMuted() : true,
        videoTrack: localVideo,
      },
      ...remote,
    ]);
  }, [watchLocalAudioLevel]);

  const scheduleParticipantSync = useCallback(() => {
    syncParticipants();
    queueMicrotask(syncParticipants);
  }, [syncParticipants]);

  const teardown = useCallback(async () => {
    disposedRef.current = true;
    const conference = conferenceRef.current;
    const connection = connectionRef.current;

    conferenceRef.current = null;
    connectionRef.current = null;
    if (pingIntervalRef.current !== null) {
      window.clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    pendingPingsRef.current.clear();
    setMediaBusy("audio", false);
    setMediaBusy("video", false);
    setMediaBusy("desktop", false);

    if (conference) {
      const tracks = conference.getLocalTracks();

      await Promise.allSettled(
        tracks.map(async (track) => {
          await conference.removeTrack(track).catch(() => undefined);
          await track.dispose().catch(() => undefined);
        }),
      );
      await conference.leave().catch(() => undefined);
    }

    connection?.disconnect();
  }, [setMediaBusy]);

  const join = useCallback(
    async (options: JoinOptions) => {
      setError(null);
      localNameRef.current = options.displayName;
      localAvatarRef.current = options.avatarDataUrl;
      disposedRef.current = false;
      setChatMessages([]);
      setConnectionStats({});
      incomingAttachmentsRef.current.clear();

      if (isDemo) {
        setStatus("loading");
        await new Promise((resolve) => window.setTimeout(resolve, 420));
        const demoParticipants = createDemoParticipants(
          options.displayName,
          options.avatarDataUrl,
        );

        demoParticipants[0].audioMuted = options.startAudioMuted;
        demoParticipants[0].videoMuted = options.startVideoMuted;
        setParticipants(demoParticipants);
        setIsAudioMuted(options.startAudioMuted);
        setIsVideoMuted(options.startVideoMuted);
        setStatus("joined");
        return;
      }

      setStatus("loading");
      let discardInitialTracks: (() => void) | undefined;

      try {
        const { config, library } = await loadJitsiRuntime(
          serverUrl,
          roomName,
        );
        const preferences = readMediaPreferences();

        if (disposedRef.current) {
          return;
        }

        audioInputIdRef.current = preferences.audioInputId;
        videoInputIdRef.current = preferences.videoInputId;
        noiseSuppressionEnabledRef.current =
          preferences.noiseSuppressionEnabled;
        setAudioInputIdState(preferences.audioInputId);
        setVideoInputIdState(preferences.videoInputId);
        setNoiseSuppressionState(preferences.noiseSuppressionEnabled);
        libraryRef.current = library;
        library.init({
          disableAudioLevels: false,
          disableThirdPartyRequests: true,
        });

        if (library.setLogLevel && library.logLevels?.ERROR) {
          library.setLogLevel(library.logLevels.ERROR);
        }

        setIsAudioMuted(options.startAudioMuted);
        setIsVideoMuted(options.startVideoMuted);
        setMediaBusy("audio", true);
        setMediaBusy("video", true);

        const initialTracksPromise = Promise.all(
          (
            [
              {
                device: "audio",
                startMuted: options.startAudioMuted,
              },
              {
                device: "video",
                startMuted: options.startVideoMuted,
              },
            ] as const
          ).map(async ({ device, startMuted }) => {
            try {
              const deviceId =
                device === "audio"
                  ? preferences.audioInputId
                  : preferences.videoInputId;
              const track = await createLocalTrack(library, device, deviceId);

              if (
                device === "audio" &&
                preferences.noiseSuppressionEnabled &&
                track.setEffect
              ) {
                await track.setEffect(
                  new JitsiNoiseSuppressionEffect(
                    new URL(
                      "/libs/noise-suppressor-worklet.min.js",
                      serverUrl,
                    ).toString(),
                  ),
                );
              }

              if (startMuted) {
                await track.mute();
              }

              return { device, ok: true as const, track };
            } catch (trackError) {
              return {
                device,
                error: trackError,
                ok: false as const,
              };
            }
          }),
        );
        let initialTracksClaimed = false;

        discardInitialTracks = () => {
          if (initialTracksClaimed) {
            return;
          }

          initialTracksClaimed = true;
          void initialTracksPromise.then(async (results) => {
            await Promise.allSettled(
              results.flatMap((result) =>
                result.ok ? [result.track.dispose()] : [],
              ),
            );
            setMediaBusy("audio", false);
            setMediaBusy("video", false);
          });
        };

        const connection = new library.JitsiConnection(null, null, config);
        const connectionEvents = library.events.connection;

        connectionRef.current = connection;
        setStatus("connecting");

        connection.addEventListener(
          connectionEvents.CONNECTION_ESTABLISHED,
          async (...eventArguments) => {
            initialTracksClaimed = true;
            localIdRef.current =
              typeof eventArguments[0] === "string"
                ? eventArguments[0]
                : "local";

            const conference = connection.initJitsiConference(roomName, config);
            const conferenceEvents = library.events.conference;

            conferenceRef.current = conference;
            localIdRef.current =
              conference.myUserId?.() || localIdRef.current;
            conference.setDisplayName(options.displayName);
            conference.setLocalParticipantProperty?.(
              "avatarURL",
              options.avatarDataUrl,
            );

            const sendPingRound = () => {
              if (
                conferenceRef.current !== conference ||
                !conference.sendTextMessage
              ) {
                return;
              }

              const now = window.performance.now();

              for (const [pingId, pending] of pendingPingsRef.current) {
                if (now - pending.startedAt > 20_000) {
                  pendingPingsRef.current.delete(pingId);
                }
              }

              for (const participant of conference.getParticipants()) {
                const pingId = `${localIdRef.current}-${Date.now()}-${Math.random()
                  .toString(36)
                  .slice(2)}`;

                pendingPingsRef.current.set(pingId, {
                  participantId: participant.getId(),
                  startedAt: window.performance.now(),
                });
                conference.sendTextMessage(
                  pingMessage({
                    id: pingId,
                    kind: "request",
                    to: participant.getId(),
                  }),
                );
              }
            };

            const resyncEvents = [
              conferenceEvents.TRACK_ADDED,
              conferenceEvents.TRACK_REMOVED,
              conferenceEvents.TRACK_MUTE_CHANGED,
              conferenceEvents.USER_JOINED,
              conferenceEvents.USER_LEFT,
              conferenceEvents.USER_ROLE_CHANGED,
              conferenceEvents.DISPLAY_NAME_CHANGED,
              conferenceEvents.PARTICIPANT_PROPERTY_CHANGED,
            ].filter(Boolean);

            resyncEvents.forEach((eventName) =>
              conference.on(eventName, scheduleParticipantSync),
            );

            conference.on(
              conferenceEvents.DOMINANT_SPEAKER_CHANGED,
              (participantId) => {
                dominantSpeakerRef.current =
                  typeof participantId === "string" ? participantId : null;
                syncParticipants();
              },
            );
            if (conferenceEvents.MESSAGE_RECEIVED) {
              conference.on(
                conferenceEvents.MESSAGE_RECEIVED,
                (rawSenderId, rawText, rawTimestamp) => {
                  if (
                    typeof rawSenderId !== "string" ||
                    typeof rawText !== "string"
                  ) {
                    return;
                  }

                  if (rawSenderId === localIdRef.current) {
                    return;
                  }

                  const pingWireMessage = parsePingWireMessage(rawText);

                  if (pingWireMessage) {
                    if (pingWireMessage.to !== localIdRef.current) {
                      return;
                    }

                    if (pingWireMessage.kind === "request") {
                      conference.sendTextMessage?.(
                        pingMessage({
                          id: pingWireMessage.id,
                          kind: "response",
                          to: rawSenderId,
                        }),
                      );
                    } else {
                      const pending = pendingPingsRef.current.get(
                        pingWireMessage.id,
                      );

                      pendingPingsRef.current.delete(pingWireMessage.id);
                      if (
                        pending?.participantId === rawSenderId &&
                        Number.isFinite(pending.startedAt)
                      ) {
                        const pingMs = Math.max(
                          0,
                          Math.round(
                            window.performance.now() - pending.startedAt,
                          ),
                        );

                        setConnectionStats((current) => ({
                          ...current,
                          [rawSenderId]: {
                            pingMs,
                            quality: current[rawSenderId]?.quality ?? null,
                          },
                        }));
                      }
                    }

                    return;
                  }

                  const sender = conference
                    .getParticipants()
                    .find(
                      (participant) =>
                        participant.getId() === rawSenderId,
                    );
                  const numericTimestamp =
                    typeof rawTimestamp === "number"
                      ? rawTimestamp
                      : Number.NaN;
                  const parsedTimestamp =
                    typeof rawTimestamp === "string" && rawTimestamp
                      ? Date.parse(rawTimestamp)
                      : Number.NaN;
                  const timestamp =
                    Number.isFinite(numericTimestamp) &&
                    numericTimestamp > 0
                      ? numericTimestamp < 1_000_000_000_000
                        ? numericTimestamp * 1000
                        : numericTimestamp
                      : Number.isFinite(parsedTimestamp)
                        ? parsedTimestamp
                        : Date.now();
                  const wireMessage = parseAttachmentWireMessage(rawText);

                  if (wireMessage) {
                    const transferKey = `${rawSenderId}:${wireMessage.id}`;

                    if (wireMessage.kind === "start") {
                      if (
                        wireMessage.size < 0 ||
                        wireMessage.size > MAX_CHAT_ATTACHMENT_SIZE ||
                        wireMessage.totalChunks < 1 ||
                        wireMessage.totalChunks > 300
                      ) {
                        return;
                      }

                      incomingAttachmentsRef.current.set(transferKey, {
                        avatarUrl:
                          typeof sender?.getProperty?.("avatarURL") === "string"
                            ? String(sender.getProperty?.("avatarURL"))
                            : "",
                        chunks: new Array(wireMessage.totalChunks),
                        id: wireMessage.id,
                        mimeType:
                          wireMessage.mimeType || "application/octet-stream",
                        name: wireMessage.name.slice(0, 180) || "Вложение",
                        senderId: rawSenderId,
                        senderName: sender?.getDisplayName() || "Без имени",
                        size: wireMessage.size,
                        timestamp,
                        totalChunks: wireMessage.totalChunks,
                      });
                    } else if (wireMessage.kind === "chunk") {
                      const transfer =
                        incomingAttachmentsRef.current.get(transferKey);

                      if (
                        transfer &&
                        wireMessage.index >= 0 &&
                        wireMessage.index < transfer.totalChunks &&
                        wireMessage.data.length <=
                          ATTACHMENT_CHUNK_SIZE + 8
                      ) {
                        transfer.chunks[wireMessage.index] = wireMessage.data;
                      }
                    } else {
                      const transfer =
                        incomingAttachmentsRef.current.get(transferKey);

                      incomingAttachmentsRef.current.delete(transferKey);
                      if (
                        !transfer ||
                        transfer.chunks.some(
                          (chunk) => typeof chunk !== "string",
                        )
                      ) {
                        return;
                      }

                      const attachment: ChatAttachment = {
                        dataUrl: `data:${transfer.mimeType};base64,${transfer.chunks.join("")}`,
                        id: transfer.id,
                        mimeType: transfer.mimeType,
                        name: transfer.name,
                        size: transfer.size,
                      };

                      setChatMessages((messages) => [
                        ...messages,
                        {
                          attachments: [attachment],
                          avatarUrl: transfer.avatarUrl,
                          id: `${rawSenderId}-${transfer.id}`,
                          isLocal: false,
                          senderId: rawSenderId,
                          senderName: transfer.senderName,
                          text: "",
                          timestamp: transfer.timestamp,
                        },
                      ]);
                    }

                    return;
                  }

                  setChatMessages((messages) => [
                    ...messages,
                    {
                      avatarUrl:
                        typeof sender?.getProperty?.("avatarURL") === "string"
                          ? String(sender.getProperty?.("avatarURL"))
                          : "",
                      id: `${rawSenderId}-${timestamp}-${messages.length}`,
                      isLocal: false,
                      senderId: rawSenderId,
                      senderName: sender?.getDisplayName() || "Без имени",
                      text: rawText,
                      timestamp,
                    },
                  ]);
                },
              );
            }
            const localStatsEvent =
              library.events.connectionQuality?.LOCAL_STATS_UPDATED;
            const remoteStatsEvent =
              library.events.connectionQuality?.REMOTE_STATS_UPDATED;

            if (localStatsEvent) {
              conference.on(localStatsEvent, (rawStats) => {
                const quality =
                  rawStats &&
                  typeof rawStats === "object" &&
                  "connectionQuality" in rawStats &&
                  typeof rawStats.connectionQuality === "number"
                    ? rawStats.connectionQuality
                    : null;

                setConnectionStats((current) => ({
                  ...current,
                  [localIdRef.current]: {
                    pingMs: null,
                    quality,
                  },
                }));
              });
            }

            if (remoteStatsEvent) {
              conference.on(remoteStatsEvent, (rawId, rawStats) => {
                if (typeof rawId !== "string") {
                  return;
                }

                const quality =
                  rawStats &&
                  typeof rawStats === "object" &&
                  "connectionQuality" in rawStats &&
                  typeof rawStats.connectionQuality === "number"
                    ? rawStats.connectionQuality
                    : null;

                setConnectionStats((current) => ({
                  ...current,
                  [rawId]: {
                    pingMs: current[rawId]?.pingMs ?? null,
                    quality,
                  },
                }));
              });
            }
            if (conferenceEvents.TRACK_UNMUTE_REJECTED) {
              conference.on(
                conferenceEvents.TRACK_UNMUTE_REJECTED,
                () => {
                  setError(
                    "Сервер запретил включить медиапоток. Возможно, в комнате действует модерация.",
                  );
                  syncParticipants();
                },
              );
            }

            conference.on(conferenceEvents.CONNECTION_INTERRUPTED, () =>
              setStatus("reconnecting"),
            );
            conference.on(conferenceEvents.CONNECTION_RESTORED, () =>
              setStatus("joined"),
            );
            conference.on(conferenceEvents.CONFERENCE_JOINED, async () => {
              setStatus("joined");
              syncParticipants();
              window.setTimeout(sendPingRound, 1_000);
              if (pingIntervalRef.current !== null) {
                window.clearInterval(pingIntervalRef.current);
              }
              pingIntervalRef.current = window.setInterval(
                sendPingRound,
                5_000,
              );

              if (options.password && conference.isModerator()) {
                await conference.lock(options.password).catch(() => {
                  setError("Сервер не позволил установить пароль комнаты");
                });
              }
            });
            conference.on(
              conferenceEvents.CONFERENCE_FAILED,
              async (reason) => {
                const isPasswordError =
                  reason === "conference.passwordRequired";

                setError(
                  isPasswordError
                    ? "Комната защищена: пароль не подошёл"
                    : `Не удалось войти в комнату${
                        typeof reason === "string" ? `: ${reason}` : ""
                      }`,
                );
                setStatus("failed");
                await teardown();
              },
            );

            syncParticipants();
            conference.join(options.password);

            void initialTracksPromise.then(async (results) => {
              const isCurrentConference =
                !disposedRef.current &&
                conferenceRef.current === conference;

              if (!isCurrentConference) {
                await Promise.allSettled(
                  results.flatMap((result) =>
                    result.ok ? [result.track.dispose()] : [],
                  ),
                );
                setMediaBusy("audio", false);
                setMediaBusy("video", false);
                return;
              }

              const failures: string[] = [];

              for (const result of results) {
                if (!result.ok) {
                  failures.push(
                    mediaErrorMessage(result.device, result.error),
                  );
                  setMediaBusy(result.device, false);
                  continue;
                }

                try {
                  await conference.addTrack(result.track);
                } catch (publishError) {
                  await result.track.dispose().catch(() => undefined);
                  failures.push(
                    mediaErrorMessage(result.device, publishError),
                  );
                } finally {
                  setMediaBusy(result.device, false);
                }
              }

              syncParticipants();

              if (failures.length > 0) {
                setError(failures.join(" "));
              }
            });
          },
        );

        connection.addEventListener(
          connectionEvents.CONNECTION_FAILED,
          async (...eventArguments) => {
            const reason = eventArguments
              .filter((value) => typeof value === "string")
              .join(": ");

            setError(`Jitsi-сервер отклонил соединение${reason ? `: ${reason}` : ""}`);
            setStatus("failed");
            discardInitialTracks?.();
            await teardown();
          },
        );

        connection.addEventListener(
          connectionEvents.CONNECTION_DISCONNECTED,
          () => {
            if (!disposedRef.current) {
              setStatus("failed");
              setError("Соединение с Jitsi-сервером прервано");
            }
          },
        );

        connection.connect();
      } catch (caughtError) {
        discardInitialTracks?.();
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Не удалось запустить видеовстречу",
        );
        setStatus("failed");
        await teardown();
      }
    },
    [
      isDemo,
      roomName,
      scheduleParticipantSync,
      serverUrl,
      setMediaBusy,
      syncParticipants,
      teardown,
    ],
  );

  const toggleAudio = useCallback(async () => {
    if (isDemo) {
      setIsAudioMuted((muted) => {
        setParticipants((current) =>
          current.map((participant) =>
            participant.isLocal
              ? { ...participant, audioMuted: !muted }
              : participant,
          ),
        );
        return !muted;
      });
      return;
    }

    if (audioBusyRef.current) {
      return;
    }

    const conference = conferenceRef.current;
    const library = libraryRef.current;

    if (!conference || !library) {
      return;
    }

    setError(null);
    setMediaBusy("audio", true);

    try {
      const currentTrack = conference.getLocalTracks("audio").find(Boolean);

      if (currentTrack) {
        if (currentTrack.isMuted()) {
          await currentTrack.unmute();
        } else {
          await currentTrack.mute();
        }
      } else {
        const newTrack = await createLocalTrack(
          library,
          "audio",
          audioInputIdRef.current,
        );

        if (noiseSuppressionEnabledRef.current && newTrack.setEffect) {
          await newTrack.setEffect(
            new JitsiNoiseSuppressionEffect(
              new URL(
                "/libs/noise-suppressor-worklet.min.js",
                serverUrl,
              ).toString(),
            ),
          );
        }

        if (
          disposedRef.current ||
          conferenceRef.current !== conference
        ) {
          await newTrack.dispose();
          return;
        }

        try {
          await conference.addTrack(newTrack);
        } catch (publishError) {
          await newTrack.dispose().catch(() => undefined);
          throw publishError;
        }
      }
    } catch (caughtError) {
      setError(mediaErrorMessage("audio", caughtError));
    } finally {
      setMediaBusy("audio", false);
      syncParticipants();
    }
  }, [isDemo, serverUrl, setMediaBusy, syncParticipants]);

  const toggleVideo = useCallback(async () => {
    if (isDemo) {
      setIsVideoMuted((muted) => {
        setParticipants((current) =>
          current.map((participant) =>
            participant.isLocal
              ? { ...participant, videoMuted: !muted }
              : participant,
          ),
        );
        return !muted;
      });
      return;
    }

    if (videoBusyRef.current) {
      return;
    }

    const conference = conferenceRef.current;
    const library = libraryRef.current;

    if (!conference || !library) {
      return;
    }

    setError(null);
    setMediaBusy("video", true);

    try {
      const currentTrack = conference
        .getLocalTracks("video")
        .find((candidate) => candidate.getVideoType?.() !== "desktop");

      if (currentTrack) {
        if (currentTrack.isMuted()) {
          await currentTrack.unmute();
        } else {
          await currentTrack.mute();
        }
      } else {
        const newTrack = await createLocalTrack(
          library,
          "video",
          videoInputIdRef.current,
        );

        if (
          disposedRef.current ||
          conferenceRef.current !== conference
        ) {
          await newTrack.dispose();
          return;
        }

        try {
          await conference.addTrack(newTrack);
        } catch (publishError) {
          await newTrack.dispose().catch(() => undefined);
          throw publishError;
        }
      }
    } catch (caughtError) {
      setError(mediaErrorMessage("video", caughtError));
    } finally {
      setMediaBusy("video", false);
      syncParticipants();
    }
  }, [isDemo, setMediaBusy, syncParticipants]);

  const toggleScreenShare = useCallback(async () => {
    if (isDemo) {
      setIsScreenSharing((sharing) => {
        setParticipants((current) =>
          current.map((participant) =>
            participant.isLocal
              ? { ...participant, isScreenSharing: !sharing }
              : participant,
          ),
        );
        return !sharing;
      });
      return;
    }

    if (screenShareBusyRef.current) {
      return;
    }

    const conference = conferenceRef.current;
    const library = libraryRef.current;

    if (!conference || !library) {
      return;
    }

    setError(null);
    setMediaBusy("desktop", true);

    try {
      const currentDesktop = conference
        .getLocalTracks("video")
        .find((track) => track.getVideoType?.() === "desktop");

      if (currentDesktop) {
        desktopRemovalRef.current.add(currentDesktop);
        try {
          await conference.removeTrack(currentDesktop);
        } finally {
          await currentDesktop.dispose().catch(() => undefined);
        }
        return;
      }

      const desktopTrack = await createLocalTrack(library, "desktop");
      const stoppedEvent = library.events.track.LOCAL_TRACK_STOPPED;

      if (stoppedEvent) {
        desktopTrack.addEventListener?.(stoppedEvent, () => {
          if (desktopRemovalRef.current.has(desktopTrack)) {
            return;
          }

          desktopRemovalRef.current.add(desktopTrack);
          void (async () => {
            await conference
              .removeTrack(desktopTrack)
              .catch(() => undefined);
            await desktopTrack.dispose().catch(() => undefined);

            if (conferenceRef.current === conference) {
              syncParticipants();
            }
          })();
        });
      }

      if (
        disposedRef.current ||
        conferenceRef.current !== conference
      ) {
        desktopRemovalRef.current.add(desktopTrack);
        await desktopTrack.dispose();
        return;
      }

      try {
        await conference.addTrack(desktopTrack);
      } catch (publishError) {
        desktopRemovalRef.current.add(desktopTrack);
        await desktopTrack.dispose().catch(() => undefined);
        throw publishError;
      }
    } catch (caughtError) {
      setError(mediaErrorMessage("desktop", caughtError));
    } finally {
      setMediaBusy("desktop", false);
      syncParticipants();
    }
  }, [isDemo, setMediaBusy, syncParticipants]);

  const replaceInputTrack = useCallback(
    async (device: "audio" | "video", deviceId: string) => {
      if (device === "audio") {
        audioInputIdRef.current = deviceId;
        setAudioInputIdState(deviceId);
      } else {
        videoInputIdRef.current = deviceId;
        setVideoInputIdState(deviceId);
      }
      persistMediaPreferences();

      if (isDemo) {
        return;
      }

      const conference = conferenceRef.current;
      const library = libraryRef.current;

      if (!conference || !library) {
        return;
      }

      setError(null);
      setIsDeviceSwitchBusy(true);
      setMediaBusy(device, true);

      try {
        const oldTrack = conference
          .getLocalTracks(device)
          .find(
            (candidate) =>
              device === "audio" ||
              candidate.getVideoType?.() !== "desktop",
          );
        const newTrack = await createLocalTrack(library, device, deviceId);

        if (oldTrack?.isMuted()) {
          await newTrack.mute();
        }

        if (
          device === "audio" &&
          noiseSuppressionEnabledRef.current &&
          newTrack.setEffect
        ) {
          await newTrack.setEffect(
            new JitsiNoiseSuppressionEffect(
              new URL(
                "/libs/noise-suppressor-worklet.min.js",
                serverUrl,
              ).toString(),
            ),
          );
        }

        if (
          disposedRef.current ||
          conferenceRef.current !== conference
        ) {
          await newTrack.dispose();
          return;
        }

        try {
          if (oldTrack && conference.replaceTrack) {
            await conference.replaceTrack(oldTrack, newTrack);
          } else {
            await conference.addTrack(newTrack);
            if (oldTrack) {
              await conference.removeTrack(oldTrack);
            }
          }
        } catch (publishError) {
          await newTrack.dispose().catch(() => undefined);
          throw publishError;
        }

        await oldTrack?.dispose().catch(() => undefined);
      } catch (caughtError) {
        setError(mediaErrorMessage(device, caughtError));
      } finally {
        setMediaBusy(device, false);
        setIsDeviceSwitchBusy(false);
        syncParticipants();
      }
    },
    [
      isDemo,
      persistMediaPreferences,
      serverUrl,
      setMediaBusy,
      syncParticipants,
    ],
  );

  const setAudioInputDevice = useCallback(
    (deviceId: string) => replaceInputTrack("audio", deviceId),
    [replaceInputTrack],
  );

  const setVideoInputDevice = useCallback(
    (deviceId: string) => replaceInputTrack("video", deviceId),
    [replaceInputTrack],
  );

  const setNoiseSuppressionEnabled = useCallback(
    async (enabled: boolean) => {
      noiseSuppressionEnabledRef.current = enabled;
      setNoiseSuppressionState(enabled);
      persistMediaPreferences();

      if (isDemo) {
        return;
      }

      const audioTrack = conferenceRef.current
        ?.getLocalTracks("audio")
        .find(Boolean);

      if (!audioTrack?.setEffect) {
        if (enabled) {
          setNoiseSuppressionState(false);
          noiseSuppressionEnabledRef.current = false;
          persistMediaPreferences();
          setError(
            "Эта сборка Jitsi не поддерживает шумоподавление для аудиотрека.",
          );
        }
        return;
      }

      setError(null);
      setIsDeviceSwitchBusy(true);
      setMediaBusy("audio", true);

      try {
        await audioTrack.setEffect(
          enabled
            ? new JitsiNoiseSuppressionEffect(
                new URL(
                  "/libs/noise-suppressor-worklet.min.js",
                  serverUrl,
                ).toString(),
              )
            : undefined,
        );
      } catch {
        noiseSuppressionEnabledRef.current = !enabled;
        setNoiseSuppressionState(!enabled);
        persistMediaPreferences();
        setError("Не удалось переключить шумоподавление.");
      } finally {
        setMediaBusy("audio", false);
        setIsDeviceSwitchBusy(false);
      }
    },
    [isDemo, persistMediaPreferences, serverUrl, setMediaBusy],
  );

  const sendChatMessage = useCallback((rawText: string) => {
    const text = rawText.trim();

    if (!text) {
      return;
    }

    const conference = conferenceRef.current;

    if (!isDemo && !conference?.sendTextMessage) {
      setError("Чат недоступен в этой сборке Jitsi.");
      return;
    }

    conference?.sendTextMessage?.(text);
    setChatMessages((messages) => [
      ...messages,
      {
        avatarUrl: localAvatarRef.current,
        id: `local-${Date.now()}-${messages.length}`,
        isLocal: true,
        senderId: localIdRef.current,
        senderName: localNameRef.current,
        text,
        timestamp: Date.now(),
      },
    ]);
  }, [isDemo]);

  const sendChatAttachment = useCallback(
    async (file: File) => {
      if (file.size > MAX_CHAT_ATTACHMENT_SIZE) {
        setError("Вложение должно быть не больше 2 МБ.");
        return;
      }

      const conference = conferenceRef.current;

      if (!isDemo && !conference?.sendTextMessage) {
        setError("Вложения недоступны в этой сборке Jitsi.");
        return;
      }

      setError(null);
      setIsSendingAttachment(true);

      try {
        const dataUrl = await readFileAsDataUrl(file);
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const attachmentId =
          globalThis.crypto?.randomUUID?.() ??
          `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const attachment: ChatAttachment = {
          dataUrl,
          id: attachmentId,
          mimeType: file.type || "application/octet-stream",
          name: file.name || "Вложение",
          size: file.size,
        };

        setChatMessages((messages) => [
          ...messages,
          {
            attachments: [attachment],
            avatarUrl: localAvatarRef.current,
            id: `local-${attachmentId}`,
            isLocal: true,
            senderId: localIdRef.current,
            senderName: localNameRef.current,
            text: "",
            timestamp: Date.now(),
          },
        ]);

        if (isDemo) {
          return;
        }

        const chunks = Array.from(
          {
            length: Math.max(
              1,
              Math.ceil(base64.length / ATTACHMENT_CHUNK_SIZE),
            ),
          },
          (_, index) =>
            base64.slice(
              index * ATTACHMENT_CHUNK_SIZE,
              (index + 1) * ATTACHMENT_CHUNK_SIZE,
            ),
        );

        conference?.sendTextMessage?.(
          attachmentMessage({
            id: attachmentId,
            kind: "start",
            mimeType: attachment.mimeType,
            name: attachment.name,
            size: attachment.size,
            totalChunks: chunks.length,
          }),
        );

        for (let index = 0; index < chunks.length; index += 1) {
          conference?.sendTextMessage?.(
            attachmentMessage({
              data: chunks[index],
              id: attachmentId,
              index,
              kind: "chunk",
            }),
          );

          if (index > 0 && index % 20 === 0) {
            await new Promise<void>((resolve) =>
              window.setTimeout(resolve, 0),
            );
          }
        }

        conference?.sendTextMessage?.(
          attachmentMessage({
            id: attachmentId,
            kind: "end",
          }),
        );
      } catch {
        setError("Не удалось отправить вложение.");
      } finally {
        setIsSendingAttachment(false);
      }
    },
    [isDemo],
  );

  const leave = useCallback(async () => {
    if (!isDemo) {
      await teardown();
    }
    setParticipants([]);
    setChatMessages([]);
    setConnectionStats({});
    incomingAttachmentsRef.current.clear();
    setLocalAudioLevel(0);
    setStatus("left");
  }, [isDemo, teardown]);

  useEffect(
    () => () => {
      if (!isDemo) {
        void teardown();
      }
    },
    [isDemo, teardown],
  );

  const participantConnections = participants.map<ParticipantConnectionInfo>(
    (participant, index) => {
      const stats = connectionStats[participant.id];

      return {
        displayName: participant.displayName,
        id: participant.id,
        isLocal: participant.isLocal,
        pingMs:
          stats?.pingMs ??
          (isDemo && !participant.isLocal ? 18 + index * 7 : null),
        quality: stats?.quality ?? (isDemo ? 92 - index * 5 : null),
      };
    },
  );

  return {
    audioInputId,
    chatMessages,
    error,
    isAudioBusy,
    isAudioMuted,
    isDemo,
    isDeviceSwitchBusy,
    isSendingAttachment,
    isScreenShareBusy,
    isScreenSharing,
    isVideoBusy,
    isVideoMuted,
    localAudioLevel,
    noiseSuppressionEnabled,
    noiseSuppressionSupported,
    participantConnections,
    sendChatAttachment,
    sendChatMessage,
    setAudioInputDevice,
    setNoiseSuppressionEnabled,
    setVideoInputDevice,
    join,
    leave,
    participants,
    status,
    toggleAudio,
    toggleScreenShare,
    toggleVideo,
    videoInputId,
  };
}
