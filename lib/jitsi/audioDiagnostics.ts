interface AudioDiagnostic { at: string; participantId: string; [key: string]: unknown }
const samples: AudioDiagnostic[] = [];

export function recordAudioDiagnostic(participantId: string, values: Record<string, unknown>) {
  samples.push({ at: new Date().toISOString(), participantId, ...values });
  if (samples.length > 600) samples.shift();
}

export function downloadAudioDiagnostics() {
  const blob = new Blob([JSON.stringify({ version: 1, samples }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ninjitsi-audio-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
