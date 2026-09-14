import type { JitsiTrackEffect, JitsiTrackLike } from "./types";
import { getStoredLocale, localize } from "@/lib/i18n";

type AudioContextConstructor = typeof AudioContext;
const PREPARATION_TIMEOUT_MS = 60_000;

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
  private preparation?: Promise<void>;
  private source?: MediaStreamAudioSourceNode;
  private stopped = false;

  constructor(private readonly workletUrl: string) {
    const AudioContextClass = getAudioContextConstructor();

    if (!AudioContextClass) {
      throw new Error(
        localize(
          getStoredLocale(),
          "AudioWorklet is not supported by this browser.",
          "AudioWorklet не поддерживается браузером",
        ),
      );
    }

    this.context = new AudioContextClass();
  }

  prepare() {
    if (!this.preparation) {
      this.preparation = this.prepareWorklet();
    }

    return this.preparation;
  }

  isEnabled(track: JitsiTrackLike) {
    return track.getType() === "audio";
  }

  startEffect(stream: MediaStream) {
    if (!this.node || this.context.state !== "running") {
      throw new Error("The noise suppressor is not ready.");
    }

    const originalTrack = stream.getAudioTracks()[0];

    if (!originalTrack) {
      throw new Error(
        localize(
          getStoredLocale(),
          "The audio stream has no track.",
          "У аудиопотока нет дорожки",
        ),
      );
    }

    this.originalTrack = originalTrack;
    this.source = this.context.createMediaStreamSource(stream);
    this.destination = this.context.createMediaStreamDestination();
    this.outputTrack = this.destination.stream.getAudioTracks()[0];
    this.source.connect(this.node);
    this.node.connect(this.destination);
    this.outputTrack.enabled = originalTrack.enabled;
    originalTrack.enabled = true;

    return this.destination.stream;
  }

  private async prepareWorklet() {
    let timeoutId: number | undefined;

    try {
      await Promise.race([
        Promise.all([
          this.context.resume(),
          this.context.audioWorklet.addModule(this.workletUrl),
        ]),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(
            () => reject(new Error("Noise suppression preparation timed out.")),
            PREPARATION_TIMEOUT_MS,
          );
        }),
      ]);

      if (this.stopped) {
        throw new Error("The noise suppressor was stopped before it was ready.");
      }

      this.node = new AudioWorkletNode(
        this.context,
        "NoiseSuppressorWorklet",
        {
          channelCount: 1,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        },
      );
    } catch (caughtError) {
      console.error("Ninjitsi: noise suppression failed", caughtError);
      await this.context.close().catch(() => undefined);
      throw caughtError;
    } finally {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  stopEffect() {
    if (this.stopped) {
      return;
    }

    this.stopped = true;

    if (this.originalTrack && this.outputTrack) {
      this.originalTrack.enabled = this.outputTrack.enabled;
    }

    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.destination?.disconnect();
    void this.context.close().catch(() => undefined);
  }
}
