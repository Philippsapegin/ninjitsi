"use client";

import { getMeetingAudioContext } from "./audioContext";

export type NinjitsiSound =
  | "connect"
  | "disconnect"
  | "initialRoomEnter"
  | "message";

const SOURCES: Record<NinjitsiSound, string> = {
  connect: "/Sounds/Nin.Connect.wav",
  disconnect: "/Sounds/Nin.Disconnect.wav",
  initialRoomEnter: "/Sounds/Nin.initial_room_enter.wav",
  message: "/Sounds/Nin.Message.wav",
};

const buffers = new Map<NinjitsiSound, Promise<AudioBuffer>>();
let outputContext: AudioContext | null = null;
let configuredOutput = "";

export function prepareNinjitsiSounds(outputDeviceId = "") {
  try {
    const context = getMeetingAudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (context.state !== "running") void context.resume().catch(() => undefined);
    if (outputContext !== context) { outputContext = context; configuredOutput = ""; }
    if (context.setSinkId && configuredOutput !== outputDeviceId) {
      configuredOutput = outputDeviceId;
      void context.setSinkId(outputDeviceId).catch(() => undefined);
    }
  } catch { /* Audio is optional. */ }
}

export function playNinjitsiSound(sound: NinjitsiSound) {
  if (typeof window === "undefined") {
    return;
  }

  void (async () => {
    const context = getMeetingAudioContext();
    // Do not open a separate OS playback session for every notification.
    // Also do not queue old alerts while autoplay is blocked.
    if (context.state !== "running") return;
    let buffer = buffers.get(sound);
    if (!buffer) {
      buffer = fetch(SOURCES[sound]).then(response => {
        if (!response.ok) throw new Error("Sound unavailable");
        return response.arrayBuffer();
      }).then(bytes => context.decodeAudioData(bytes));
      buffers.set(sound, buffer);
      void buffer.catch(() => buffers.delete(sound));
    }
    const decoded = await buffer;
    if (context.state !== "running") return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = decoded;
    gain.gain.value = 0.35;
    source.connect(gain).connect(context.destination);
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    source.start();
  })().catch(() => undefined);
}
