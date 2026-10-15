"use client";

import { useEffect, useRef } from "react";
import type { JitsiTrackLike } from "@/lib/jitsi/types";
import { createVideoHealthMonitor } from "@/lib/jitsi/videoHealth";
import { VIDEO_RECOVERY_EVENT } from "@/lib/jitsi/videoPolicy";

let sharedAudioContext: AudioContext | null = null;

function getAudioContext() {
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new window.AudioContext();
  }

  return sharedAudioContext;
}

interface VideoTrackProps {
  isLocal: boolean;
  track: JitsiTrackLike;
}

export function VideoTrack({ track, isLocal }: VideoTrackProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const nativeTrack = track.getTrack?.();

  useEffect(() => {
    const element = videoRef.current;

    if (!element) {
      return;
    }

    let cancelled = false;
    let attaching = false;
    let attached = false;
    const monitor = createVideoHealthMonitor();
    const attach = async () => {
      if (cancelled || attaching) return;
      attaching = true;
      try {
        if (attached) track.detach(element);
        attached = true;
        await track.attach(element);
        if (cancelled) return;
        element.muted = true;
        await element.play();
      } catch {
        // Muted video can still be interrupted by backgrounding/Safari. Retry
        // on visibility/unmute and through the watchdog, without unhandled play().
      } finally {
        attaching = false;
      }
    };
    const resume = () => {
      if (document.visibilityState === "visible") void attach();
    };
    void attach();
    document.addEventListener("visibilitychange", resume);
    nativeTrack?.addEventListener("unmute", resume);
    const timer = window.setInterval(() => {
      const active = document.visibilityState === "visible" && !track.isMuted() &&
        nativeTrack?.readyState !== "ended" && nativeTrack?.enabled !== false;
      const action = monitor({
        now: performance.now(),
        frames: element.getVideoPlaybackQuality?.().totalVideoFrames ?? element.currentTime,
        height: element.videoHeight,
        active,
        // A still screen may legitimately deliver no new frames for minutes.
        screen: isLocal || (track.getVideoType?.() === "desktop" && element.videoWidth > 0),
      });
      if (active && element.paused) void attach();
      else if (action === "reattach") void attach();
      else if (action === "resubscribe") {
        window.dispatchEvent(new CustomEvent(VIDEO_RECOVERY_EVENT, { detail: { track } }));
      }
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      nativeTrack?.removeEventListener("unmute", resume);
      if (attached) track.detach(element);
    };
  }, [isLocal, nativeTrack, track]);

  return (
    <video
      autoPlay
      // A Jitsi stream can contain audio and video. Audio is exclusively
      // played by AudioSinks, otherwise volume controls and echo prevention
      // can be bypassed by a video element.
      muted
      playsInline
      ref={videoRef}
    />
  );
}

interface AudioTrackProps {
  onPlaybackBlocked?: (blocked: boolean) => void;
  outputDeviceId: string;
  participantId: string;
  track: JitsiTrackLike;
  volume: number;
}

export function AudioTrack({
  onPlaybackBlocked,
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
  const onPlaybackBlockedRef = useRef(onPlaybackBlocked);
  const nativeTrack = track.getTrack?.();

  useEffect(() => {
    outputDeviceIdRef.current = outputDeviceId;
  }, [outputDeviceId]);

  useEffect(() => {
    onPlaybackBlockedRef.current = onPlaybackBlocked;
  }, [onPlaybackBlocked]);

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
    let attached = false;
    let starting = false;

    // Chromium does not feed a remote WebRTC track into Web Audio until a
    // media element consumes the ORIGINAL track. Playing the processed stream
    // alone succeeds but produces silence. Keep this source playing muted.
    element.muted = true;

    const applyOutputDevice = async (target: HTMLAudioElement) => {
      if ("setSinkId" in target) {
        await target.setSinkId(outputDeviceIdRef.current).catch(() =>
          target.setSinkId("").catch(() => undefined),
        );
      }
    };

    const fallback = async () => {
      output.pause();
      output.srcObject = null;
      source?.disconnect();
      gain?.disconnect();
      destination?.stream.getTracks().forEach((track) => track.stop());
      gainRef.current = null;
      outputModeRef.current = "element";
      delete output.dataset.audioOutput;
      element.dataset.audioOutput = "remote";
      element.dataset.audioGain = "element";
      element.volume = Math.min(1, Math.max(0, volumeRef.current));
      element.muted = false;
      await applyOutputDevice(element);
      if (!cancelled) {
        await element.play();
      }
    };

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

    const start = async () => {
      if (cancelled || starting) {
        return;
      }
      starting = true;
      try {
        if (!attached) {
          // Register the source with Jitsi too: its track replacement and
          // first-media diagnostics depend on attached containers.
          attached = true;
          await track.attach(element);
          if (nativeTrack && !cancelled) {
            // Do not let a bundled/stalled video track gate audio playback.
            element.srcObject = new MediaStream([nativeTrack]);
          }
        }
        if (cancelled) {
          return;
        }
        await element.play();

        if (outputModeRef.current === "element") {
          await fallback();
          return;
        }

        let graphReady = false;
        let resumeTimer: number | undefined;
        graphReady = await Promise.race([
          context!.resume().then(
            () => context?.state === "running",
            () => false,
          ),
          new Promise<boolean>((resolve) => {
            resumeTimer = window.setTimeout(() => resolve(false), 1500);
          }),
        ]);
        window.clearTimeout(resumeTimer);
        if (cancelled) {
          return;
        }
        if (graphReady) {
          try {
            await applyOutputDevice(output);
            if (!cancelled) {
              await output.play();
            }
            return;
          } catch {
            // Direct playback remains usable if processing/autoplay fails.
          }
        }
        await fallback();
      } catch (error) {
        if (!cancelled) {
          element.dataset.audioPlayback = "blocked";
          onPlaybackBlockedRef.current?.(true);
          console.warn("Remote audio playback needs a retry", error);
        }
      } finally {
        starting = false;
        if (!cancelled && !element.paused &&
            (outputModeRef.current === "element" || !output.paused)) {
          element.dataset.audioPlayback = "playing";
          onPlaybackBlockedRef.current?.(false);
        }
      }
    };

    void start();
    const retry = () => { void start(); };
    const resumeVisible = () => {
      if (document.visibilityState === "visible") {
        retry();
      }
    };
    const resumeContext = () => {
      if (context && context.state !== "running") {
        retry();
      }
    };
    document.addEventListener("pointerdown", retry);
    document.addEventListener("ninjitsi:retry-audio", retry);
    document.addEventListener("keydown", retry);
    document.addEventListener("visibilitychange", resumeVisible);
    nativeTrack?.addEventListener("unmute", retry);
    context?.addEventListener("statechange", resumeContext);

    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", retry);
      document.removeEventListener("ninjitsi:retry-audio", retry);
      document.removeEventListener("keydown", retry);
      document.removeEventListener("visibilitychange", resumeVisible);
      nativeTrack?.removeEventListener("unmute", retry);
      context?.removeEventListener("statechange", resumeContext);
      gainRef.current = null;
      source?.disconnect();
      gain?.disconnect();
      destination?.stream.getTracks().forEach((track) => track.stop());
      output.pause();
      output.srcObject = null;
      element.pause();
      if (attached) {
        track.detach(element);
      }
      onPlaybackBlockedRef.current?.(false);
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
        playsInline
        data-audio-source="remote"
        data-output-volume={volume}
        data-participant-audio={participantId}
        ref={audioRef}
      />
      <audio
        autoPlay
        playsInline
        data-audio-sink="remote"
        data-participant-audio={participantId}
        ref={outputRef}
      />
    </>
  );
}
