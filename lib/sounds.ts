"use client";

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

const activeSounds = new Set<HTMLAudioElement>();

export function playNinjitsiSound(sound: NinjitsiSound) {
  if (typeof window === "undefined") {
    return;
  }

  const audio = new Audio(SOURCES[sound]);

  audio.preload = "auto";
  audio.volume = 0.72;
  activeSounds.add(audio);

  const release = () => {
    activeSounds.delete(audio);
    audio.removeEventListener("ended", release);
    audio.removeEventListener("error", release);
  };

  audio.addEventListener("ended", release);
  audio.addEventListener("error", release);
  void audio.play().catch(release);
}
