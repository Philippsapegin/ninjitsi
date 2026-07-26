import type { JitsiTrackEffect, JitsiTrackLike } from "./types";

type AudioContextConstructor = typeof AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return (
    window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: AudioContextConstructor;
      }
    ).webkitAudioContext
  );
}

export function isNoiseSuppressionSupported() {
  const AudioContextClass = getAudioContextConstructor();

  if (!AudioContextClass || typeof AudioWorkletNode === "undefined") {
    return false;
  }

  const context = new AudioContextClass();
  const supported = Boolean(context.audioWorklet);

  void context.close();
  return supported;
}

export class JitsiNoiseSuppressionEffect implements JitsiTrackEffect {
  private context: AudioContext;
  private destination?: MediaStreamAudioDestinationNode;
  private node?: AudioWorkletNode;
  private originalTrack?: MediaStreamTrack;
  private outputTrack?: MediaStreamTrack;
  private source?: MediaStreamAudioSourceNode;
  private stopped = false;

  constructor(private readonly workletUrl: string) {
    const AudioContextClass = getAudioContextConstructor();

    if (!AudioContextClass) {
      throw new Error("AudioWorklet не поддерживается браузером");
    }

    this.context = new AudioContextClass();
  }

  isEnabled(track: JitsiTrackLike) {
    return track.getType() === "audio";
  }

  startEffect(stream: MediaStream) {
    const originalTrack = stream.getAudioTracks()[0];

    if (!originalTrack) {
      throw new Error("У аудиопотока нет дорожки");
    }

    this.originalTrack = originalTrack;
    this.source = this.context.createMediaStreamSource(stream);
    this.destination = this.context.createMediaStreamDestination();
    this.outputTrack = this.destination.stream.getAudioTracks()[0];
    this.outputTrack.enabled = originalTrack.enabled;
    originalTrack.enabled = true;

    void this.connectWorklet();
    return this.destination.stream;
  }

  private async connectWorklet() {
    try {
      await this.context.resume();
      await this.context.audioWorklet.addModule(this.workletUrl);

      if (this.stopped || !this.source || !this.destination) {
        return;
      }

      this.node = new AudioWorkletNode(
        this.context,
        "NoiseSuppressorWorklet",
      );
      this.source.connect(this.node);
      this.node.connect(this.destination);
    } catch (caughtError) {
      console.error("Ninjitsi: noise suppression failed", caughtError);

      if (!this.stopped && this.source && this.destination) {
        this.source.connect(this.destination);
      }
    }
  }

  stopEffect() {
    this.stopped = true;

    if (this.originalTrack && this.outputTrack) {
      this.originalTrack.enabled = this.outputTrack.enabled;
    }

    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.destination?.disconnect();
    void this.context.close();
  }
}
