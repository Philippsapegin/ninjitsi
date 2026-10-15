import { createBrowserMicrophoneTrack, isNoiseSuppressionSupported } from "./noiseSuppression";
import type { JitsiMeetJSLibrary } from "./types";

export function systemMicrophoneId(userAgent: string) {
  // "default" is a Chromium alias, not a portable MediaDeviceInfo.deviceId.
  // Safari (including CriOS on iPhone) and Firefox must choose the real default.
  return /\b(?:Chrome|HeadlessChrome|Chromium)\//.test(userAgent) &&
    !/\b(?:CriOS|FxiOS|EdgiOS)\//.test(userAgent) ? "default" : "";
}

function mediaErrorNames(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const name = "name" in error ? String(error.name) : "";
  const gum = "gum" in error ? error.gum : undefined;
  const original = gum && typeof gum === "object" && "error" in gum ? gum.error : undefined;
  return `${name} ${original && original !== error ? mediaErrorNames(original) : ""}`;
}

export function isDeviceSelectionError(error: unknown): boolean {
  return /not.?found|Overconstrained|ConstraintNotSatisfied|constraint_failed/i.test(mediaErrorNames(error));
}

export function isMediaPermissionError(error: unknown): boolean {
  return /NotAllowed|PermissionDenied|permission_denied|SecurityError/i.test(mediaErrorNames(error));
}

export async function createLocalTrack(
  library: JitsiMeetJSLibrary,
  device: "audio" | "video" | "desktop",
  deviceId = "",
  noiseSuppressionEnabled = false,
  browserCapture = true,
) {
  const defaultId = device === "audio" ? systemMicrophoneId(navigator.userAgent) : "";
  const requestedId = device === "audio" && (!deviceId || deviceId === "default")
    ? defaultId : deviceId;
  const capture = async (id: string) => {
    if (browserCapture && device === "audio" && isNoiseSuppressionSupported() &&
        library.createLocalTracksFromMediaStreams) {
      return createBrowserMicrophoneTrack(library, id, noiseSuppressionEnabled);
    }
    const tracks = await library.createLocalTracks({
      devices: [device],
      ...(device === "audio" && id ? { micDeviceId: id } : {}),
      ...(device === "video" && id ? { cameraDeviceId: id } : {}),
      ...(device === "video" ? { resolution: 720 } : {}),
    });
    const track = tracks.find(candidate => device === "desktop"
      ? candidate.getVideoType?.() === "desktop" : candidate.getType() === device);
    await Promise.allSettled(tracks.filter(candidate => candidate !== track).map(track => track.dispose()));
    if (!track) throw new Error(`Jitsi did not create a ${device} track`);
    return track;
  };
  try {
    return await capture(requestedId);
  } catch (error) {
    // Saved identifiers can expire after permissions change or a headset is
    // unplugged. Retry only device-selection errors, never permission denial.
    if (device !== "desktop" && requestedId && isDeviceSelectionError(error)) {
      return capture("");
    }
    throw error;
  }
}
