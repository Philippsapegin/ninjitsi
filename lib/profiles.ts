export interface ClientProfile {
  avatarDataUrl: string;
  displayName: string;
  id: string;
  updatedAt: number;
}

export interface ProfileDraft {
  avatarDataUrl: string;
  displayName: string;
  profileId: string;
}

const PROFILES_KEY = "ninjitsi.profiles";
const SELECTED_PROFILE_KEY = "ninjitsi.selectedProfile";
const MAX_PROFILES = 12;
const MAX_AVATAR_FILE_SIZE = 8 * 1024 * 1024;
const AVATAR_SIZE = 128;

function canUseStorage() {
  return typeof window !== "undefined";
}

function createProfileId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function readClientProfiles(): ClientProfile[] {
  if (!canUseStorage()) {
    return [];
  }

  try {
    const parsed = JSON.parse(
      localStorage.getItem(PROFILES_KEY) ?? "[]",
    ) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (profile): profile is ClientProfile =>
          Boolean(
            profile &&
              typeof profile === "object" &&
              "id" in profile &&
              typeof profile.id === "string" &&
              "displayName" in profile &&
              typeof profile.displayName === "string",
          ),
      )
      .map((profile) => ({
        avatarDataUrl:
          typeof profile.avatarDataUrl === "string"
            ? profile.avatarDataUrl
            : "",
        displayName: profile.displayName,
        id: profile.id,
        updatedAt:
          typeof profile.updatedAt === "number" ? profile.updatedAt : 0,
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_PROFILES);
  } catch {
    return [];
  }
}

export function readSelectedProfile(): ClientProfile | null {
  if (!canUseStorage()) {
    return null;
  }

  const profiles = readClientProfiles();
  const selectedId = localStorage.getItem(SELECTED_PROFILE_KEY);

  return (
    profiles.find((profile) => profile.id === selectedId) ??
    profiles[0] ??
    null
  );
}

export function saveClientProfile(draft: ProfileDraft): ClientProfile {
  const displayName = draft.displayName.trim();

  if (!displayName) {
    throw new Error("Укажите имя профиля");
  }

  const profiles = readClientProfiles();
  const id = draft.profileId || createProfileId();
  const profile: ClientProfile = {
    avatarDataUrl: draft.avatarDataUrl,
    displayName,
    id,
    updatedAt: Date.now(),
  };
  const nextProfiles = [
    profile,
    ...profiles.filter((candidate) => candidate.id !== id),
  ].slice(0, MAX_PROFILES);

  localStorage.setItem(PROFILES_KEY, JSON.stringify(nextProfiles));
  localStorage.setItem(SELECTED_PROFILE_KEY, id);

  return profile;
}

export function deleteClientProfile(profileId: string): ClientProfile | null {
  if (!canUseStorage()) {
    return null;
  }

  const nextProfiles = readClientProfiles().filter(
    (profile) => profile.id !== profileId,
  );
  const nextSelected = nextProfiles[0] ?? null;

  localStorage.setItem(PROFILES_KEY, JSON.stringify(nextProfiles));
  if (nextSelected) {
    localStorage.setItem(SELECTED_PROFILE_KEY, nextSelected.id);
  } else {
    localStorage.removeItem(SELECTED_PROFILE_KEY);
  }

  return nextSelected;
}

export function profileToDraft(profile: ClientProfile): ProfileDraft {
  return {
    avatarDataUrl: profile.avatarDataUrl,
    displayName: profile.displayName,
    profileId: profile.id,
  };
}

export async function prepareAvatar(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Выберите изображение");
  }

  if (file.size > MAX_AVATAR_FILE_SIZE) {
    throw new Error("Файл аватарки должен быть меньше 8 МБ");
  }

  const bitmap = await createImageBitmap(file);
  const sourceSize = Math.min(bitmap.width, bitmap.height);
  const sourceX = (bitmap.width - sourceSize) / 2;
  const sourceY = (bitmap.height - sourceSize) / 2;
  const canvas = document.createElement("canvas");

  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  canvas
    .getContext("2d")
    ?.drawImage(
      bitmap,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    );
  bitmap.close();

  return canvas.toDataURL("image/webp", 0.82);
}
