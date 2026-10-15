import type { JitsiConferenceLike, JitsiTrackLike } from "./types";

export const SCREEN_SHARING_PROPERTY = "ninjitsiScreenSharing";
export const VIDEO_RECOVERY_EVENT = "ninjitsi:recover-video";

export function isTrackEnded(track: JitsiTrackLike) {
  return track.getTrack?.()?.readyState === "ended";
}

export function pickPreferredVideo(tracks: JitsiTrackLike[], screenSharing?: boolean | string) {
  const videos = tracks.filter(track => track.getType() === "video" && !isTrackEnded(track));
  const desktop = screenSharing === false ? undefined : videos.find(track =>
    track.getVideoType?.() === "desktop" && !track.isMuted() &&
    (typeof screenSharing !== "string" || track.getSourceName?.() === screenSharing));
  const camera = videos.find(track => track.getVideoType?.() !== "desktop");
  return desktop ?? camera;
}

export function receiveVideoConstraints(conference: JitsiConferenceLike, suspendedSource?: string) {
  const constraints: Record<string, { maxHeight: number }> = {};
  for (const participant of conference.getParticipants()) {
    for (const track of participant.getTracks()) {
      const source = track.getSourceName?.();
      if (track.getType() === "video" && source && !isTrackEnded(track)) {
        constraints[source] = { maxHeight: source === suspendedSource ? 0
          : track.getVideoType?.() === "desktop" ? 1080 : 720 };
      }
    }
  }
  return { lastN: -1, defaultConstraints: { maxHeight: 720 }, constraints };
}

export function applyReceiveVideoPolicy(conference: JitsiConferenceLike, suspendedSource?: string) {
  // Do not override bandwidth estimation with an assumed bandwidth or a forced
  // bitrate: these are quality ceilings, the bridge still adapts to the network.
  conference.setReceiverConstraints?.(receiveVideoConstraints(conference, suspendedSource));
}
