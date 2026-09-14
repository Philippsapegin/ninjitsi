import { getStoredLocale, localize } from "./i18n";

export interface ClientProfile {
  avatarDataUrl: string;
  displayName: string;
  id: string;
  tileColor: string;
  updatedAt: number;
  videoBackgroundRevision: string;
}

export interface ProfileDraft {
  avatarDataUrl: string;
  displayName: string;
  profileId: string;
  tileColor: string;
  videoBackgroundDataUrl?: string;
  videoBackgroundRevision: string;
}

export interface SavedClientProfile extends ClientProfile {
  videoBackgroundDataUrl: string;
}

const PROFILES_KEY = "ninjitsi.profiles";
const SELECTED_PROFILE_KEY = "ninjitsi.selectedProfile";
const MAX_PROFILES = 12;
const MAX_AVATAR_FILE_SIZE = 8 * 1024 * 1024;
export const MAX_VIDEO_BACKGROUND_FILE_SIZE = 3 * 1024 * 1024;
export const DEFAULT_PROFILE_TILE_COLOR = "#485D78";
const AVATAR_SIZE = 128;
const PROFILE_DATABASE = "ninjitsi.profile-assets";
const PROFILE_DATABASE_VERSION = 1;
const VIDEO_BACKGROUND_STORE = "video-backgrounds";
const ALLOWED_VIDEO_BACKGROUND_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
]);

function canUseStorage() {
  return typeof window !== "undefined";
}

function createProfileId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function createBackgroundRevision() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `background-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function normalizeProfileTileColor(value: unknown) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toUpperCase()
    : DEFAULT_PROFILE_TILE_COLOR;
}

function openProfileDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }

    const request = indexedDB.open(
      PROFILE_DATABASE,
      PROFILE_DATABASE_VERSION,
    );

    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(VIDEO_BACKGROUND_STORE)) {
        request.result.createObjectStore(VIDEO_BACKGROUND_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Could not open profile storage.")),
    );
  });
}

async function accessStoredBackground<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openProfileDatabase();

  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(
        VIDEO_BACKGROUND_STORE,
        mode,
      );
      const request = action(transaction.objectStore(VIDEO_BACKGROUND_STORE));

      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("Could not access profile storage.")),
      );
      transaction.addEventListener("abort", () =>
        reject(
          transaction.error ?? new Error("Profile storage transaction failed."),
        ),
      );
    });
  } finally {
    database.close();
  }
}

export async function readProfileBackground(profileId: string) {
  if (!profileId) {
    return "";
  }

  try {
    const stored = await accessStoredBackground(
      "readonly",
      (store) => store.get(profileId),
    );

    return typeof stored === "string" ? stored : "";
  } catch {
    return "";
  }
}

async function storeProfileBackground(profileId: string, dataUrl: string) {
  if (dataUrl) {
    await accessStoredBackground("readwrite", (store) =>
      store.put(dataUrl, profileId),
    );
  } else {
    await accessStoredBackground("readwrite", (store) =>
      store.delete(profileId),
    );
  }
}

function removeStoredProfileBackground(profileId: string) {
  if (!profileId || typeof indexedDB === "undefined") {
    return;
  }

  void storeProfileBackground(profileId, "").catch(() => undefined);
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
        tileColor: normalizeProfileTileColor(profile.tileColor),
        updatedAt:
          typeof profile.updatedAt === "number" ? profile.updatedAt : 0,
        videoBackgroundRevision:
          typeof profile.videoBackgroundRevision === "string"
            ? profile.videoBackgroundRevision.slice(0, 180)
            : "",
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

export async function saveClientProfile(
  draft: ProfileDraft,
): Promise<SavedClientProfile> {
  const displayName = draft.displayName.trim();

  if (!displayName) {
    throw new Error(
      localize(
        getStoredLocale(),
        "Enter a profile name",
        "Укажите имя профиля",
      ),
    );
  }

  const profiles = readClientProfiles();
  const id = draft.profileId || createProfileId();
  const previousProfile = profiles.find((profile) => profile.id === id);
  const suppliedBackground = draft.videoBackgroundDataUrl;
  const videoBackgroundDataUrl =
    suppliedBackground ??
    (previousProfile?.videoBackgroundRevision
      ? await readProfileBackground(id)
      : "");
  let videoBackgroundRevision = videoBackgroundDataUrl
    ? draft.videoBackgroundRevision ||
      previousProfile?.videoBackgroundRevision ||
      createBackgroundRevision()
    : "";

  if (
    suppliedBackground !== undefined &&
    (Boolean(suppliedBackground) || Boolean(previousProfile?.videoBackgroundRevision))
  ) {
    try {
      await storeProfileBackground(id, suppliedBackground);
    } catch {
      throw new Error(
        localize(
          getStoredLocale(),
          "Could not save the video background in this browser",
          "Не удалось сохранить видеофон в этом браузере",
        ),
      );
    }
  } else if (videoBackgroundRevision && !videoBackgroundDataUrl) {
    videoBackgroundRevision = "";
  }

  const profile: ClientProfile = {
    avatarDataUrl: draft.avatarDataUrl,
    displayName,
    id,
    tileColor: normalizeProfileTileColor(draft.tileColor),
    updatedAt: Date.now(),
    videoBackgroundRevision,
  };
  const nextProfiles = [
    profile,
    ...profiles.filter((candidate) => candidate.id !== id),
  ].slice(0, MAX_PROFILES);

  localStorage.setItem(PROFILES_KEY, JSON.stringify(nextProfiles));
  localStorage.setItem(SELECTED_PROFILE_KEY, id);

  for (const discardedProfile of profiles) {
    if (!nextProfiles.some((candidate) => candidate.id === discardedProfile.id)) {
      removeStoredProfileBackground(discardedProfile.id);
    }
  }

  return { ...profile, videoBackgroundDataUrl };
}

export function deleteClientProfile(profileId: string): ClientProfile | null {
  if (!canUseStorage()) {
    return null;
  }

  const nextProfiles = readClientProfiles().filter(
    (profile) => profile.id !== profileId,
  );
  const nextSelected = nextProfiles[0] ?? null;

  removeStoredProfileBackground(profileId);

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
    tileColor: profile.tileColor,
    videoBackgroundDataUrl: undefined,
    videoBackgroundRevision: profile.videoBackgroundRevision,
  };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Could not read the image."));
      }
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Could not read the image.")),
    );
    reader.readAsDataURL(file);
  });
}

function verifyImage(dataUrl: string) {
  return new Promise<void>((resolve, reject) => {
    const image = new Image();

    image.addEventListener("load", () =>
      image.naturalWidth > 0 && image.naturalHeight > 0
        ? resolve()
        : reject(new Error("The image has no dimensions.")),
    );
    image.addEventListener("error", () =>
      reject(new Error("Could not decode the image.")),
    );
    image.src = dataUrl;
  });
}

export async function prepareVideoBackground(file: File) {
  if (!ALLOWED_VIDEO_BACKGROUND_TYPES.has(file.type)) {
    throw new Error(
      localize(
        getStoredLocale(),
        "Choose a JPG, PNG, or GIF image",
        "Выберите изображение JPG, PNG или GIF",
      ),
    );
  }

  if (file.size > MAX_VIDEO_BACKGROUND_FILE_SIZE) {
    throw new Error(
      localize(
        getStoredLocale(),
        "The background file must not exceed 3 MB",
        "Файл фона не должен превышать 3 МБ",
      ),
    );
  }

  const dataUrl = await readFileAsDataUrl(file);

  await verifyImage(dataUrl);
  return {
    dataUrl,
    revision: createBackgroundRevision(),
  };
}

export async function prepareAvatar(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error(
      localize(getStoredLocale(), "Choose an image", "Выберите изображение"),
    );
  }

  if (file.size > MAX_AVATAR_FILE_SIZE) {
    throw new Error(
      localize(
        getStoredLocale(),
        "The avatar file must be smaller than 8 MB",
        "Файл аватарки должен быть меньше 8 МБ",
      ),
    );
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
