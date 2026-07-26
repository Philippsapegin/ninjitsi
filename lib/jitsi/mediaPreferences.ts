export interface MediaPreferences {
  audioInputId: string;
  noiseSuppressionEnabled: boolean;
  videoInputId: string;
}

const MEDIA_PREFERENCES_KEY = "ninjitsi.mediaPreferences";

export const DEFAULT_MEDIA_PREFERENCES: MediaPreferences = {
  audioInputId: "",
  noiseSuppressionEnabled: false,
  videoInputId: "",
};

export function readMediaPreferences(): MediaPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_MEDIA_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(
      localStorage.getItem(MEDIA_PREFERENCES_KEY) ?? "{}",
    ) as Partial<MediaPreferences>;

    return {
      audioInputId:
        typeof parsed.audioInputId === "string" ? parsed.audioInputId : "",
      noiseSuppressionEnabled: Boolean(parsed.noiseSuppressionEnabled),
      videoInputId:
        typeof parsed.videoInputId === "string" ? parsed.videoInputId : "",
    };
  } catch {
    return DEFAULT_MEDIA_PREFERENCES;
  }
}

export function saveMediaPreferences(preferences: MediaPreferences) {
  localStorage.setItem(MEDIA_PREFERENCES_KEY, JSON.stringify(preferences));
}
