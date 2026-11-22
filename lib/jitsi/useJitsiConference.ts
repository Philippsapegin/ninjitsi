"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useJitsiServerUrl } from "@/lib/runtimeConfig";
import { getStoredLocale, localize } from "@/lib/i18n";
import {
  DEFAULT_PROFILE_TILE_COLOR,
  MAX_VIDEO_BACKGROUND_FILE_SIZE,
  normalizeProfileTileColor,
} from "@/lib/profiles";
import { loadJitsiRuntime } from "./loader";
import { currentParticipantSessions, nextParticipantSession, SESSION_PROPERTY } from "./participantSessions";
import {
  readMediaPreferences,
  readPushToTalkPreference,
  saveMediaPreferences,
} from "./mediaPreferences";
import { isNoiseSuppressionSupported } from "./noiseSuppression";
import { createLocalTrack, isMediaPermissionError } from "./mediaDevices";
import { CameraOperations } from "./cameraOperations";
import {
  applyReceiveVideoPolicy,
  CAMERA_OFF_PROPERTY,
  isCameraOff,
  isTrackEnded,
  pickPreferredVideo,
  SCREEN_SHARING_PROPERTY,
  VIDEO_RECOVERY_EVENT,
} from "./videoPolicy";
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
  jitsiToken?: string | null;
  password: string;
  profileId: string;
  startAudioMuted: boolean;
  startVideoMuted: boolean;
  tileColor: string;
  videoBackgroundDataUrl: string;
  videoBackgroundRevision: string;
}

interface ConferenceController {
  audioInputId: string;
  audioOutputId: string;
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
  isVideoStarting: boolean;
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
  setAudioOutputDevice: (deviceId: string) => Promise<void>;
  setNoiseSuppressionEnabled: (enabled: boolean) => Promise<void>;
  setVideoInputDevice: (deviceId: string) => Promise<void>;
  setVideoBackgroundEnabled: (enabled: boolean) => Promise<void>;
  join: (options: JoinOptions) => Promise<void>;
  leave: () => Promise<void>;
  participants: ParticipantView[];
  status: MeetingStatus;
  toggleAudio: () => Promise<void>;
  setAudioMuted: (muted: boolean, pushToTalk?: boolean) => Promise<void>;
  readAudioReceiverStats: (track: MediaStreamTrack) => Promise<RTCStatsReport | undefined>;
  toggleScreenShare: () => Promise<void>;
  toggleVideo: () => Promise<void>;
  videoInputId: string;
  videoBackgroundAvailable: boolean;
  videoBackgroundEnabled: boolean;
}

const ATTACHMENT_MESSAGE_PREFIX = "__ninjitsi_attachment_v1__:";
const ATTACHMENT_DATA_MESSAGE_TYPE = "ninjitsi.attachment-data.v2";
const CHAT_TEXT_MESSAGE_PREFIX = "__ninjitsi_chat_v2__:";
const PING_MESSAGE_PREFIX = "__ninjitsi_ping_v1__:";
const PRIVATE_CHAT_MESSAGE_TYPE = "ninjitsi.private-chat.v1";
const VIDEO_BACKGROUND_MESSAGE_TYPE = "ninjitsi.video-background.v1";
const VIDEO_BACKGROUND_ENABLED_PROPERTY = "ninjitsiVideoBackgroundEnabled";
const MICROPHONE_MUTED_PROPERTY = "ninjitsiMicrophoneMuted";
const VIDEO_BACKGROUND_REVISION_PROPERTY = "ninjitsiVideoBackgroundRevision";
const TILE_COLOR_PROPERTY = "ninjitsiTileColor";
const ATTACHMENT_CHUNK_SIZE = 12_000;
const VIDEO_BACKGROUND_CHUNK_SIZE = 12_000;
const MAX_VIDEO_BACKGROUND_DATA_LENGTH =
  Math.ceil((MAX_VIDEO_BACKGROUND_FILE_SIZE * 4) / 3) + 256;
const MAX_VIDEO_BACKGROUND_CHUNKS = Math.ceil(
  MAX_VIDEO_BACKGROUND_DATA_LENGTH / VIDEO_BACKGROUND_CHUNK_SIZE,
);
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

interface AttachmentDataWireMessage {
  attachment: AttachmentWireMessage;
  recipientIds: string[];
  recipientNames: string[];
  timestamp: number;
  type: typeof ATTACHMENT_DATA_MESSAGE_TYPE;
}

interface IncomingAttachment {
  avatarUrl: string;
  chunks: string[];
  id: string;
  isPrivate: boolean;
  mimeType: string;
  name: string;
  recipientIds: string[];
  recipientNames: string[];
  senderId: string;
  senderName: string;
  size: number;
  timestamp: number;
  totalChunks: number;
}

type VideoBackgroundWireMessage =
  | {
      kind: "start";
      revision: string;
      totalChunks: number;
      type: typeof VIDEO_BACKGROUND_MESSAGE_TYPE;
    }
  | {
      data: string;
      index: number;
      kind: "chunk";
      revision: string;
      type: typeof VIDEO_BACKGROUND_MESSAGE_TYPE;
    }
  | {
      kind: "end";
      revision: string;
      type: typeof VIDEO_BACKGROUND_MESSAGE_TYPE;
    };

interface IncomingVideoBackground {
  chunks: string[];
  revision: string;
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
  recipientIds: string[];
  recipientNames: string[];
  timestamp: number;
  type: typeof PRIVATE_CHAT_MESSAGE_TYPE;
}

interface ChatTextWireMessage {
  id?: string;
  replyTo?: ChatReplyReference;
  text: string;
}

type LocalMediaDevice = "audio" | "video" | "desktop";

function parseAttachmentWireMessage(text: string) {
  if (!text.startsWith(ATTACHMENT_MESSAGE_PREFIX)) {
    return null;
  }

  try {
    return normalizeAttachmentWireMessage(
      JSON.parse(text.slice(ATTACHMENT_MESSAGE_PREFIX.length)),
    );
  } catch {
    return null;
  }
}

function normalizeAttachmentWireMessage(
  payload: unknown,
): AttachmentWireMessage | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("id" in payload) ||
    typeof payload.id !== "string" ||
    !("kind" in payload) ||
    typeof payload.kind !== "string"
  ) {
    return null;
  }

  const id = payload.id.slice(0, 180);

  if (!id) {
    return null;
  }

  if (
    payload.kind === "start" &&
    "mimeType" in payload &&
    typeof payload.mimeType === "string" &&
    "name" in payload &&
    typeof payload.name === "string" &&
    "size" in payload &&
    typeof payload.size === "number" &&
    Number.isInteger(payload.size) &&
    payload.size >= 0 &&
    payload.size <= MAX_CHAT_ATTACHMENT_SIZE &&
    "totalChunks" in payload &&
    typeof payload.totalChunks === "number" &&
    Number.isInteger(payload.totalChunks) &&
    payload.totalChunks >= 1 &&
    payload.totalChunks <= 300
  ) {
    return {
      id,
      kind: "start",
      mimeType: payload.mimeType.slice(0, 180),
      name: payload.name.slice(0, 180),
      size: payload.size,
      totalChunks: payload.totalChunks,
    };
  }

  if (
    payload.kind === "chunk" &&
    "data" in payload &&
    typeof payload.data === "string" &&
    payload.data.length <= ATTACHMENT_CHUNK_SIZE + 8 &&
    "index" in payload &&
    typeof payload.index === "number" &&
    Number.isInteger(payload.index) &&
    payload.index >= 0 &&
    payload.index < 300
  ) {
    return {
      data: payload.data,
      id,
      index: payload.index,
      kind: "chunk",
    };
  }

  return payload.kind === "end" ? { id, kind: "end" } : null;
}

function attachmentMessage(message: AttachmentWireMessage) {
  return `${ATTACHMENT_MESSAGE_PREFIX}${JSON.stringify(message)}`;
}

function parseAttachmentDataWireMessage(
  payload: unknown,
): AttachmentDataWireMessage | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("type" in payload) ||
    payload.type !== ATTACHMENT_DATA_MESSAGE_TYPE ||
    !("attachment" in payload) ||
    !("timestamp" in payload) ||
    typeof payload.timestamp !== "number" ||
    !Number.isFinite(payload.timestamp)
  ) {
    return null;
  }

  const attachment = normalizeAttachmentWireMessage(payload.attachment);

  if (!attachment) {
    return null;
  }

  return {
    attachment,
    recipientIds:
      "recipientIds" in payload && Array.isArray(payload.recipientIds)
        ? payload.recipientIds
            .filter((id): id is string => typeof id === "string")
            .slice(0, 30)
        : [],
    recipientNames:
      "recipientNames" in payload && Array.isArray(payload.recipientNames)
        ? payload.recipientNames
            .filter((name): name is string => typeof name === "string")
            .slice(0, 30)
        : [],
    timestamp: payload.timestamp,
    type: ATTACHMENT_DATA_MESSAGE_TYPE,
  };
}

function deliverAttachmentDataWireMessage(
  conference: JitsiConferenceLike,
  attachment: AttachmentWireMessage,
  recipients: Array<{ id: string; name: string }>,
  timestamp: number,
) {
  if (!conference.sendMessage) {
    return false;
  }

  const payload: AttachmentDataWireMessage = {
    attachment,
    recipientIds: recipients.map((recipient) => recipient.id),
    recipientNames: recipients.map((recipient) => recipient.name),
    timestamp,
    type: ATTACHMENT_DATA_MESSAGE_TYPE,
  };
  const targets =
    recipients.length > 0
      ? recipients.map((recipient) => recipient.id)
      : [""];

  try {
    targets.forEach((participantId) => {
      conference.sendMessage?.(payload, participantId, true);
    });
    return true;
  } catch (caughtError) {
    console.warn(
      "Ninjitsi: attachment data channel unavailable; using chat transport",
      caughtError,
    );
    return false;
  }
}

function parseVideoBackgroundWireMessage(
  payload: unknown,
): VideoBackgroundWireMessage | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("type" in payload) ||
    payload.type !== VIDEO_BACKGROUND_MESSAGE_TYPE ||
    !("kind" in payload) ||
    typeof payload.kind !== "string" ||
    !("revision" in payload) ||
    typeof payload.revision !== "string" ||
    payload.revision.length < 1 ||
    payload.revision.length > 180
  ) {
    return null;
  }

  if (
    payload.kind === "start" &&
    "totalChunks" in payload &&
    typeof payload.totalChunks === "number" &&
    Number.isInteger(payload.totalChunks) &&
    payload.totalChunks >= 1 &&
    payload.totalChunks <= MAX_VIDEO_BACKGROUND_CHUNKS
  ) {
    return {
      kind: "start",
      revision: payload.revision,
      totalChunks: payload.totalChunks,
      type: VIDEO_BACKGROUND_MESSAGE_TYPE,
    };
  }

  if (
    payload.kind === "chunk" &&
    "data" in payload &&
    typeof payload.data === "string" &&
    payload.data.length <= VIDEO_BACKGROUND_CHUNK_SIZE &&
    "index" in payload &&
    typeof payload.index === "number" &&
    Number.isInteger(payload.index) &&
    payload.index >= 0 &&
    payload.index < MAX_VIDEO_BACKGROUND_CHUNKS
  ) {
    return {
      data: payload.data,
      index: payload.index,
      kind: "chunk",
      revision: payload.revision,
      type: VIDEO_BACKGROUND_MESSAGE_TYPE,
    };
  }

  return payload.kind === "end"
    ? {
        kind: "end",
        revision: payload.revision,
        type: VIDEO_BACKGROUND_MESSAGE_TYPE,
      }
    : null;
}

function deliverVideoBackgroundWireMessage(
  conference: JitsiConferenceLike,
  message: VideoBackgroundWireMessage,
  participantId = "",
) {
  if (!conference.sendMessage) {
    return false;
  }

  try {
    conference.sendMessage(message, participantId, true);
    return true;
  } catch (caughtError) {
    console.warn(
      "Ninjitsi: video background data channel unavailable",
      caughtError,
    );
    return false;
  }
}

async function sendVideoBackground(
  conference: JitsiConferenceLike,
  dataUrl: string,
  revision: string,
  participantId = "",
) {
  if (
    !revision ||
    dataUrl.length > MAX_VIDEO_BACKGROUND_DATA_LENGTH ||
    !/^data:image\/(?:gif|jpeg|png);base64,/i.test(dataUrl)
  ) {
    return false;
  }

  const totalChunks = Math.ceil(
    dataUrl.length / VIDEO_BACKGROUND_CHUNK_SIZE,
  );

  if (
    !deliverVideoBackgroundWireMessage(
      conference,
      {
        kind: "start",
        revision,
        totalChunks,
        type: VIDEO_BACKGROUND_MESSAGE_TYPE,
      },
      participantId,
    )
  ) {
    return false;
  }

  for (let index = 0; index < totalChunks; index += 1) {
    if (
      !deliverVideoBackgroundWireMessage(
        conference,
        {
          data: dataUrl.slice(
            index * VIDEO_BACKGROUND_CHUNK_SIZE,
            (index + 1) * VIDEO_BACKGROUND_CHUNK_SIZE,
          ),
          index,
          kind: "chunk",
          revision,
          type: VIDEO_BACKGROUND_MESSAGE_TYPE,
        },
        participantId,
      )
    ) {
      return false;
    }

    if (index > 0 && index % 20 === 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  return deliverVideoBackgroundWireMessage(
    conference,
    {
      kind: "end",
      revision,
      type: VIDEO_BACKGROUND_MESSAGE_TYPE,
    },
    participantId,
  );
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
  id: string,
  replyTo?: ChatReplyReference,
) {
  return `${CHAT_TEXT_MESSAGE_PREFIX}${JSON.stringify({
    id,
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
      id:
        "id" in parsed && typeof parsed.id === "string"
          ? parsed.id.slice(0, 180)
          : undefined,
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
    recipientIds:
      "recipientIds" in payload && Array.isArray(payload.recipientIds)
        ? payload.recipientIds
            .filter((id): id is string => typeof id === "string")
            .slice(0, 30)
        : [],
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
    recipientIds: recipients.map((recipient) => recipient.id),
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
    isMediaPermissionError(caughtError) ||
    normalized.includes("permission") ||
    normalized.includes("notallowed") ||
    normalized.includes("denied")
  ) {
    return ui(
      `The browser does not have permission to use the ${target}. Allow access in the address bar.`,
      `Браузеру не разрешён доступ к ${target}. Разрешите его в адресной строке.`,
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

function createDemoParticipants(
  displayName: string,
  avatarUrl: string,
  tileColor: string,
  videoBackgroundUrl: string,
): ParticipantView[] {
  const demoTileColors = [
    "#485D78",
    "#6B576F",
    "#6D614B",
    "#466B5F",
    "#735153",
    "#52606B",
  ];
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
    tileColor:
      index === 0
        ? normalizeProfileTileColor(tileColor)
        : demoTileColors[
            Math.max(0, index - 1) % demoTileColors.length
          ],
    videoBackgroundEnabled: false,
    videoBackgroundUrl: index === 0 ? videoBackgroundUrl : undefined,
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
  const [isVideoStarting, setIsVideoStarting] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [isScreenShareBusy, setIsScreenShareBusy] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [localAudioLevel, setLocalAudioLevel] = useState(0);
  const [audioInputId, setAudioInputIdState] = useState("");
  const [audioOutputId, setAudioOutputIdState] = useState("");
  const [videoInputId, setVideoInputIdState] = useState("");
  const [noiseSuppressionEnabled, setNoiseSuppressionState] = useState(false);
  const [noiseSuppressionSupported, setNoiseSuppressionSupported] =
    useState(false);
  const [isDeviceSwitchBusy, setIsDeviceSwitchBusy] = useState(false);
  const [isSendingAttachment, setIsSendingAttachment] = useState(false);
  const [videoBackgroundAvailable, setVideoBackgroundAvailable] =
    useState(false);
  const [videoBackgroundEnabled, setVideoBackgroundEnabledState] =
    useState(false);
  const [connectionStats, setConnectionStats] = useState<
    Record<string, { pingMs: number | null; quality: number | null }>
  >({});
  const connectionRef = useRef<JitsiConnectionLike | null>(null);
  const conferenceRef = useRef<JitsiConferenceLike | null>(null);
  const libraryRef = useRef<JitsiMeetJSLibrary | null>(null);
  const localIdRef = useRef("local");
  const localNameRef = useRef(ui("You", "Вы"));
  const localAvatarRef = useRef("");
  const localTileColorRef = useRef(DEFAULT_PROFILE_TILE_COLOR);
  const localVideoBackgroundDataRef = useRef("");
  const localVideoBackgroundRevisionRef = useRef("");
  const videoBackgroundEnabledRef = useRef(false);
  const videoBackgroundChannelOpenRef = useRef(false);
  const dominantSpeakerRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const desktopRemovalRef = useRef(new WeakSet<JitsiTrackLike>());
  const videoTrackListenersRef = useRef(new Map<JitsiTrackLike, {
    native: MediaStreamTrack | undefined;
    cleanup: () => void;
  }>());
  const videoRecoveryTimersRef = useRef(new Map<string, number>());
  const videoRecoveryAtRef = useRef(new Map<string, number>());
  const audioBusyRef = useRef(false);
  const audioIntentRef = useRef<boolean | null>(null);
  const pushToTalkModeRef = useRef<boolean | null>(null);
  const publishedMicrophoneMutedRef = useRef<boolean | null>(null);
  const audioCommandRef = useRef(Promise.resolve());
  const participantSessionsRef = useRef(new Map<string, number>());
  const videoBusyRef = useRef(false);
  const [cameraOperations] = useState(() => new CameraOperations());
  const cameraDisposals = useRef(new WeakMap<JitsiTrackLike, Promise<void>>());
  const cameraStartRef = useRef<AbortController | null>(null);
  const cameraSetupRef = useRef<AbortController | null>(null);
  const cameraOffIntentRef = useRef(false);
  const publishedCameraOffRef = useRef<boolean | null>(null);
  const screenShareBusyRef = useRef(false);
  const audioMeterRef = useRef<{
    nativeTrack: MediaStreamTrack;
    stop: () => void;
    track: JitsiTrackLike;
  } | null>(null);
  const audioInputIdRef = useRef("");
  const audioOutputIdRef = useRef("");
  const videoInputIdRef = useRef("");
  const noiseSuppressionEnabledRef = useRef(false);
  const incomingAttachmentsRef = useRef(
    new Map<string, IncomingAttachment>(),
  );
  const incomingVideoBackgroundsRef = useRef(
    new Map<string, IncomingVideoBackground>(),
  );
  const remoteVideoBackgroundsRef = useRef(
    new Map<string, { dataUrl: string; revision: string }>(),
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
      const noiseSupported = isNoiseSuppressionSupported();
      const noiseEnabled = preferences.noiseSuppressionEnabled && noiseSupported;

      audioInputIdRef.current = preferences.audioInputId;
      audioOutputIdRef.current = preferences.audioOutputId;
      videoInputIdRef.current = preferences.videoInputId;
      noiseSuppressionEnabledRef.current = noiseEnabled;
      setAudioInputIdState(preferences.audioInputId);
      setAudioOutputIdState(preferences.audioOutputId);
      setVideoInputIdState(preferences.videoInputId);
      setNoiseSuppressionState(noiseEnabled);
      setNoiseSuppressionSupported(noiseSupported);
    });
  }, []);

  const persistMediaPreferences = useCallback(() => {
    saveMediaPreferences({
      audioInputId: audioInputIdRef.current,
      audioOutputId: audioOutputIdRef.current,
      noiseSuppressionEnabled: noiseSuppressionEnabledRef.current,
      videoInputId: videoInputIdRef.current,
    });
  }, []);

  const createConfiguredAudioTrack = useCallback(
    async (library: JitsiMeetJSLibrary, deviceId: string) => {
      try {
        return await createLocalTrack(
          library,
          "audio",
          deviceId,
          noiseSuppressionEnabledRef.current,
        );
      } catch (error) {
        if (isMediaPermissionError(error)) {
          throw error;
        }

        if (!noiseSuppressionEnabledRef.current) {
          const fallback = await createLocalTrack(
            library,
            "audio",
            deviceId,
            false,
            false,
          );
          setNoiseSuppressionSupported(false);
          setError(
            ui(
              "Browser noise suppression controls are unavailable. The microphone remains on.",
              "Управление шумоподавлением недоступно. Микрофон продолжает работать.",
            ),
          );
          return fallback;
        }

        let track: JitsiTrackLike;
        try {
          track = await createLocalTrack(library, "audio", deviceId, false);
        } catch {
          track = await createLocalTrack(library, "audio", deviceId, false, false);
          setNoiseSuppressionSupported(false);
        }
        noiseSuppressionEnabledRef.current = false;
        setNoiseSuppressionState(false);
        persistMediaPreferences();
        setError(
          ui(
            "Noise suppression could not start. The microphone remains on without it.",
            "Шумоподавление не запустилось. Микрофон продолжает работать без него.",
          ),
        );
        return track;
      }
    },
    [persistMediaPreferences],
  );

  const watchLocalAudioLevel = useCallback((track?: JitsiTrackLike) => {
    const nativeTrack = track?.getTrack?.();
    if (audioMeterRef.current?.track === track && audioMeterRef.current?.nativeTrack === nativeTrack) {
      return;
    }

    audioMeterRef.current?.stop();
    audioMeterRef.current = null;
    setLocalAudioLevel(0);
    if (!track || !nativeTrack || nativeTrack.readyState === "ended") {
      return;
    }

    try {
      const context = new AudioContext();
      const source = context.createMediaStreamSource(
        new MediaStream([nativeTrack]),
      );
      const analyser = context.createAnalyser();
      const silentOutput = context.createGain();
      const samples = new Float32Array(1024);
      analyser.fftSize = samples.length;
      silentOutput.gain.value = 0;
      source.connect(analyser);
      analyser.connect(silentOutput);
      silentOutput.connect(context.destination);
      void context.resume().catch(() => undefined);

      const interval = window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) {
          energy += sample * sample;
        }
        const rms = Math.sqrt(energy / samples.length);
        setLocalAudioLevel(track.isMuted() ? 0 : Math.min(1, rms * 6));
      }, 80);

      const stopped = () => {
        setIsAudioMuted(true);
        setLocalAudioLevel(0);
        setParticipants(current => current.map(participant => participant.isLocal
          ? { ...participant, audioMuted: true } : participant));
      };
      nativeTrack.addEventListener("ended", stopped);
      audioMeterRef.current = {
        nativeTrack,
        track,
        stop: () => {
          nativeTrack.removeEventListener("ended", stopped);
          window.clearInterval(interval);
          source.disconnect();
          analyser.disconnect();
          silentOutput.disconnect();
          void context.close().catch(() => undefined);
        },
      };
    } catch {
      // The meter is optional; a failed analyzer must not stop the microphone.
    }
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
    const localVideo = pickPreferredVideo(localTracks.filter(track => !desktopRemovalRef.current.has(track)));
    const localAudio = localTracks.find((track) => track.getType() === "audio");
    watchLocalAudioLevel(localAudio);
    const remote = currentParticipantSessions(conference.getParticipants(), participantSessionsRef.current)
      .filter((participant) => !participant.isHidden?.())
      .map<ParticipantView>((participant) => {
        const tracks = participant.getTracks();
        const sharingProperty = participant.getProperty?.(SCREEN_SHARING_PROPERTY);
        const videoTrack = pickPreferredVideo(tracks,
          typeof sharingProperty === "string"
            ? sharingProperty === "false" ? false : sharingProperty === "true" ? true : sharingProperty
            : undefined);
        const audioTrack = tracks.find((track) => track.getType() === "audio");
        const audioTracks = tracks.filter((track) => track.getType() === "audio");
        const videoBackgroundRevision =
          typeof participant.getProperty?.(
            VIDEO_BACKGROUND_REVISION_PROPERTY,
          ) === "string"
            ? String(
                participant.getProperty?.(
                  VIDEO_BACKGROUND_REVISION_PROPERTY,
                ),
              ).slice(0, 180)
            : "";
        const videoBackgroundEnabled =
          participant.getProperty?.(VIDEO_BACKGROUND_ENABLED_PROPERTY) ===
          "true";
        const receivedBackground = remoteVideoBackgroundsRef.current.get(
          participant.getId(),
        );
        const isScreenSharing = videoTrack?.getVideoType?.() === "desktop";
        const cameraOff = participant.getProperty?.(CAMERA_OFF_PROPERTY);
        const microphoneMuted = participant.getProperty?.(MICROPHONE_MUTED_PROPERTY);

        return {
          audioMuted: microphoneMuted === "true" ||
            (microphoneMuted !== "false" && participant.isAudioMuted()),
          audioTrack,
          audioTracks,
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
          isScreenSharing,
          tileColor: normalizeProfileTileColor(
            participant.getProperty?.(TILE_COLOR_PROPERTY),
          ),
          videoBackgroundEnabled,
          videoBackgroundUrl:
            videoBackgroundEnabled &&
            receivedBackground?.revision === videoBackgroundRevision
              ? receivedBackground.dataUrl
              : undefined,
          videoMuted: isScreenSharing
            ? videoTrack.isMuted()
            : isCameraOff(videoTrack, cameraOff === "true" ||
                (cameraOff === undefined && participant.isVideoMuted())),
          videoTrack,
        };
      });

    const localMicrophone = localAudio?.getTrack?.();
    if (pushToTalkModeRef.current && localMicrophone?.readyState === "live") {
      localMicrophone.enabled = audioIntentRef.current === false;
    }
    const audioMuted = !localAudio || isTrackEnded(localAudio) || localMicrophone?.enabled === false ||
      ((!pushToTalkModeRef.current || !localMicrophone) && localAudio.isMuted());
    if (audioMuted) {
      setLocalAudioLevel(0);
    }
    const cameraTracks = localTracks.filter(
      (track) =>
        track.getType() === "video" &&
        track.getVideoType?.() !== "desktop",
    );
    const videoMuted = cameraOffIntentRef.current || cameraTracks.every((track) => isCameraOff(track));
    const sharing = localTracks.some(
      (track) =>
        track.getType() === "video" &&
        track.getVideoType?.() === "desktop" &&
        !isTrackEnded(track) &&
        !desktopRemovalRef.current.has(track) &&
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
        tileColor: localTileColorRef.current,
        videoBackgroundEnabled: videoBackgroundEnabledRef.current,
        videoBackgroundUrl: videoBackgroundEnabledRef.current
          ? localVideoBackgroundDataRef.current
          : undefined,
        videoMuted: localVideo?.getVideoType?.() === "desktop" ? localVideo.isMuted() : videoMuted,
        videoTrack: localVideo,
      },
      ...remote,
    ]);
    for (const [property, previous, muted] of [
      [CAMERA_OFF_PROPERTY, publishedCameraOffRef, videoMuted],
      [MICROPHONE_MUTED_PROPERTY, publishedMicrophoneMutedRef, audioMuted],
    ] as const) {
      if (previous.current === muted) continue;
      previous.current = muted;
      try {
        conference.setLocalParticipantProperty?.(property, String(muted));
      } catch (error) {
        previous.current = null;
        console.warn("Ninjitsi: could not publish media state", error);
      }
    }
  }, [watchLocalAudioLevel]);

  const scheduleParticipantSync = useCallback(() => {
    syncParticipants();
    queueMicrotask(syncParticipants);
  }, [syncParticipants]);

  const refreshVideoPolicy = useCallback(() => {
    const conference = conferenceRef.current;
    if (!conference || disposedRef.current) return;
    // Source changes can arrive while a single source is briefly suspended by
    // recovery. Restore it before computing the new complete subscription.
    for (const timer of videoRecoveryTimersRef.current.values()) window.clearTimeout(timer);
    videoRecoveryTimersRef.current.clear();
    applyReceiveVideoPolicy(conference);
  }, []);

  const syncVideoTracks = useCallback(() => {
    const conference = conferenceRef.current;
    const library = libraryRef.current;
    if (!conference || !library || disposedRef.current) return;
    const tracks = [...conference.getLocalTracks(), ...conference.getParticipants().flatMap(p => p.getTracks())]
      .filter(track => track.getType() === "video");
    for (const [track, { native, cleanup }] of videoTrackListenersRef.current) {
      if (!tracks.includes(track) || track.getTrack?.() !== native) {
        cleanup();
        videoTrackListenersRef.current.delete(track);
      }
    }
    for (const track of tracks) {
      if (videoTrackListenersRef.current.has(track)) continue;
      const events = [library.events.track.TRACK_VIDEOTYPE_CHANGED,
        library.events.track.TRACK_MUTE_CHANGED, library.events.track.LOCAL_TRACK_STOPPED].filter(Boolean);
      const nativeTrack = track.getTrack?.();
      const refresh = () => {
        if (conferenceRef.current !== conference || disposedRef.current) return;
        scheduleParticipantSync();
        refreshVideoPolicy();
      };
      events.forEach(event => track.addEventListener?.(event, refresh));
      nativeTrack?.addEventListener("ended", refresh);
      nativeTrack?.addEventListener("mute", refresh);
      nativeTrack?.addEventListener("unmute", refresh);
      videoTrackListenersRef.current.set(track, { native: nativeTrack, cleanup: () => {
        events.forEach(event => track.removeEventListener?.(event, refresh));
        nativeTrack?.removeEventListener("ended", refresh);
        nativeTrack?.removeEventListener("mute", refresh);
        nativeTrack?.removeEventListener("unmute", refresh);
      } });
    }
    scheduleParticipantSync();
    refreshVideoPolicy();
  }, [refreshVideoPolicy, scheduleParticipantSync]);

  useEffect(() => {
    const recover = (event: Event) => {
      const conference = conferenceRef.current;
      const track = (event as CustomEvent<{ track: JitsiTrackLike }>).detail?.track;
      if (!conference || !track || disposedRef.current || track.isMuted() || isTrackEnded(track) ||
          !conference.getParticipants().some(p => p.getTracks().includes(track))) return;
      const source = track.getSourceName?.();
      if (!source || videoRecoveryTimersRef.current.has(source)) return;
      const now = performance.now();
      if (now - (videoRecoveryAtRef.current.get(source) ?? -Infinity) < 60_000) return;
      videoRecoveryAtRef.current.set(source, now);
      // Briefly stop ONLY this video subscription. Re-enabling requests a fresh
      // keyframe/layer from the bridge or P2P peer; microphone/audio are untouched.
      applyReceiveVideoPolicy(conference, source);
      videoRecoveryTimersRef.current.set(source, window.setTimeout(() => {
        videoRecoveryTimersRef.current.delete(source);
        if (conferenceRef.current === conference && !disposedRef.current) {
          applyReceiveVideoPolicy(conference);
        }
      }, 400));
    };
    const visible = () => {
      if (document.visibilityState === "visible") {
        syncVideoTracks();
      }
    };
    window.addEventListener(VIDEO_RECOVERY_EVENT, recover);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    return () => {
      window.removeEventListener(VIDEO_RECOVERY_EVENT, recover);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", visible);
    };
  }, [syncVideoTracks]);

  const disposeCamera = useCallback((track: JitsiTrackLike, conference?: JitsiConferenceLike) => {
    const pending = cameraDisposals.current.get(track);
    if (pending) return pending;
    const release = (async () => {
      try {
        if (conference) await conference.removeTrack(track);
      } finally {
        try {
          await track.dispose();
        } finally {
          cameraOperations.deferOpening();
        }
      }
    })();
    cameraDisposals.current.set(track, release);
    void release.catch(() => cameraDisposals.current.delete(track));
    return release;
  }, [cameraOperations]);

  const acquireCamera = useCallback(async (library: JitsiMeetJSLibrary, deviceId: string, signal?: AbortSignal) => {
    if (!await cameraOperations.waitToOpen(signal) || signal?.aborted) return;
    try {
      const track = await createLocalTrack(library, "video", deviceId);
      if (!signal?.aborted) return track;
      await disposeCamera(track);
    } catch (error) {
      cameraOperations.deferOpening();
      throw error;
    }
  }, [cameraOperations, disposeCamera]);

  const teardown = useCallback(async () => {
    disposedRef.current = true;
    cameraSetupRef.current?.abort();
    cameraSetupRef.current = null;
    cameraStartRef.current?.abort();
    cameraStartRef.current = null;
    setIsVideoStarting(false);
    for (const { cleanup } of videoTrackListenersRef.current.values()) cleanup();
    videoTrackListenersRef.current.clear();
    for (const timer of videoRecoveryTimersRef.current.values()) window.clearTimeout(timer);
    videoRecoveryTimersRef.current.clear();
    videoRecoveryAtRef.current.clear();
    participantSessionsRef.current.clear();
    audioMeterRef.current?.stop();
    audioMeterRef.current = null;
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
    setIsDeviceSwitchBusy(false);

    if (conference) {
      const tracks = conference.getLocalTracks();

      await Promise.allSettled(
        tracks.map(async (track) => {
          if (track.getType() === "video" && track.getVideoType?.() !== "desktop") {
            await disposeCamera(track, conference).catch(() => undefined);
            return;
          }
          await conference.removeTrack(track).catch(() => undefined);
          await track.dispose().catch(() => undefined);
        }),
      );
      await conference.leave().catch(() => undefined);
    }

    connection?.disconnect();
  }, [disposeCamera, setMediaBusy]);

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

      if (currentTracks.length > 0 || cameraOffIntentRef.current) {
        lastJoinOptionsRef.current = {
          ...lastJoinOptionsRef.current,
          startAudioMuted: currentTracks.length > 0
            ? !currentAudio || currentAudio.isMuted()
            : lastJoinOptionsRef.current.startAudioMuted,
          startVideoMuted: cameraOffIntentRef.current || !currentCamera || currentCamera.isMuted(),
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
      localTileColorRef.current = normalizeProfileTileColor(options.tileColor);
      cameraOffIntentRef.current = options.startVideoMuted;
      publishedCameraOffRef.current = null;
      pushToTalkModeRef.current ??= readPushToTalkPreference();
      publishedMicrophoneMutedRef.current = null;
      localVideoBackgroundDataRef.current =
        options.videoBackgroundDataUrl || "";
      localVideoBackgroundRevisionRef.current =
        options.videoBackgroundDataUrl
          ? options.videoBackgroundRevision.slice(0, 180)
          : "";
      const backgroundAvailable = Boolean(localVideoBackgroundDataRef.current && localVideoBackgroundRevisionRef.current);
      setVideoBackgroundAvailable(backgroundAvailable);
      videoBackgroundChannelOpenRef.current = false;
      if (!isRecovery) {
        videoBackgroundEnabledRef.current = backgroundAvailable;
        setVideoBackgroundEnabledState(backgroundAvailable);
      }
      disposedRef.current = false;
      if (!isRecovery) {
        hasJoinedRef.current = false;
        reconnectAttemptRef.current = 0;
        setChatMessages([]);
        setConnectionStats({});
        incomingAttachmentsRef.current.clear();
        incomingVideoBackgroundsRef.current.clear();
        remoteVideoBackgroundsRef.current.clear();
      }

      if (isDemo) {
        setStatus(isRecovery ? "reconnecting" : "loading");
        await new Promise((resolve) => window.setTimeout(resolve, 420));
        const demoParticipants = createDemoParticipants(
          options.displayName,
          options.avatarDataUrl,
          options.tileColor,
          options.videoBackgroundDataUrl,
        );

        demoParticipants[0].audioMuted = options.startAudioMuted || pushToTalkModeRef.current;
        demoParticipants[0].videoMuted = options.startVideoMuted;
        demoParticipants[0].videoBackgroundEnabled = videoBackgroundEnabledRef.current;
        setParticipants(demoParticipants);
        audioIntentRef.current = demoParticipants[0].audioMuted;
        setIsAudioMuted(demoParticipants[0].audioMuted);
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
        const noiseSupported = isNoiseSuppressionSupported() &&
          Boolean(library.createLocalTracksFromMediaStreams);
        const noiseEnabled =
          preferences.noiseSuppressionEnabled && noiseSupported;

        if (disposedRef.current) {
          return;
        }

        audioInputIdRef.current = preferences.audioInputId;
        audioOutputIdRef.current = preferences.audioOutputId;
        videoInputIdRef.current = preferences.videoInputId;
        noiseSuppressionEnabledRef.current = noiseEnabled;
        setAudioInputIdState(preferences.audioInputId);
        setAudioOutputIdState(preferences.audioOutputId);
        setVideoInputIdState(preferences.videoInputId);
        setNoiseSuppressionState(noiseEnabled);
        setNoiseSuppressionSupported(noiseSupported);
        libraryRef.current = library;
        library.init({
          disableAudioLevels: false,
          disableThirdPartyRequests: true,
        });

        if (library.setLogLevel && library.logLevels?.ERROR) {
          library.setLogLevel(library.logLevels.ERROR);
        }

        const startAudioMuted = options.startAudioMuted || pushToTalkModeRef.current === true;
        audioIntentRef.current = startAudioMuted;
        setIsAudioMuted(startAudioMuted);
        setIsVideoMuted(options.startVideoMuted);
        setMediaBusy("audio", true);
        setMediaBusy("video", !options.startVideoMuted);

        const initialCamera = new AbortController();
        cameraSetupRef.current = initialCamera;
        const initialDevices = options.startVideoMuted ? ["audio"] as const : ["audio", "video"] as const;
        const initialTracksPromise = Promise.all(
          initialDevices.map(async device => {
            try {
              const track = device === "audio"
                ? await createConfiguredAudioTrack(library, preferences.audioInputId)
                : await cameraOperations.run(() => acquireCamera(library, preferences.videoInputId, initialCamera.signal));
              if (!track) return null;

              try {
                if (device === "audio" && startAudioMuted) await track.mute();
              } catch (error) {
                await track.dispose().catch(() => undefined);
                throw error;
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
        const disposeInitialTrack = (device: "audio" | "video", track: JitsiTrackLike) =>
          device === "video" ? disposeCamera(track) : track.dispose();
        let initialTracksClaimed = false;

        discardInitialTracks = () => {
          if (initialTracksClaimed) {
            return;
          }

          initialTracksClaimed = true;
          initialCamera.abort();
          void initialTracksPromise.then(async (results) => {
            await Promise.allSettled(
              results.flatMap((result) =>
                result?.ok ? [disposeInitialTrack(result.device, result.track)] : [],
              ),
            );
            setMediaBusy("audio", false);
            setMediaBusy("video", false);
          });
        };

        const connection = new library.JitsiConnection(
          null,
          options.jitsiToken ?? null,
          config,
        );
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
            conference.setLocalParticipantProperty?.(SESSION_PROPERTY, JSON.stringify(nextParticipantSession(roomName)));
            conference.setLocalParticipantProperty?.(SCREEN_SHARING_PROPERTY, "false");
            applyReceiveVideoPolicy(conference);
            conference.setLocalParticipantProperty?.(
              "avatarURL",
              options.avatarDataUrl,
            );
            conference.setLocalParticipantProperty?.(
              TILE_COLOR_PROPERTY,
              localTileColorRef.current,
            );
            conference.setLocalParticipantProperty?.(
              VIDEO_BACKGROUND_REVISION_PROPERTY,
              localVideoBackgroundRevisionRef.current,
            );
            conference.setLocalParticipantProperty?.(
              VIDEO_BACKGROUND_ENABLED_PROPERTY,
              videoBackgroundEnabledRef.current ? "true" : "false",
            );

            const publishVideoBackground = async (participantId = "") => {
              if (
                conferenceRef.current !== conference ||
                !videoBackgroundChannelOpenRef.current ||
                !videoBackgroundEnabledRef.current ||
                !localVideoBackgroundDataRef.current ||
                !localVideoBackgroundRevisionRef.current
              ) {
                return;
              }

              const remoteParticipants = conference.getParticipants();

              if (
                (!participantId && remoteParticipants.length === 0) ||
                (participantId &&
                  !remoteParticipants.some(
                    (participant) => participant.getId() === participantId,
                  ))
              ) {
                return;
              }

              const sent = await sendVideoBackground(
                conference,
                localVideoBackgroundDataRef.current,
                localVideoBackgroundRevisionRef.current,
                participantId,
              );

              if (!sent && conferenceRef.current === conference) {
                setError(
                  ui(
                    "The video background could not be sent to the meeting.",
                    "Не удалось отправить видеофон участникам встречи.",
                  ),
                );
              }
            };

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
              conference.on(eventName, syncVideoTracks),
            );

            if (conferenceEvents.USER_JOINED) {
              conference.on(
                conferenceEvents.USER_JOINED,
                (participantId) => {
                  if (typeof participantId === "string") {
                    window.setTimeout(
                      () => void publishVideoBackground(participantId),
                      800,
                    );
                  }
                },
              );
            }
            if (conferenceEvents.DATA_CHANNEL_OPENED) {
              conference.on(conferenceEvents.DATA_CHANNEL_OPENED, () => {
                if (conferenceRef.current !== conference) {
                  return;
                }
                videoBackgroundChannelOpenRef.current = true;
                refreshVideoPolicy();
                void publishVideoBackground();
              });
            }
            if (conferenceEvents.DATA_CHANNEL_CLOSED) {
              conference.on(conferenceEvents.DATA_CHANNEL_CLOSED, () => {
                if (conferenceRef.current !== conference) {
                  return;
                }
                videoBackgroundChannelOpenRef.current = false;
              });
            }
            if (conferenceEvents.USER_LEFT) {
              conference.on(conferenceEvents.USER_LEFT, (participantId) => {
                if (typeof participantId !== "string") {
                  return;
                }

                remoteVideoBackgroundsRef.current.delete(participantId);
                for (const transferKey of incomingVideoBackgroundsRef.current.keys()) {
                  if (transferKey.startsWith(`${participantId}:`)) {
                    incomingVideoBackgroundsRef.current.delete(transferKey);
                  }
                }
              });
            }

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
              recipientIds: string[] = [],
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
                    recipientIds,
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
                    !Array.from(
                      { length: transfer.totalChunks },
                      (_, index) =>
                        typeof transfer.chunks[index] === "string",
                    ).every(Boolean)
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
                      id: `attachment-${transfer.id}`,
                      isLocal: false,
                      isPrivate: transfer.isPrivate,
                      recipientIds: transfer.recipientIds,
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
                  id:
                    chatText.id ??
                    `${rawSenderId}-${timestamp}-${messages.length}`,
                  isLocal: false,
                  isPrivate,
                  recipientIds,
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
                  const senderId =
                    typeof rawParticipant === "string"
                      ? rawParticipant
                      : rawParticipant &&
                          typeof rawParticipant === "object" &&
                          "getId" in rawParticipant &&
                          typeof rawParticipant.getId === "function"
                        ? rawParticipant.getId()
                        : null;

                  if (typeof senderId !== "string") {
                    return;
                  }

                  const videoBackgroundMessage =
                    parseVideoBackgroundWireMessage(rawPayload);

                  if (videoBackgroundMessage) {
                    const transferKey = `${senderId}:${videoBackgroundMessage.revision}`;

                    if (videoBackgroundMessage.kind === "start") {
                      for (const existingKey of incomingVideoBackgroundsRef.current.keys()) {
                        if (existingKey.startsWith(`${senderId}:`)) {
                          incomingVideoBackgroundsRef.current.delete(existingKey);
                        }
                      }
                      incomingVideoBackgroundsRef.current.set(transferKey, {
                        chunks: new Array(
                          videoBackgroundMessage.totalChunks,
                        ),
                        revision: videoBackgroundMessage.revision,
                        totalChunks: videoBackgroundMessage.totalChunks,
                      });
                    } else if (videoBackgroundMessage.kind === "chunk") {
                      const transfer =
                        incomingVideoBackgroundsRef.current.get(transferKey);

                      if (
                        transfer &&
                        videoBackgroundMessage.index < transfer.totalChunks
                      ) {
                        transfer.chunks[videoBackgroundMessage.index] =
                          videoBackgroundMessage.data;
                      }
                    } else {
                      const transfer =
                        incomingVideoBackgroundsRef.current.get(transferKey);

                      incomingVideoBackgroundsRef.current.delete(transferKey);
                      if (
                        !transfer ||
                        !Array.from(
                          { length: transfer.totalChunks },
                          (_, index) =>
                            typeof transfer.chunks[index] === "string",
                        ).every(Boolean)
                      ) {
                        return;
                      }

                      const dataUrl = transfer.chunks.join("");

                      if (
                        dataUrl.length > MAX_VIDEO_BACKGROUND_DATA_LENGTH ||
                        !/^data:image\/(?:gif|jpeg|png);base64,/i.test(dataUrl)
                      ) {
                        return;
                      }

                      remoteVideoBackgroundsRef.current.set(senderId, {
                        dataUrl,
                        revision: transfer.revision,
                      });
                      syncParticipants();
                    }

                    return;
                  }

                  const attachmentMessagePayload =
                    parseAttachmentDataWireMessage(rawPayload);

                  if (attachmentMessagePayload) {
                    receiveChatText(
                      senderId,
                      attachmentMessage(
                        attachmentMessagePayload.attachment,
                      ),
                      attachmentMessagePayload.timestamp,
                      attachmentMessagePayload.recipientIds.length > 0,
                      attachmentMessagePayload.recipientIds,
                      attachmentMessagePayload.recipientNames,
                    );
                    return;
                  }

                  const privateMessage =
                    parsePrivateChatWireMessage(rawPayload);

                  if (!privateMessage) {
                    return;
                  }

                  receiveChatText(
                    senderId,
                    privateMessage.message,
                    privateMessage.timestamp,
                    true,
                    privateMessage.recipientIds,
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
            conference.on(conferenceEvents.CONNECTION_RESTORED, () => {
              setStatus("joined");
              syncVideoTracks();
            });
            if (conferenceEvents.P2P_STATUS) {
              conference.on(conferenceEvents.P2P_STATUS, syncVideoTracks);
            }
            conference.on(conferenceEvents.CONFERENCE_JOINED, async () => {
              hasJoinedRef.current = true;
              reconnectAttemptRef.current = 0;
              reconnectInProgressRef.current = false;
              recoveringSessionRef.current = false;
              setError(null);
              setStatus("joined");
              syncParticipants();
              window.setTimeout(sendPingRound, 1_000);
              window.setTimeout(
                () => void publishVideoBackground(),
                600,
              );
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
              if (cameraSetupRef.current === initialCamera) cameraSetupRef.current = null;
              const isCurrentConference =
                !disposedRef.current &&
                conferenceRef.current === conference;

              if (!isCurrentConference) {
                await Promise.allSettled(
                  results.flatMap((result) =>
                    result?.ok ? [disposeInitialTrack(result.device, result.track)] : [],
                  ),
                );
                setMediaBusy("audio", false);
                setMediaBusy("video", false);
                return;
              }

              const failures: string[] = [];

              for (const result of results) {
                if (!result) continue;
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
                  await disposeInitialTrack(result.device, result.track).catch(() => undefined);
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
      acquireCamera,
      cameraOperations,
      createConfiguredAudioTrack,
      disposeCamera,
      isDemo,
      roomName,
      syncVideoTracks,
      refreshVideoPolicy,
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

  const applyAudioMuted = useCallback(async (muted: boolean) => {
    if (isDemo) {
      setIsAudioMuted(muted);
      setParticipants(current => current.map(participant => participant.isLocal
        ? { ...participant, audioMuted: muted } : participant));
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

      if (currentTrack && !isTrackEnded(currentTrack)) {
        if (!pushToTalkModeRef.current || !currentTrack.getTrack?.()) {
          if (muted) await currentTrack.mute();
          else await currentTrack.unmute();
        }
        const native = currentTrack.getTrack?.();
        if (native) native.enabled = audioIntentRef.current !== true;
      } else {
        const newTrack = await createConfiguredAudioTrack(
          library,
          audioInputIdRef.current,
        );

        if (
          disposedRef.current ||
          conferenceRef.current !== conference
        ) {
          await newTrack.dispose();
          return;
        }

        try {
          const native = newTrack.getTrack?.();
          if (pushToTalkModeRef.current && native) native.enabled = false;
          else if (audioIntentRef.current === true) await newTrack.mute();
          if (currentTrack && conference.replaceTrack) {
            await conference.replaceTrack(currentTrack, newTrack);
            await currentTrack.dispose().catch(() => undefined);
          } else {
            if (currentTrack) await conference.removeTrack(currentTrack);
            await conference.addTrack(newTrack);
            await currentTrack?.dispose().catch(() => undefined);
          }
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
  }, [
    createConfiguredAudioTrack,
    isDemo,
    setMediaBusy,
    syncParticipants,
  ]);

  const setAudioMuted = useCallback((muted: boolean, pushToTalk?: boolean) => {
    if (pushToTalk !== undefined) pushToTalkModeRef.current = pushToTalk;
    audioIntentRef.current = muted;
    const conference = conferenceRef.current;
    const tracks = conference?.getLocalTracks("audio") ?? [];
    if (muted) {
      for (const track of tracks) {
        const native = track.getTrack?.();
        if (native) native.enabled = false;
      }
    }
    if (pushToTalkModeRef.current &&
        (muted || (!audioBusyRef.current && tracks.some(track=>track.getTrack?.()?.readyState === "live")))) {
      if (isDemo) return applyAudioMuted(muted);
      syncParticipants();
      return Promise.resolve();
    }
    audioCommandRef.current = audioCommandRef.current.then(async () => {
      // Device replacement owns the track until it finishes.
      while (audioBusyRef.current && conferenceRef.current === conference && !disposedRef.current) {
        await new Promise(resolve => window.setTimeout(resolve, 30));
      }
      if (conferenceRef.current !== conference || audioIntentRef.current !== muted) return;
      await applyAudioMuted(muted);
    }).catch(() => undefined);
    return audioCommandRef.current;
  }, [applyAudioMuted, isDemo, syncParticipants]);

  const toggleAudio = useCallback(() => setAudioMuted(
    !(audioBusyRef.current ? audioIntentRef.current ?? isAudioMuted : isAudioMuted),
  ), [isAudioMuted, setAudioMuted]);

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

    if (cameraStartRef.current) {
      cameraStartRef.current.abort();
      setIsVideoStarting(false);
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
    const isCurrent = () => !disposedRef.current && conferenceRef.current === conference;
    const oldCamera = conference.getLocalTracks("video")
      .find(track => track.getVideoType?.() !== "desktop");
    const turningOff = !isCameraOff(oldCamera, cameraOffIntentRef.current);
    const start = turningOff ? null : new AbortController();
    cameraOffIntentRef.current = true;
    if (start) {
      cameraStartRef.current = start;
      setIsVideoStarting(true);
    }
    try {
      syncParticipants();
      await cameraOperations.run(async () => {
        if (!isCurrent() || start?.signal.aborted) return;
        if (oldCamera) await disposeCamera(oldCamera, conference);
        if (!start || !isCurrent()) return;
        const track = await acquireCamera(library, videoInputIdRef.current, start.signal);
        if (!track) return;

        let published = false;
        try {
          if (!isCurrent() || start.signal.aborted) return;
          cameraStartRef.current = null;
          setIsVideoStarting(false);
          await conference.addTrack(track);
          published = isCurrent();
          if (published) cameraOffIntentRef.current = false;
        } finally {
          if (!published) await disposeCamera(track).catch(() => undefined);
        }
      });
    } catch (caughtError) {
      if (isCurrent() && !start?.signal.aborted) {
        setError(mediaErrorMessage("video", caughtError));
      }
    } finally {
      if (isCurrent()) {
        cameraStartRef.current = null;
        setIsVideoStarting(false);
        setMediaBusy("video", false);
        syncVideoTracks();
      }
    }
  }, [acquireCamera, cameraOperations, disposeCamera, isDemo, setMediaBusy, syncParticipants, syncVideoTracks]);

  const stopScreenShare = useCallback(async (conference: JitsiConferenceLike, desktop: JitsiTrackLike) => {
    if (desktopRemovalRef.current.has(desktop)) return;
    desktopRemovalRef.current.add(desktop);
    // Remote SDKs can keep a live, unmuted desktop receiver after source-remove.
    // Presence is the authoritative UI signal, not the lifetime of that receiver.
    if (conferenceRef.current === conference && !disposedRef.current) {
      conference.setLocalParticipantProperty?.(SCREEN_SHARING_PROPERTY, "false");
      setIsScreenSharing(false);
      syncParticipants();
    }
    try {
      // Keep the desktop source/SDP slot muted until the next share. Removing an
      // already-ended capture can leave a ghost receiver and inactive encodings
      // when this SDK reuses the source across a P2P/JVB transition. Replacing a
      // muted desktop with a fresh desktop is the supported same-type path.
      await desktop.mute();
    } finally {
      desktop.getTrack?.()?.stop();
      if (conferenceRef.current === conference && !disposedRef.current) syncVideoTracks();
    }
  }, [syncParticipants, syncVideoTracks]);

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
        .find((track) => track.getVideoType?.() === "desktop" &&
          !desktopRemovalRef.current.has(track) && !isTrackEnded(track));

      if (currentDesktop) {
        await stopScreenShare(conference, currentDesktop);
        return;
      }

      const desktopTrack = await createLocalTrack(library, "desktop");
      const parkedDesktop = conference.getLocalTracks("video")
        .find(track => track.getVideoType?.() === "desktop");
      const stoppedEvent = library.events.track.LOCAL_TRACK_STOPPED;

      if (stoppedEvent) {
        desktopTrack.addEventListener?.(stoppedEvent, () => {
          // Ignore a stale capture callback from a conference we already left.
          if (conferenceRef.current !== conference || disposedRef.current) return;
          void stopScreenShare(conference, desktopTrack).catch(error => {
            if (conferenceRef.current === conference && !disposedRef.current) {
              setError(mediaErrorMessage("desktop", error));
            }
          });
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

      setIsScreenSharing(true);
      setParticipants((current) =>
        current.map((participant) =>
          participant.isLocal
            ? {
                ...participant,
                isScreenSharing: true,
                videoMuted: false,
                videoTrack: desktopTrack,
              }
            : participant,
        ),
      );

      try {
        if (parkedDesktop && conference.replaceTrack) {
          await conference.replaceTrack(parkedDesktop, desktopTrack);
          await parkedDesktop.dispose().catch(() => undefined);
        } else {
          if (parkedDesktop) {
            await conference.removeTrack(parkedDesktop);
            await parkedDesktop.dispose().catch(() => undefined);
          }
          await conference.addTrack(desktopTrack);
        }
        if (!desktopRemovalRef.current.has(desktopTrack) && !isTrackEnded(desktopTrack)) {
          conference.setLocalParticipantProperty?.(SCREEN_SHARING_PROPERTY, desktopTrack.getSourceName?.() || "true");
        }
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
  }, [isDemo, setMediaBusy, stopScreenShare, syncParticipants]);

  const replaceInputTrack = useCallback(
    async (device: "audio" | "video", deviceId: string) => {
      if (device === "video" && videoBusyRef.current) return;
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

      const oldTrack = conference.getLocalTracks(device).find(
        track => device === "audio" || track.getVideoType?.() !== "desktop",
      );
      // Choosing a camera while it is off only saves the selection.
      if (device === "video" && isCameraOff(oldTrack, cameraOffIntentRef.current)) return;

      setError(null);
      setIsDeviceSwitchBusy(true);
      setMediaBusy(device, true);
      const isCurrent = () => !disposedRef.current && conferenceRef.current === conference;
      const cameraSetup = device === "video" ? new AbortController() : null;
      if (cameraSetup) cameraSetupRef.current = cameraSetup;

      const updateTrack = async () => {
        if (!isCurrent()) return;
        const newTrack = device === "audio"
          ? await createConfiguredAudioTrack(library, deviceId)
          : await acquireCamera(library, deviceId, cameraSetup?.signal);
        if (!newTrack) return;

        let published = false;
        try {
          if (!isCurrent()) return;
          const native = device === "audio" && pushToTalkModeRef.current ? newTrack.getTrack?.() : undefined;
          if (native) {
            native.enabled = false;
          } else if (oldTrack?.isMuted() ||
              (device === "audio" && audioIntentRef.current === true) ||
              (device === "video" && cameraOffIntentRef.current)) {
            await newTrack.mute();
          }
          if (!isCurrent()) return;
          if (oldTrack && conference.replaceTrack) {
            await conference.replaceTrack(oldTrack, newTrack);
          } else {
            await conference.addTrack(newTrack);
            if (oldTrack && isCurrent()) {
              await conference.removeTrack(oldTrack);
            }
          }
          published = isCurrent();
        } finally {
          if (!published) {
            const disposal = device === "video" ? disposeCamera(newTrack) : newTrack.dispose();
            await disposal.catch(() => undefined);
          }
        }

        if (oldTrack) {
          const disposal = device === "video" ? disposeCamera(oldTrack) : oldTrack.dispose();
          await disposal.catch(() => undefined);
        }
      };
      try {
        if (device === "video") await cameraOperations.run(updateTrack);
        else await updateTrack();
      } catch (caughtError) {
        if (isCurrent()) setError(mediaErrorMessage(device, caughtError));
      } finally {
        if (cameraSetupRef.current === cameraSetup) cameraSetupRef.current = null;
        if (isCurrent()) {
          setMediaBusy(device, false);
          setIsDeviceSwitchBusy(false);
          if (device === "video") syncVideoTracks();
          else syncParticipants();
        }
      }
    },
    [
      acquireCamera,
      cameraOperations,
      createConfiguredAudioTrack,
      disposeCamera,
      isDemo,
      persistMediaPreferences,
      setMediaBusy,
      syncParticipants,
      syncVideoTracks,
    ],
  );

  const setAudioInputDevice = useCallback(
    (deviceId: string) => replaceInputTrack("audio", deviceId),
    [replaceInputTrack],
  );

  const setAudioOutputDevice = useCallback(
    async (deviceId: string) => {
      if (!("setSinkId" in HTMLMediaElement.prototype)) {
        return;
      }

      try {
        const probe = document.createElement("audio");
        await probe.setSinkId(deviceId);
        audioOutputIdRef.current = deviceId;
        setAudioOutputIdState(deviceId);
        persistMediaPreferences();
        setError(null);
      } catch {
        setError(
          ui(
            "This audio output could not be selected. Check its permission or connection.",
            "Не удалось выбрать это устройство вывода звука. Проверьте разрешение или подключение.",
          ),
        );
      }
    },
    [persistMediaPreferences],
  );

  const setVideoInputDevice = useCallback(
    (deviceId: string) => replaceInputTrack("video", deviceId),
    [replaceInputTrack],
  );

  const setNoiseSuppressionEnabled = useCallback(
    async (enabled: boolean) => {
      if (
        !isNoiseSuppressionSupported() ||
        !libraryRef.current?.createLocalTracksFromMediaStreams
      ) {
        return;
      }

      setError(null);
      setIsDeviceSwitchBusy(true);
      setMediaBusy("audio", true);

      try {
        const conference = conferenceRef.current;
        const library = libraryRef.current;
        const oldTrack = isDemo
          ? undefined
          : conference?.getLocalTracks("audio").find(Boolean);

        if (conference && library && oldTrack) {
          const oldNativeTrack = oldTrack.getTrack?.();
          if (!oldNativeTrack) {
            throw new Error("The current microphone track is unavailable.");
          }
          const wasMuted = oldTrack.isMuted() || audioIntentRef.current === true;
          const previousMode = noiseSuppressionEnabledRef.current;
          const publishReplacement = async (replacement: JitsiTrackLike) => {
            if (conference.replaceTrack) {
              try {
                await conference.replaceTrack(oldTrack, replacement);
                return;
              } catch {
                // Some Jitsi versions cannot replace an already ended source.
              }
            }
            await conference.removeTrack(oldTrack).catch(() => undefined);
            await conference.addTrack(replacement);
          };
          let newTrack: JitsiTrackLike | undefined;

          // Chromium reuses the original capture configuration while its
          // microphone track is live. End it before requesting the new mode.
          oldNativeTrack.stop();
          try {
            newTrack = await createLocalTrack(
              library,
              "audio",
              audioInputIdRef.current,
              enabled,
            );
            const native = pushToTalkModeRef.current ? newTrack.getTrack?.() : undefined;
            if (native) native.enabled = false;
            else if (wasMuted) {
              await newTrack.mute();
            }
            if (disposedRef.current || conferenceRef.current !== conference) {
              await newTrack.dispose().catch(() => undefined);
              return;
            }
            await publishReplacement(newTrack);
          } catch (error) {
            await newTrack?.dispose().catch(() => undefined);
            try {
              let restoredTrack: JitsiTrackLike;
              try {
                restoredTrack = await createLocalTrack(
                  library,
                  "audio",
                  audioInputIdRef.current,
                  previousMode,
                );
              } catch {
                restoredTrack = await createLocalTrack(
                  library,
                  "audio",
                  audioInputIdRef.current,
                  false,
                  false,
                );
                noiseSuppressionEnabledRef.current = false;
                setNoiseSuppressionState(false);
                setNoiseSuppressionSupported(false);
                persistMediaPreferences();
              }
              try {
                const native = pushToTalkModeRef.current ? restoredTrack.getTrack?.() : undefined;
                if (native) native.enabled = false;
                else if (wasMuted) {
                  await restoredTrack.mute();
                }
                await publishReplacement(restoredTrack);
              } catch (restoreError) {
                await restoredTrack.dispose().catch(() => undefined);
                throw restoreError;
              }
              await oldTrack.dispose().catch(() => undefined);
              syncParticipants();
            } catch {
              throw new Error("MICROPHONE_RECOVERY_FAILED");
            }
            throw error;
          }

          await oldTrack.dispose().catch(() => undefined);
          syncParticipants();
        }

        noiseSuppressionEnabledRef.current = enabled;
        setNoiseSuppressionState(enabled);
        persistMediaPreferences();
      } catch (error) {
        setError(
          error instanceof Error && error.message === "MICROPHONE_RECOVERY_FAILED"
            ? ui(
                "Could not restore the microphone. Re-select it in Settings.",
                "Не удалось восстановить микрофон. Выберите его заново в настройках.",
              )
            : ui(
                "Could not switch noise suppression. The microphone remains on.",
                "Не удалось переключить шумоподавление. Микрофон продолжает работать.",
              ),
        );
      } finally {
        setMediaBusy("audio", false);
        setIsDeviceSwitchBusy(false);
      }
    },
    [isDemo, persistMediaPreferences, setMediaBusy, syncParticipants],
  );

  const setVideoBackgroundEnabled = useCallback(
    async (enabled: boolean) => {
      if (
        enabled &&
        (!localVideoBackgroundDataRef.current ||
          !localVideoBackgroundRevisionRef.current)
      ) {
        setError(
          ui(
            "This profile has no video background.",
            "В этом профиле нет видеофона.",
          ),
        );
        return;
      }

      setError(null);
      videoBackgroundEnabledRef.current = enabled;
      setVideoBackgroundEnabledState(enabled);

      if (isDemo) {
        setParticipants((current) =>
          current.map((participant) =>
            participant.isLocal
              ? {
                  ...participant,
                  videoBackgroundEnabled: enabled,
                  videoBackgroundUrl: enabled
                    ? localVideoBackgroundDataRef.current
                    : undefined,
                }
              : participant,
          ),
        );
        return;
      }

      const conference = conferenceRef.current;

      if (!conference) {
        return;
      }

      syncParticipants();
      conference.setLocalParticipantProperty?.(
        VIDEO_BACKGROUND_ENABLED_PROPERTY,
        enabled ? "true" : "false",
      );

      if (
        enabled &&
        videoBackgroundChannelOpenRef.current &&
        conference.getParticipants().length > 0 &&
        !(await sendVideoBackground(
          conference,
          localVideoBackgroundDataRef.current,
          localVideoBackgroundRevisionRef.current,
        ))
      ) {
        setError(
          ui(
            "The video background could not be sent to the meeting.",
            "Не удалось отправить видеофон участникам встречи.",
          ),
        );
      }
    },
    [isDemo, syncParticipants],
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
      const messageId =
        globalThis.crypto?.randomUUID?.() ??
        `chat-${timestamp}-${Math.random().toString(36).slice(2)}`;

      if (!isDemo && conference) {
        deliverChatWireMessage(
          conference,
          chatTextMessage(text, messageId, replyTo),
          recipients,
          timestamp,
        );
      }
      setChatMessages((messages) => [
        ...messages,
        {
          avatarUrl: localAvatarRef.current,
          id: messageId,
          isLocal: true,
          isPrivate,
          recipientIds: recipients.map((recipient) => recipient.id),
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
            id: `attachment-${attachmentId}`,
            isLocal: true,
            isPrivate,
            recipientIds: recipients.map((recipient) => recipient.id),
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

        const wireMessages: AttachmentWireMessage[] = [
          {
            id: attachmentId,
            kind: "start",
            mimeType: attachment.mimeType,
            name: attachment.name,
            size: attachment.size,
            totalChunks: chunks.length,
          },
          ...chunks.map((data, index) => ({
            data,
            id: attachmentId,
            index,
            kind: "chunk" as const,
          })),
          {
            id: attachmentId,
            kind: "end",
          },
        ];
        let sentThroughDataChannel = true;

        for (let index = 0; index < wireMessages.length; index += 1) {
          if (
            !deliverAttachmentDataWireMessage(
              conference!,
              wireMessages[index],
              recipients,
              timestamp,
            )
          ) {
            sentThroughDataChannel = false;
            break;
          }

          if (index > 0 && index % 20 === 0) {
            await new Promise<void>((resolve) =>
              window.setTimeout(resolve, 0),
            );
          }
        }

        if (!sentThroughDataChannel) {
          const fallbackId = `${attachmentId}-fallback`;

          for (let index = 0; index < wireMessages.length; index += 1) {
            const wireMessage = wireMessages[index];

            deliverChatWireMessage(
              conference!,
              attachmentMessage({
                ...wireMessage,
                id: fallbackId,
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
        }
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
    incomingVideoBackgroundsRef.current.clear();
    remoteVideoBackgroundsRef.current.clear();
    localVideoBackgroundDataRef.current = "";
    localVideoBackgroundRevisionRef.current = "";
    videoBackgroundEnabledRef.current = false;
    videoBackgroundChannelOpenRef.current = false;
    setVideoBackgroundAvailable(false);
    setVideoBackgroundEnabledState(false);
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

  const readAudioReceiverStats = useCallback(async (track: MediaStreamTrack) => {
    const receiver = conferenceRef.current?.getActivePeerConnection?.()?.findReceiverForTrack?.(track);
    return receiver?.getStats();
  }, []);

  return {
    audioInputId,
    audioOutputId,
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
    isVideoStarting,
    isVideoMuted,
    localAudioLevel,
    noiseSuppressionEnabled,
    noiseSuppressionSupported,
    participantConnections,
    sendChatAttachment,
    sendChatMessage,
    setAudioInputDevice,
    setAudioOutputDevice,
    setNoiseSuppressionEnabled,
    setVideoBackgroundEnabled,
    setVideoInputDevice,
    join,
    leave,
    participants,
    status,
    toggleAudio,
    setAudioMuted,
    readAudioReceiverStats,
    toggleScreenShare,
    toggleVideo,
    videoInputId,
    videoBackgroundAvailable,
    videoBackgroundEnabled,
  };
}
