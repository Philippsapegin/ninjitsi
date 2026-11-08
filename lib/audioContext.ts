let sharedContext: AudioContext | null = null;

export function getMeetingAudioContext() {
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new window.AudioContext();
  }
  return sharedContext;
}
