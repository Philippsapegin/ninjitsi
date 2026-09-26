import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const chromeCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));
const baseUrl = process.env.NINJITSI_BASE_URL ?? "http://localhost:3000";
const speechFile = process.env.NINJITSI_FAKE_AUDIO_FILE;

if (!executablePath) {
  throw new Error("Chrome is required for the audio regression test.");
}
if (speechFile && !existsSync(speechFile)) {
  throw new Error(`Audio fixture not found: ${speechFile}`);
}

const entry = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { AudioTrack } from "./components/meeting/MediaTrack.tsx";
  import { createBrowserMicrophoneTrack, isNoiseSuppressionSupported } from "./lib/jitsi/noiseSuppression.ts";

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const sourceContext = new AudioContext();
  const oscillator = sourceContext.createOscillator();
  const amplitude = sourceContext.createGain();
  const sourceOutput = sourceContext.createMediaStreamDestination();
  oscillator.frequency.value = 440;
  amplitude.gain.value = 0.08;
  oscillator.connect(amplitude);
  amplitude.connect(sourceOutput);
  oscillator.start();
  const track = {
    getTrack: () => sourceOutput.stream.getAudioTracks()[0],
    attach: async (element) => { element.srcObject = sourceOutput.stream; await element.play(); },
    detach: (element) => { if (element) element.srcObject = null; },
  };
  window.__ninjitsiAudioTest = {
    async render(volume) {
      await sourceContext.resume();
      root.render(React.createElement(AudioTrack, {
        outputDeviceId: "",
        participantId: "synthetic-remote",
        track,
        volume,
      }));
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
    async microphone(enabled) {
      if (!isNoiseSuppressionSupported()) return { supported: false };
      const library = {
        createLocalTracksFromMediaStreams: (infos) => infos.map((info) => ({
          getType: () => info.mediaType,
          getTrack: () => info.track,
        })),
      };
      const track = await createBrowserMicrophoneTrack(library, "", enabled);
      const nativeTrack = track.getTrack();
      const stream = new MediaStream([nativeTrack]);
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      const silentOutput = context.createGain();
      const samples = new Float32Array(2048);
      analyser.fftSize = samples.length;
      silentOutput.gain.value = 0;
      source.connect(analyser);
      analyser.connect(silentOutput);
      silentOutput.connect(context.destination);
      try {
        await context.resume();
        let energy = 0;
        for (let index = 0; index < 100; index += 1) {
          analyser.getFloatTimeDomainData(samples);
          for (const sample of samples) energy += sample * sample;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return {
          supported: true,
          setting: nativeTrack.getSettings().noiseSuppression,
          rms: Math.sqrt(energy / (100 * samples.length)),
        };
      } finally {
        nativeTrack.stop();
        await context.close();
      }
    },
  };
`;
const bundle = await build({
  bundle: true,
  format: "iife",
  platform: "browser",
  stdin: {
    contents: entry,
    loader: "js",
    resolveDir: process.cwd(),
    sourcefile: "audio-regression-entry.js",
  },
  write: false,
});

const browser = await chromium.launch({
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    ...(speechFile ? [`--use-file-for-fake-audio-capture=${speechFile}`] : []),
  ],
  executablePath,
  headless: true,
});

try {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  const sampleOutput = async () => page.evaluate(async () => {
    const output = document.querySelector('[data-audio-sink="remote"]');
    if (!(output instanceof HTMLAudioElement) || !(output.srcObject instanceof MediaStream)) {
      throw new Error("The rendered AudioTrack has no output stream.");
    }
    const context = new AudioContext();
    const source = context.createMediaStreamSource(output.srcObject);
    const analyser = context.createAnalyser();
    const silentOutput = context.createGain();
    const samples = new Float32Array(2048);
    analyser.fftSize = samples.length;
    silentOutput.gain.value = 0;
    source.connect(analyser);
    analyser.connect(silentOutput);
    silentOutput.connect(context.destination);
    try {
      await context.resume();
      let energy = 0;
      for (let index = 0; index < 60; index += 1) {
        analyser.getFloatTimeDomainData(samples);
        for (const sample of samples) energy += sample * sample;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return Math.sqrt(energy / (60 * samples.length));
    } finally {
      await context.close();
    }
  });

  await page.evaluate(() => window.__ninjitsiAudioTest.render(1));
  const at100 = await sampleOutput();
  await page.evaluate(() => window.__ninjitsiAudioTest.render(2));
  const at200 = await sampleOutput();
  await page.evaluate(() => window.__ninjitsiAudioTest.render(0));
  const at0 = await sampleOutput();

  if (at100 < 0.01 || at200 < at100 * 1.8 || at0 > 0.001) {
    throw new Error(`Per-participant gain failed: ${JSON.stringify({ at0, at100, at200 })}`);
  }

  const suppression = await page.evaluate(async () => {
    const test = window.__ninjitsiAudioTest;
    const enabled = await test.microphone(true);
    const disabled = await test.microphone(false);
    return { enabled, disabled };
  });
  if (suppression.enabled.supported &&
      (suppression.enabled.setting !== true || suppression.disabled.setting !== false)) {
    throw new Error(`Browser noise suppression did not switch: ${JSON.stringify(suppression)}`);
  }
  if (speechFile && suppression.enabled.rms < 0.003) {
    throw new Error(`Noise suppression silenced the speech fixture: ${JSON.stringify(suppression)}`);
  }

  const concurrentCapture = await page.evaluate(async () => {
    const first = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: false } });
    try {
      const second = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true } });
      try {
        return {
          first: first.getAudioTracks()[0].getSettings().noiseSuppression,
          second: second.getAudioTracks()[0].getSettings().noiseSuppression,
        };
      } finally {
        second.getTracks().forEach((track) => track.stop());
      }
    } finally {
      first.getTracks().forEach((track) => track.stop());
    }
  });

  process.stdout.write(`${JSON.stringify({ gainRms: { at0, at100, at200 }, suppression, concurrentCapture }, null, 2)}\n`);
} finally {
  await browser.close();
}
