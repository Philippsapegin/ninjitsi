import type { JitsiMeetJSLibrary, JitsiTrackLike } from "./types";

export function isNoiseSuppressionSupported() {
  return typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getSupportedConstraints?.().noiseSuppression === true;
}

export async function createBrowserMicrophoneTrack(
  library: JitsiMeetJSLibrary,
  deviceId: string,
  enabled: boolean,
): Promise<JitsiTrackLike> {
  if (!isNoiseSuppressionSupported() || !library.createLocalTracksFromMediaStreams) {
    throw new Error("Browser noise suppression is unavailable for this microphone.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      noiseSuppression: enabled,
    },
    video: false,
  });
  const nativeTrack = stream.getAudioTracks()[0];

  try {
    if (!nativeTrack || nativeTrack.getSettings().noiseSuppression !== enabled) {
      throw new Error("The browser did not apply the noise suppression setting.");
    }

    const tracks = library.createLocalTracksFromMediaStreams([{
      mediaType: "audio",
      sourceType: "mic",
      stream,
      track: nativeTrack,
    }]);
    const track = tracks.find((candidate) => candidate.getType() === "audio");

    if (!track) {
      throw new Error("Jitsi did not wrap the microphone track.");
    }

    return track;
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}
