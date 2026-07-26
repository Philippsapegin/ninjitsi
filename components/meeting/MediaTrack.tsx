"use client";

import { useEffect, useRef } from "react";
import type { JitsiTrackLike } from "@/lib/jitsi/types";

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
}

export function AudioTrack({ track }: AudioTrackProps) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const element = audioRef.current;

    if (!element) {
      return;
    }

    void track.attach(element);

    return () => track.detach(element);
  }, [track]);

  return <audio autoPlay ref={audioRef} />;
}
