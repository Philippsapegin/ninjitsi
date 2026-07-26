export interface PendingJoinDetails {
  avatarDataUrl: string;
  displayName: string;
  password: string;
  profileId: string;
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
    const parsed = JSON.parse(raw) as Partial<PendingJoinDetails>;

    if (typeof parsed.displayName !== "string") {
      return null;
    }

    return {
      avatarDataUrl:
        typeof parsed.avatarDataUrl === "string" ? parsed.avatarDataUrl : "",
      displayName: parsed.displayName,
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
