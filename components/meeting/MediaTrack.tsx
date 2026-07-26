"use client";

import { useEffect, useRef } from "react";
import type { JitsiTrackLike } from "@/lib/jitsi/types";

let sharedAudioContext: AudioContext | null = null;

function getAudioContext() {
  if (!sharedAudioContext) {
    sharedAudioContext = new window.AudioContext();
  }

  return sharedAudioContext;
}

interface VideoTrackProps {
  isLocal: boolean;
  track: JitsiTrackLike;
}

export function VideoTrack({ isLocal, track }: VideoTrackProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;

    if (!element) {
      return;
    }

    void track.attach(element);

    return () => track.detach(element);
  }, [track]);

  return (
    <video
      autoPlay
      muted={isLocal}
      playsInline
      ref={videoRef}
    />
  );
}

interface AudioTrackProps {
  track: JitsiTrackLike;
  volume: number;
}

export function AudioTrack({ track, volume }: AudioTrackProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const gainRef = useRef<GainNode | null>(null);
  const volumeRef = useRef(volume);

  useEffect(() => {
    const element = audioRef.current;

    if (!element) {
      return;
    }

    let cancelled = false;
    let source: MediaElementAudioSourceNode | null = null;
    let gain: GainNode | null = null;

    void Promise.resolve(track.attach(element)).then(() => {
      if (cancelled) {
        return;
      }

      try {
        const context = getAudioContext();
        gain = context.createGain();

        source = context.createMediaElementSource(element);
        source.connect(gain);
        gain.connect(context.destination);
        gain.gain.value = volumeRef.current;
        gainRef.current = gain;
        element.volume = 1;
        element.dataset.audioGain = "webaudio";
        void context.resume();
      } catch {
        element.dataset.audioGain = "element";
        element.volume = Math.min(1, Math.max(0, volumeRef.current));
      }
    });

    return () => {
      cancelled = true;
      gainRef.current = null;
      source?.disconnect();
      gain?.disconnect();
      track.detach(element);
    };
  }, [track]);

  useEffect(() => {
    const element = audioRef.current;
    const nextVolume = Math.min(2, Math.max(0, volume));

    volumeRef.current = nextVolume;
    if (gainRef.current && sharedAudioContext) {
      gainRef.current.gain.setTargetAtTime(
        nextVolume,
        sharedAudioContext.currentTime,
        0.015,
      );
    } else if (element) {
      element.volume = Math.min(1, nextVolume);
    }
  }, [volume]);

  return (
    <audio
      autoPlay
      data-output-volume={volume}
      ref={audioRef}
    />
  );
}
