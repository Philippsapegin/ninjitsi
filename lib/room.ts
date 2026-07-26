export interface PendingJoinDetails {
  displayName: string;
  password: string;
  startAudioMuted: boolean;
  startVideoMuted: boolean;
}

const PENDING_JOIN_KEY = "ninjitsi.pendingJoin";

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

export function readPendingJoin(): PendingJoinDetails | null {
  const raw = sessionStorage.getItem(PENDING_JOIN_KEY);

  if (!raw) {
    return null;
  }

  try {
    sessionStorage.removeItem(PENDING_JOIN_KEY);
    return JSON.parse(raw) as PendingJoinDetails;
  } catch {
    sessionStorage.removeItem(PENDING_JOIN_KEY);
    return null;
  }
}
