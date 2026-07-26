export type MediaType = "audio" | "video";

export interface JitsiTrackLike {
  addEventListener?: (event: string, listener: () => void) => void;
  attach: (element: HTMLElement) => Promise<void>;
  detach: (element?: HTMLElement) => void;
  dispose: () => Promise<void>;
  getParticipantId?: () => string;
  getType: () => MediaType;
  getVideoType?: () => "camera" | "desktop" | undefined;
  isLocal?: () => boolean;
  isMuted: () => boolean;
  mute: () => Promise<void>;
  unmute: () => Promise<void>;
}

export interface JitsiParticipantLike {
  getDisplayName: () => string;
  getId: () => string;
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
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  removeTrack: (track: JitsiTrackLike) => Promise<void>;
  setDisplayName: (displayName: string) => void;
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
  track: Record<string, string>;
}

export interface JitsiMeetJSLibrary {
  JitsiConnection: new (
    appId: string | null,
    token: string | null,
    options: Record<string, unknown>,
  ) => JitsiConnectionLike;
  createLocalTracks: (options: {
    devices: Array<"audio" | "video" | "desktop">;
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
  displayName: string;
  id: string;
  isDominantSpeaker: boolean;
  isLocal: boolean;
  isModerator: boolean;
  isScreenSharing: boolean;
  videoMuted: boolean;
  videoTrack?: JitsiTrackLike;
}

export type MeetingStatus =
  | "idle"
  | "loading"
  | "connecting"
  | "joined"
  | "reconnecting"
  | "failed"
  | "left";
