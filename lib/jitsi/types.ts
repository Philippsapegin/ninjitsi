export type MediaType = "audio" | "video";

export interface JitsiTrackEffect {
  isEnabled: (track: JitsiTrackLike) => boolean;
  startEffect: (stream: MediaStream) => MediaStream;
  stopEffect: () => void;
}

export interface JitsiTrackLike {
  addEventListener?: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
  attach: (element: HTMLElement) => Promise<void>;
  detach: (element?: HTMLElement) => void;
  dispose: () => Promise<void>;
  getDeviceId?: () => string;
  getParticipantId?: () => string;
  getType: () => MediaType;
  getVideoType?: () => "camera" | "desktop" | undefined;
  isLocal?: () => boolean;
  isMuted: () => boolean;
  mute: () => Promise<void>;
  setEffect?: (effect?: JitsiTrackEffect) => Promise<void>;
  unmute: () => Promise<void>;
}

export interface JitsiParticipantLike {
  getDisplayName: () => string;
  getId: () => string;
  getProperty?: (name: string) => unknown;
  getRole: () => string;
  getTracks: () => JitsiTrackLike[];
  isAudioMuted: () => boolean;
  isHidden?: () => boolean;
  isVideoMuted: () => boolean;
}

export interface JitsiConferenceLike {
  addTrack: (track: JitsiTrackLike) => Promise<void>;
  getLocalTracks: (mediaType?: MediaType) => JitsiTrackLike[];
  getParticipants: () => JitsiParticipantLike[];
  isModerator: () => boolean;
  join: (password?: string) => void;
  leave: () => Promise<void>;
  lock: (password: string) => Promise<void>;
  myUserId?: () => string;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  removeTrack: (track: JitsiTrackLike) => Promise<void>;
  replaceTrack?: (
    oldTrack: JitsiTrackLike,
    newTrack: JitsiTrackLike,
  ) => Promise<void>;
  sendEndpointMessage?: (participantId: string, payload: object) => void;
  sendMessage?: (
    message: object | string,
    participantId?: string,
    sendThroughVideobridge?: boolean,
  ) => void;
  sendTextMessage?: (message: string) => void;
  setDisplayName: (displayName: string) => void;
  setLocalParticipantProperty?: (name: string, value: string) => void;
}

export interface JitsiConnectionLike {
  addEventListener: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
  connect: () => void;
  disconnect: () => void;
  initJitsiConference: (
    roomName: string,
    options: Record<string, unknown>,
  ) => JitsiConferenceLike;
}

interface JitsiEventCollection {
  conference: Record<string, string>;
  connection: Record<string, string>;
  connectionQuality: Record<string, string>;
  e2eping: Record<string, string>;
  track: Record<string, string>;
}

export interface JitsiMeetJSLibrary {
  JitsiConnection: new (
    appId: string | null,
    token: string | null,
    options: Record<string, unknown>,
  ) => JitsiConnectionLike;
  createLocalTracks: (options: {
    cameraDeviceId?: string;
    devices: Array<"audio" | "video" | "desktop">;
    micDeviceId?: string;
    resolution?: number;
  }) => Promise<JitsiTrackLike[]>;
  events: JitsiEventCollection;
  init: (options?: Record<string, unknown>) => void;
  logLevels?: Record<string, unknown>;
  setLogLevel?: (level: unknown) => void;
}

export interface ParticipantView {
  audioMuted: boolean;
  audioTrack?: JitsiTrackLike;
  avatarUrl?: string;
  displayName: string;
  id: string;
  isDominantSpeaker: boolean;
  isLocal: boolean;
  isModerator: boolean;
  isScreenSharing: boolean;
  videoMuted: boolean;
  videoTrack?: JitsiTrackLike;
}

export interface ChatMessage {
  attachments?: ChatAttachment[];
  avatarUrl?: string;
  id: string;
  isPrivate?: boolean;
  isLocal: boolean;
  recipientIds?: string[];
  recipientNames?: string[];
  replyTo?: ChatReplyReference;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export interface ChatReplyReference {
  messageId: string;
  senderName: string;
  text: string;
}

export interface ChatAttachment {
  dataUrl: string;
  id: string;
  mimeType: string;
  name: string;
  size: number;
}

export interface ParticipantConnectionInfo {
  displayName: string;
  id: string;
  isLocal: boolean;
  pingMs: number | null;
  quality: number | null;
}

export type MeetingStatus =
  | "idle"
  | "loading"
  | "connecting"
  | "joined"
  | "reconnecting"
  | "failed"
  | "left";
