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
  outputDeviceId: string;
  participantId: string;
  track: JitsiTrackLike;
  volume: number;
}

export function AudioTrack({
  outputDeviceId,
  participantId,
  track,
  volume,
}: AudioTrackProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const outputRef = useRef<HTMLAudioElement>(null);
  const gainRef = useRef<GainNode | null>(null);
  const outputModeRef = useRef<"webaudio" | "element">("element");
  const outputDeviceIdRef = useRef(outputDeviceId);
  const appliedOutputDeviceIdRef = useRef(outputDeviceId);
  const volumeRef = useRef(volume);
  const nativeTrack = track.getTrack?.();

  useEffect(() => {
    outputDeviceIdRef.current = outputDeviceId;
  }, [outputDeviceId]);

  useEffect(() => {
    const element = audioRef.current;
    const output = outputRef.current;

    if (!element || !output) {
      return;
    }

    let cancelled = false;
    let source: MediaStreamAudioSourceNode | null = null;
    let gain: GainNode | null = null;
    let destination: MediaStreamAudioDestinationNode | null = null;
    let context: AudioContext | null = null;
    let attachedFallback = false;

    try {
      if (!nativeTrack || nativeTrack.kind !== "audio") {
        throw new Error("The remote audio track is unavailable.");
      }

      context = getAudioContext();
      gain = context.createGain();
      destination = context.createMediaStreamDestination();
      source = context.createMediaStreamSource(new MediaStream([nativeTrack]));
      source.connect(gain);
      gain.connect(destination);
      gain.gain.value = volumeRef.current;
      gainRef.current = gain;
      output.srcObject = destination.stream;
      outputModeRef.current = "webaudio";
      output.dataset.audioOutput = "remote";
      delete element.dataset.audioOutput;
      element.dataset.audioGain = "webaudio";
    } catch {
      source?.disconnect();
      gain?.disconnect();
      gainRef.current = null;
      element.dataset.audioGain = "element";
      element.volume = Math.min(1, Math.max(0, volumeRef.current));
      outputModeRef.current = "element";
      element.dataset.audioOutput = "remote";
      delete output.dataset.audioOutput;
    }

    const activeOutput =
      outputModeRef.current === "webaudio" ? output : element;

    const start = async () => {
      if ("setSinkId" in activeOutput) {
        try {
          await activeOutput.setSinkId(outputDeviceIdRef.current);
        } catch {
          await activeOutput.setSinkId("").catch(() => undefined);
        }
      }

      if (cancelled) {
        return;
      }

      let graphReady = true;
      if (context) {
        let resumeTimer: number | undefined;
        graphReady = await Promise.race([
          context.resume().then(
            () => context?.state === "running",
            () => false,
          ),
          new Promise<boolean>((resolve) => {
            resumeTimer = window.setTimeout(() => resolve(false), 1500);
          }),
        ]);
        window.clearTimeout(resumeTimer);
      }
      if (outputModeRef.current === "webaudio" && graphReady) {
        try {
          await output.play();
          return;
        } catch {
          // Fall back to direct playback when the processed stream is blocked.
        }
      }

      if (outputModeRef.current === "webaudio") {
        output.pause();
        output.srcObject = null;
        source?.disconnect();
        gain?.disconnect();
        gainRef.current = null;
        outputModeRef.current = "element";
        delete output.dataset.audioOutput;
        element.dataset.audioOutput = "remote";
        element.dataset.audioGain = "element";
        element.volume = Math.min(1, Math.max(0, volumeRef.current));
      }

      if (!cancelled) {
        try {
          await track.attach(element);
          attachedFallback = true;
          if (cancelled) {
            track.detach(element);
            attachedFallback = false;
          }
        } catch {
          // A failed attachment leaves this participant silent, not the call.
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      gainRef.current = null;
      source?.disconnect();
      gain?.disconnect();
      output.pause();
      output.srcObject = null;
      if (attachedFallback) {
        track.detach(element);
      }
    };
  }, [track, nativeTrack]);

  useEffect(() => {
    if (appliedOutputDeviceIdRef.current === outputDeviceId) {
      return;
    }
    appliedOutputDeviceIdRef.current = outputDeviceId;

    const activeOutput =
      outputModeRef.current === "webaudio"
        ? outputRef.current
        : audioRef.current;

    if (!activeOutput || !("setSinkId" in activeOutput)) {
      return;
    }

    void activeOutput.setSinkId(outputDeviceId).catch(() => {
      void activeOutput.setSinkId("").catch(() => undefined);
    });
  }, [outputDeviceId]);

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
    <>
      <audio
        autoPlay
        data-audio-source="remote"
        data-output-volume={volume}
        data-participant-audio={participantId}
        ref={audioRef}
      />
      <audio
        autoPlay
        data-audio-sink="remote"
        data-participant-audio={participantId}
        ref={outputRef}
      />
    </>
  );
}
