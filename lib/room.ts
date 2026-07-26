export interface PendingJoinDetails {
  avatarDataUrl: string;
  displayName: string;
  isCreator: boolean;
  password: string;
  profileId: string;
  startAudioMuted: boolean;
  startVideoMuted: boolean;
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
): void {
  sessionStorage.setItem(
    `${CREATED_ROOM_PREFIX}${roomName}`,
    JSON.stringify({ password }),
  );
}

export function readCreatedRoomPassword(
  roomName: string,
): string | null {
  const raw = sessionStorage.getItem(`${CREATED_ROOM_PREFIX}${roomName}`);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { password?: unknown };

    return typeof parsed.password === "string" ? parsed.password : null;
  } catch {
    return null;
  }
}

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
    };
  } catch {
    sessionStorage.removeItem(PENDING_JOIN_KEY);
    return null;
  }
}
