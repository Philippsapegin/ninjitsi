"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useJitsiServerUrl } from "@/lib/runtimeConfig";
import { getStoredLocale, localize } from "@/lib/i18n";
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
  ChatReplyReference,
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
  isCreator: boolean;
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
  sendChatAttachment: (
    file: File,
    recipientIds?: string[],
  ) => Promise<void>;
  sendChatMessage: (
    text: string,
    recipientIds?: string[],
    replyTo?: ChatReplyReference,
  ) => void;
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

const ATTACHMENT_MESSAGE_PREFIX = "__ninjitsi_attachment_v1__:";
const CHAT_TEXT_MESSAGE_PREFIX = "__ninjitsi_chat_v2__:";
const PING_MESSAGE_PREFIX = "__ninjitsi_ping_v1__:";
const PRIVATE_CHAT_MESSAGE_TYPE = "ninjitsi.private-chat.v1";
const ATTACHMENT_CHUNK_SIZE = 12_000;
const MAX_RECONNECT_DELAY = 15_000;
const RECOVERABLE_CONFERENCE_ERRORS = new Set([
  "conference.connectionError",
  "conference.focusDisconnected",
  "conference.focusLeft",
  "conference.iceFailed",
  "conference.offerAnswerFailed",
  "conference.videobridgeNotAvailable",
]);
export const MAX_CHAT_ATTACHMENT_SIZE = 2 * 1024 * 1024;

function ui(english: string, russian: string) {
  return localize(getStoredLocale(), english, russian);
}

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
  isPrivate: boolean;
  mimeType: string;
  name: string;
  recipientNames: string[];
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

interface PrivateChatWireMessage {
  message: string;
  recipientNames: string[];
  timestamp: number;
  type: typeof PRIVATE_CHAT_MESSAGE_TYPE;
}

interface ChatTextWireMessage {
  replyTo?: ChatReplyReference;
  text: string;
}

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

function normalizeReplyReference(
  value: unknown,
): ChatReplyReference | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("messageId" in value) ||
    typeof value.messageId !== "string" ||
    !("senderName" in value) ||
    typeof value.senderName !== "string" ||
    !("text" in value) ||
    typeof value.text !== "string"
  ) {
    return undefined;
  }

  return {
    messageId: value.messageId.slice(0, 180),
    senderName: value.senderName.slice(0, 180),
    text: value.text.slice(0, 320),
  };
}

function chatTextMessage(
  text: string,
  replyTo?: ChatReplyReference,
) {
  if (!replyTo) {
    return text;
  }

  return `${CHAT_TEXT_MESSAGE_PREFIX}${JSON.stringify({
    replyTo: normalizeReplyReference(replyTo),
    text,
  } satisfies ChatTextWireMessage)}`;
}

function parseChatTextMessage(text: string): ChatTextWireMessage {
  if (!text.startsWith(CHAT_TEXT_MESSAGE_PREFIX)) {
    return { text };
  }

  try {
    const parsed = JSON.parse(
      text.slice(CHAT_TEXT_MESSAGE_PREFIX.length),
    ) as unknown;

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("text" in parsed) ||
      typeof parsed.text !== "string"
    ) {
      return { text };
    }

    return {
      replyTo:
        "replyTo" in parsed
          ? normalizeReplyReference(parsed.replyTo)
          : undefined,
      text: parsed.text.slice(0, 4000),
    };
  } catch {
    return { text };
  }
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

function parsePrivateChatWireMessage(
  payload: unknown,
): PrivateChatWireMessage | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("type" in payload) ||
    payload.type !== PRIVATE_CHAT_MESSAGE_TYPE ||
    !("message" in payload) ||
    typeof payload.message !== "string" ||
    !("timestamp" in payload) ||
    typeof payload.timestamp !== "number" ||
    !("recipientNames" in payload) ||
    !Array.isArray(payload.recipientNames)
  ) {
    return null;
  }

  return {
    message: payload.message,
    recipientNames: payload.recipientNames
      .filter((name): name is string => typeof name === "string")
      .slice(0, 30),
    timestamp: payload.timestamp,
    type: PRIVATE_CHAT_MESSAGE_TYPE,
  };
}

function deliverChatWireMessage(
  conference: JitsiConferenceLike,
  message: string,
  recipients: Array<{ id: string; name: string }>,
  timestamp: number,
) {
  if (recipients.length === 0) {
    conference.sendTextMessage?.(message);
    return;
  }

  const payload: PrivateChatWireMessage = {
    message,
    recipientNames: recipients.map((recipient) => recipient.name),
    timestamp,
    type: PRIVATE_CHAT_MESSAGE_TYPE,
  };

  recipients.forEach((recipient) => {
    if (conference.sendMessage) {
      conference.sendMessage(payload, recipient.id, false);
    } else {
      conference.sendEndpointMessage?.(recipient.id, payload);
    }
  });
}

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(
          new Error(
            ui("Could not read the attachment", "Не удалось прочитать вложение"),
          ),
        );
      }
    });
    reader.addEventListener("error", () =>
      reject(
        reader.error ??
          new Error(
            ui("Could not read the attachment", "Не удалось прочитать вложение"),
          ),
      ),
    );
    reader.readAsDataURL(file);
  });
}

function mediaName(device: LocalMediaDevice) {
  if (device === "audio") {
    return ui("microphone", "микрофон");
  }

  return device === "video"
    ? ui("camera", "камеру")
    : ui("screen sharing", "демонстрацию экрана");
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
    return ui(
      `Chrome does not have permission to use the ${target}. Allow access in the address bar.`,
      `Нет разрешения на ${target}. Разрешите доступ в адресной строке Chrome.`,
    );
  }

  if (
    normalized.includes("notfound") ||
    normalized.includes("devicesnotfound") ||
    normalized.includes("no device")
  ) {
    return ui(
      `Could not find the ${target}. Check that the device is connected.`,
      `Не удалось найти ${target}. Проверьте подключение устройства.`,
    );
  }

  if (
    normalized.includes("notreadable") ||
    normalized.includes("trackstart") ||
    normalized.includes("could not start")
  ) {
    return ui(
      `Could not start the ${target}; another application may be using it.`,
      `Не удалось запустить ${target}: возможно, устройство занято другим приложением.`,
    );
  }

  if (
    device === "desktop" &&
    (normalized.includes("abort") || normalized.includes("cancel"))
  ) {
    return ui("Screen selection was cancelled.", "Выбор экрана отменён.");
  }

  return ui(
    `Could not connect the ${target}.`,
    `Не удалось подключить ${target}.`,
  );
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
  const people = [
    displayName,
    ui("Laura K.", "Лера К."),
    ui("Michael", "Михаил"),
    ui("Tanya", "Таня"),
    ui("Kostya", "Костя"),
    ui("Anna", "Анна"),
    ui("Sergey", "Сергей"),
  ];

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
  const localNameRef = useRef(ui("You", "Вы"));
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
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectInProgressRef = useRef(false);
  const recoveringSessionRef = useRef(false);
  const hasJoinedRef = useRef(false);
  const intentionalLeaveRef = useRef(false);
  const lastJoinOptionsRef = useRef<JoinOptions | null>(null);
  const joinRef = useRef<((options: JoinOptions) => Promise<void>) | null>(
    null,
  );

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
          displayName:
            participant.getDisplayName() || ui("Unnamed participant", "Без имени"),
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

  const scheduleFullReconnect = useCallback(
    async () => {
      if (
        intentionalLeaveRef.current ||
        reconnectInProgressRef.current ||
        !lastJoinOptionsRef.current
      ) {
        return;
      }

      const currentTracks = conferenceRef.current?.getLocalTracks() ?? [];
      const currentAudio = currentTracks.find(
        (track) => track.getType() === "audio",
      );
      const currentCamera = currentTracks.find(
        (track) =>
          track.getType() === "video" &&
          track.getVideoType?.() !== "desktop",
      );

      if (currentTracks.length > 0) {
        lastJoinOptionsRef.current = {
          ...lastJoinOptionsRef.current,
          startAudioMuted: !currentAudio || currentAudio.isMuted(),
          startVideoMuted: !currentCamera || currentCamera.isMuted(),
        };
      }
      reconnectInProgressRef.current = true;
      recoveringSessionRef.current = true;
      setError(null);
      setStatus("reconnecting");
      await teardown();

      if (intentionalLeaveRef.current) {
        reconnectInProgressRef.current = false;
        return;
      }

      const delay = Math.min(
        MAX_RECONNECT_DELAY,
        1_000 * 2 ** Math.min(reconnectAttemptRef.current, 4),
      );
      const options = lastJoinOptionsRef.current;

      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        reconnectInProgressRef.current = false;

        if (!intentionalLeaveRef.current && options) {
          void joinRef.current?.(options);
        }
      }, delay);
    },
    [teardown],
  );

  const join = useCallback(
    async (options: JoinOptions) => {
      const isRecovery = recoveringSessionRef.current;

      lastJoinOptionsRef.current = options;
      intentionalLeaveRef.current = false;
      setError(null);
      localNameRef.current = options.displayName;
      localAvatarRef.current = options.avatarDataUrl;
      disposedRef.current = false;
      if (!isRecovery) {
        hasJoinedRef.current = false;
        reconnectAttemptRef.current = 0;
        setChatMessages([]);
        setConnectionStats({});
        incomingAttachmentsRef.current.clear();
      }

      if (isDemo) {
        setStatus(isRecovery ? "reconnecting" : "loading");
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

      setStatus(isRecovery ? "reconnecting" : "loading");
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
        setStatus(isRecovery ? "reconnecting" : "connecting");

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

            const receiveChatText = (
              rawSenderId: string,
              rawText: string,
              rawTimestamp: unknown,
              isPrivate = false,
              recipientNames: string[] = [],
            ) => {
              if (rawSenderId === localIdRef.current) {
                return;
              }

              const pingWireMessage = isPrivate
                ? null
                : parsePingWireMessage(rawText);

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
                    isPrivate,
                    mimeType:
                      wireMessage.mimeType || "application/octet-stream",
                    name:
                      wireMessage.name.slice(0, 180) ||
                      ui("Attachment", "Вложение"),
                    recipientNames,
                    senderId: rawSenderId,
                    senderName:
                      sender?.getDisplayName() ||
                      ui("Unnamed participant", "Без имени"),
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
                      isPrivate: transfer.isPrivate,
                      recipientNames: transfer.recipientNames,
                      senderId: rawSenderId,
                      senderName: transfer.senderName,
                      text: "",
                      timestamp: transfer.timestamp,
                    },
                  ]);
                }

                return;
              }

              const chatText = parseChatTextMessage(rawText);

              setChatMessages((messages) => [
                ...messages,
                {
                  avatarUrl:
                    typeof sender?.getProperty?.("avatarURL") === "string"
                      ? String(sender.getProperty?.("avatarURL"))
                      : "",
                  id: `${rawSenderId}-${timestamp}-${messages.length}`,
                  isLocal: false,
                  isPrivate,
                  recipientNames,
                  replyTo: chatText.replyTo,
                  senderId: rawSenderId,
                  senderName:
                    sender?.getDisplayName() ||
                    ui("Unnamed participant", "Без имени"),
                  text: chatText.text,
                  timestamp,
                },
              ]);
            };

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

                  receiveChatText(rawSenderId, rawText, rawTimestamp);
                },
              );
            }
            if (conferenceEvents.ENDPOINT_MESSAGE_RECEIVED) {
              conference.on(
                conferenceEvents.ENDPOINT_MESSAGE_RECEIVED,
                (rawParticipant, rawPayload) => {
                  const privateMessage =
                    parsePrivateChatWireMessage(rawPayload);
                  const senderId =
                    typeof rawParticipant === "string"
                      ? rawParticipant
                      : rawParticipant &&
                          typeof rawParticipant === "object" &&
                          "getId" in rawParticipant &&
                          typeof rawParticipant.getId === "function"
                        ? rawParticipant.getId()
                        : null;

                  if (!privateMessage || typeof senderId !== "string") {
                    return;
                  }

                  receiveChatText(
                    senderId,
                    privateMessage.message,
                    privateMessage.timestamp,
                    true,
                    privateMessage.recipientNames,
                  );
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
                    ui(
                      "The server blocked this media track. Media moderation may be enabled for the room.",
                      "Сервер запретил включить медиапоток. Возможно, в комнате действует модерация.",
                    ),
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
              hasJoinedRef.current = true;
              reconnectAttemptRef.current = 0;
              reconnectInProgressRef.current = false;
              recoveringSessionRef.current = false;
              setError(null);
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
                  setError(
                    ui(
                      "The server did not allow the room password to be set.",
                      "Сервер не позволил установить пароль комнаты",
                    ),
                  );
                });
              }
            });
            conference.on(
              conferenceEvents.CONFERENCE_FAILED,
              async (reason) => {
                if (
                  disposedRef.current ||
                  conferenceRef.current !== conference
                ) {
                  return;
                }

                const isPasswordError =
                  reason === "conference.passwordRequired";
                const isRecoverable =
                  hasJoinedRef.current &&
                  typeof reason === "string" &&
                  RECOVERABLE_CONFERENCE_ERRORS.has(reason);

                if (isRecoverable) {
                  await scheduleFullReconnect();
                  return;
                }

                setError(
                  isPasswordError
                    ? ui(
                        "The room is protected: the password is incorrect.",
                        "Комната защищена: пароль не подошёл",
                      )
                    : `${ui(
                        "Could not join the room",
                        "Не удалось войти в комнату",
                      )}${
                        typeof reason === "string" ? `: ${reason}` : ""
                      }`,
                );
                recoveringSessionRef.current = false;
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
            if (
              disposedRef.current ||
              connectionRef.current !== connection
            ) {
              return;
            }

            if (hasJoinedRef.current) {
              discardInitialTracks?.();
              await scheduleFullReconnect();
              return;
            }

            const reason = eventArguments
              .filter((value) => typeof value === "string")
              .join(": ");

            setError(
              `${ui(
                "The Jitsi server rejected the connection",
                "Jitsi-сервер отклонил соединение",
              )}${reason ? `: ${reason}` : ""}`,
            );
            setStatus("failed");
            recoveringSessionRef.current = false;
            discardInitialTracks?.();
            await teardown();
          },
        );

        connection.addEventListener(
          connectionEvents.CONNECTION_DISCONNECTED,
          () => {
            if (
              disposedRef.current ||
              connectionRef.current !== connection
            ) {
              return;
            }

            if (hasJoinedRef.current) {
              void scheduleFullReconnect();
            } else {
              recoveringSessionRef.current = false;
              setStatus("failed");
              setError(
                ui(
                  "The connection to the Jitsi server was interrupted.",
                  "Соединение с Jitsi-сервером прервано",
                ),
              );
            }
          },
        );

        connection.connect();
      } catch (caughtError) {
        discardInitialTracks?.();

        if (
          recoveringSessionRef.current &&
          !intentionalLeaveRef.current
        ) {
          await scheduleFullReconnect();
          return;
        }

        setError(
          caughtError instanceof Error
            ? caughtError.message
            : ui(
                "Could not start the video meeting.",
                "Не удалось запустить видеовстречу",
              ),
        );
        recoveringSessionRef.current = false;
        setStatus("failed");
        await teardown();
      }
    },
    [
      isDemo,
      roomName,
      scheduleParticipantSync,
      scheduleFullReconnect,
      serverUrl,
      setMediaBusy,
      syncParticipants,
      teardown,
    ],
  );

  useEffect(() => {
    joinRef.current = join;
  }, [join]);

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
            ui(
              "This Jitsi build does not support noise suppression for audio tracks.",
              "Эта сборка Jitsi не поддерживает шумоподавление для аудиотрека.",
            ),
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
        setError(
          ui(
            "Could not switch noise suppression.",
            "Не удалось переключить шумоподавление.",
          ),
        );
      } finally {
        setMediaBusy("audio", false);
        setIsDeviceSwitchBusy(false);
      }
    },
    [isDemo, persistMediaPreferences, serverUrl, setMediaBusy],
  );

  const sendChatMessage = useCallback(
    (
      rawText: string,
      recipientIds: string[] = [],
      replyTo?: ChatReplyReference,
    ) => {
      const text = rawText.trim();

      if (!text) {
        return;
      }

      const conference = conferenceRef.current;
      const requestedRecipientIds = new Set(recipientIds);
      const recipients = participants
        .filter(
          (participant) =>
            !participant.isLocal &&
            requestedRecipientIds.has(participant.id),
        )
        .map((participant) => ({
          id: participant.id,
          name: participant.displayName,
        }));
      const isPrivate = requestedRecipientIds.size > 0;

      if (isPrivate && recipients.length === 0) {
        setError(
          ui(
            "The selected recipients have already left the meeting.",
            "Выбранные получатели уже покинули встречу.",
          ),
        );
        return;
      }

      if (
        !isDemo &&
        (isPrivate
          ? !conference?.sendMessage &&
            !conference?.sendEndpointMessage
          : !conference?.sendTextMessage)
      ) {
        setError(
          isPrivate
            ? ui(
                "Private messages are unavailable in this Jitsi build.",
                "Личные сообщения недоступны в этой сборке Jitsi.",
              )
            : ui(
                "Chat is unavailable in this Jitsi build.",
                "Чат недоступен в этой сборке Jitsi.",
              ),
        );
        return;
      }

      const timestamp = Date.now();

      if (!isDemo && conference) {
        deliverChatWireMessage(
          conference,
          chatTextMessage(text, replyTo),
          recipients,
          timestamp,
        );
      }
      setChatMessages((messages) => [
        ...messages,
        {
          avatarUrl: localAvatarRef.current,
          id: `local-${timestamp}-${messages.length}`,
          isLocal: true,
          isPrivate,
          recipientNames: recipients.map((recipient) => recipient.name),
          replyTo: normalizeReplyReference(replyTo),
          senderId: localIdRef.current,
          senderName: localNameRef.current,
          text,
          timestamp,
        },
      ]);
    },
    [isDemo, participants],
  );

  const sendChatAttachment = useCallback(
    async (file: File, recipientIds: string[] = []) => {
      if (file.size > MAX_CHAT_ATTACHMENT_SIZE) {
        setError(
          ui(
            "Attachments must not exceed 2 MB.",
            "Вложение должно быть не больше 2 МБ.",
          ),
        );
        return;
      }

      const conference = conferenceRef.current;
      const requestedRecipientIds = new Set(recipientIds);
      const recipients = participants
        .filter(
          (participant) =>
            !participant.isLocal &&
            requestedRecipientIds.has(participant.id),
        )
        .map((participant) => ({
          id: participant.id,
          name: participant.displayName,
        }));
      const isPrivate = requestedRecipientIds.size > 0;

      if (isPrivate && recipients.length === 0) {
        setError(
          ui(
            "The selected recipients have already left the meeting.",
            "Выбранные получатели уже покинули встречу.",
          ),
        );
        return;
      }

      if (
        !isDemo &&
        (isPrivate
          ? !conference?.sendMessage &&
            !conference?.sendEndpointMessage
          : !conference?.sendTextMessage)
      ) {
        setError(
          isPrivate
            ? ui(
                "Private attachments are unavailable in this Jitsi build.",
                "Личные вложения недоступны в этой сборке Jitsi.",
              )
            : ui(
                "Attachments are unavailable in this Jitsi build.",
                "Вложения недоступны в этой сборке Jitsi.",
              ),
        );
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
          name: file.name || ui("Attachment", "Вложение"),
          size: file.size,
        };
        const timestamp = Date.now();

        setChatMessages((messages) => [
          ...messages,
          {
            attachments: [attachment],
            avatarUrl: localAvatarRef.current,
            id: `local-${attachmentId}`,
            isLocal: true,
            isPrivate,
            recipientNames: recipients.map((recipient) => recipient.name),
            senderId: localIdRef.current,
            senderName: localNameRef.current,
            text: "",
            timestamp,
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

        deliverChatWireMessage(
          conference!,
          attachmentMessage({
            id: attachmentId,
            kind: "start",
            mimeType: attachment.mimeType,
            name: attachment.name,
            size: attachment.size,
            totalChunks: chunks.length,
          }),
          recipients,
          timestamp,
        );

        for (let index = 0; index < chunks.length; index += 1) {
          deliverChatWireMessage(
            conference!,
            attachmentMessage({
              data: chunks[index],
              id: attachmentId,
              index,
              kind: "chunk",
            }),
            recipients,
            timestamp,
          );

          if (index > 0 && index % 20 === 0) {
            await new Promise<void>((resolve) =>
              window.setTimeout(resolve, 0),
            );
          }
        }

        deliverChatWireMessage(
          conference!,
          attachmentMessage({
            id: attachmentId,
            kind: "end",
          }),
          recipients,
          timestamp,
        );
      } catch {
        setError(
          ui(
            "Could not send the attachment.",
            "Не удалось отправить вложение.",
          ),
        );
      } finally {
        setIsSendingAttachment(false);
      }
    },
    [isDemo, participants],
  );

  const leave = useCallback(async () => {
    intentionalLeaveRef.current = true;
    recoveringSessionRef.current = false;
    reconnectInProgressRef.current = false;
    hasJoinedRef.current = false;
    lastJoinOptionsRef.current = null;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
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
      intentionalLeaveRef.current = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
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
        quality:
          stats?.quality ?? (isDemo ? Math.max(8, 92 - index * 14) : null),
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
