import { normalizeProfileTileColor } from "./profiles";

export interface PendingJoinDetails {
  avatarDataUrl: string;
  displayName: string;
  isCreator: boolean;
  password: string;
  profileId: string;
  startAudioMuted: boolean;
  startVideoMuted: boolean;
  tileColor: string;
  videoBackgroundRevision: string;
}

const PENDING_JOIN_KEY = "ninjitsi.pendingJoin";
const CREATED_ROOM_PREFIX = "ninjitsi.createdRoom.";

export function normalizeRoomName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-zа-яё0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function savePendingJoin(details: PendingJoinDetails): void {
  sessionStorage.setItem(PENDING_JOIN_KEY, JSON.stringify(details));
}

export function rememberCreatedRoom(
  roomName: string,
  password: string,
  ownerToken?: string,
): void {
  sessionStorage.setItem(
    `${CREATED_ROOM_PREFIX}${roomName}`,
    JSON.stringify({ password, ownerToken }),
  );
}

function readCreatedRoom(roomName: string) {
  const raw = sessionStorage.getItem(`${CREATED_ROOM_PREFIX}${roomName}`);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { password?: unknown; ownerToken?: unknown };
    return {
      password: typeof parsed.password === "string" ? parsed.password : null,
      ownerToken: typeof parsed.ownerToken === "string" ? parsed.ownerToken : null,
    };
  } catch {
    return null;
  }
}

export const readCreatedRoomPassword = (roomName: string) =>
  readCreatedRoom(roomName)?.password ?? null;

export const readCreatedRoomOwnerToken = (roomName: string) =>
  readCreatedRoom(roomName)?.ownerToken ?? null;

export function readPendingJoin(): PendingJoinDetails | null {
  const raw = sessionStorage.getItem(PENDING_JOIN_KEY);

  if (!raw) {
    return null;
  }

  try {
    sessionStorage.removeItem(PENDING_JOIN_KEY);
    const parsed = JSON.parse(raw) as Partial<PendingJoinDetails>;

    if (typeof parsed.displayName !== "string") {
      return null;
    }

    return {
      avatarDataUrl:
        typeof parsed.avatarDataUrl === "string" ? parsed.avatarDataUrl : "",
      displayName: parsed.displayName,
      isCreator: Boolean(parsed.isCreator),
      password: typeof parsed.password === "string" ? parsed.password : "",
      profileId: typeof parsed.profileId === "string" ? parsed.profileId : "",
      startAudioMuted: Boolean(parsed.startAudioMuted),
      startVideoMuted: Boolean(parsed.startVideoMuted),
      tileColor: normalizeProfileTileColor(parsed.tileColor),
      videoBackgroundRevision:
        typeof parsed.videoBackgroundRevision === "string"
          ? parsed.videoBackgroundRevision.slice(0, 180)
          : "",
    };
  } catch {
    sessionStorage.removeItem(PENDING_JOIN_KEY);
    return null;
  }
}
