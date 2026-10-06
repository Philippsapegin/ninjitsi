import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium, firefox } from "playwright-core";

const baseUrl = process.env.NINJITSI_BASE_URL ?? "http://localhost:3001";
const stabilityMs = Math.max(0, Number(process.env.NINJITSI_AUDIO_STABILITY_MS) || 0);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium",
].find((path) => path && existsSync(path));
const chrome = await chromium.launch({ executablePath, headless: true, args: [
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
  ...(process.env.NINJITSI_FAKE_AUDIO_FILE ? [`--use-file-for-fake-audio-capture=${process.env.NINJITSI_FAKE_AUDIO_FILE}`] : []),
] });
let fox;
const pages = [];
const output = [];
try {
  fox = await firefox.launch({ headless: true, firefoxUserPrefs: {
    "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true,
    "media.autoplay.default": 0, "media.autoplay.block-webaudio": false,
  } });
  const response = await fetch(`${baseUrl}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"password":""}' });
  const body = await response.json();
  assert(response.ok && body.room?.code, `Could not create test room (${response.status})`);
  const code = body.room.code;
  const join = async (browser, name) => {
    const page = await browser.newPage(); pages.push(page);
    page.on("pageerror", (error) => process.stderr.write(`${name}: ${error.message}\n`));
    await page.addInitScript(() => {
      localStorage.setItem("ninjitsi.locale", "en");
      window.__audioTestPeerConnections = [];
      window.__audioTestLocalTracks = [];
      const PeerConnection = window.RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(PeerConnection, { construct(target, args) {
        const pc = new target(...args); window.__audioTestPeerConnections.push(pc); return pc;
      } });
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await getUserMedia(constraints); window.__audioTestLocalTracks.push(...stream.getAudioTracks()); return stream;
      };
    });
    await page.goto(`${baseUrl}/room/${code}`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Your name").fill(name);
    await page.getByRole("button", { name: "Join room", exact: true }).click();
    await page.getByRole("button", { name: "Leave call" }).waitFor({ timeout: 90000 });
    await page.getByRole("dialog", { name: "Join room", exact: true }).waitFor({ state: "hidden", timeout: 90000 });
    return page;
  };
  const sample = async (page, label, expectedPeers) => {
    try {
      await page.waitForFunction(count => document.querySelectorAll('[data-audio-output="remote"]').length === count, expectedPeers, { timeout: 60000 });
    } catch (error) {
      const debug = await page.evaluate(() => ({
        audio: [...document.querySelectorAll("audio")].map(element => ({ ...element.dataset, paused: element.paused, muted: element.muted })),
        connections: window.__audioTestPeerConnections.map(pc => ({ state: pc.connectionState, ice: pc.iceConnectionState,
          receivers: pc.getReceivers().map(receiver => ({ kind: receiver.track.kind, state: receiver.track.readyState, muted: receiver.track.muted })) })),
      }));
      process.stderr.write(`${label}: ${JSON.stringify(debug)}\n`); throw error;
    }
    let samples;
    for (let attempt = 0; attempt < 5; attempt++) {
      samples = await page.evaluate(async () => {
        const sources = [...document.querySelectorAll('[data-audio-output="remote"]')];
        const context = new AudioContext(); await context.resume();
        const probes = sources.map(element => {
          const source = context.createMediaStreamSource(element.srcObject);
          const analyser = context.createAnalyser(); analyser.fftSize = 2048;
          const silence = context.createGain(); silence.gain.value = 0;
          source.connect(analyser).connect(silence).connect(context.destination);
          return { element, stream: element.srcObject, source, analyser, silence, values: new Float32Array(2048), energy: 0 };
        });
        for (let i=0;i<100;i++) {
          for (const probe of probes) { probe.analyser.getFloatTimeDomainData(probe.values); for (const value of probe.values) probe.energy+=value*value; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        const results = probes.filter(probe => probe.element.isConnected && probe.element.srcObject === probe.stream).map(probe => ({
          id: probe.element.dataset.participantAudio, rms: Math.sqrt(probe.energy/(100*2048)), paused: probe.element.paused, muted: probe.element.muted,
          playsOwnTrack: window.__audioTestLocalTracks.some(local => probe.stream.getAudioTracks().some(remote => local.id === remote.id)),
        }));
        probes.forEach(probe => {probe.source.disconnect();probe.analyser.disconnect();probe.silence.disconnect();}); await context.close();
        return results;
      });
      if (samples.length === expectedPeers && samples.every(stream => stream.rms > 0.002)) break;
      await page.waitForTimeout(500);
    }
    const stats = await page.evaluate(async () => {
      const reports = await Promise.all(window.__audioTestPeerConnections.filter(pc => pc.connectionState === "connected").map(pc => pc.getStats()));
      return reports.flatMap(report => [...report.values()].filter(stat => stat.type === "inbound-rtp" && stat.kind === "audio")
        .map(stat => ({ packetsReceived: stat.packetsReceived, packetsLost: stat.packetsLost })));
    });
    const result = { label, samples, stats }; output.push(result); process.stdout.write(`${JSON.stringify(result)}\n`);
    assert.equal(samples.length, expectedPeers, `${label}: missing remote audio outputs`);
    assert(samples.every(stream => stream.rms > 0.002), `${label}: received audio is silent`);
    assert(samples.every(stream => !stream.paused && !stream.muted && !stream.playsOwnTrack), `${label}: invalid playback or local feedback`);
  };
  const a = await join(chrome, "Audio Chrome A");
  const b = await join(fox, "Audio Firefox B");
  await sample(a, "two participants: Chrome receives Firefox", 1);
  await sample(b, "two participants: Firefox receives Chrome", 1);
  const c = await join(chrome, "Audio Chrome C");
  await sample(a, "JVB: Chrome A receives B and C", 2);
  await sample(b, "JVB: Firefox B receives A and C", 2);
  await sample(c, "JVB: Chrome C receives A and B", 2);

  // Replace the actual Jitsi microphone through the UI, checking decoded
  // speech after each published replacement rather than track presence.
  await a.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = a.getByRole("dialog", { name: "Device settings" });
  const mic = settings.getByLabel("Select microphone");
  await mic.locator("option").nth(1).waitFor({ state: "attached", timeout: 10000 });
  const deviceId = await mic.locator("option").evaluateAll(options => {
    const ids = options.map(option => option.value).filter(Boolean);
    return ids.find(id => id !== "default" && id !== "communications") ?? ids[0];
  });
  if (deviceId) {
    await mic.selectOption(deviceId); await a.waitForTimeout(1500);
    await sample(b, "JVB: explicit microphone selected", 2);
    await mic.selectOption(""); await a.waitForTimeout(1500);
    await sample(b, "JVB: system default microphone restored", 2);
  }
  const speaker = settings.getByLabel("Select audio output");
  const speakerId = await speaker.locator("option").evaluateAll(options => options.map(option => option.value).find(Boolean));
  if (speakerId && await speaker.isEnabled()) {
    await speaker.selectOption(speakerId);
    await a.waitForFunction(id => [...document.querySelectorAll('[data-audio-output="remote"]')].every(element => element.sinkId === id), speakerId);
    await sample(a, "JVB: explicit output selected", 2);
    await speaker.selectOption("");
    await a.waitForFunction(() => [...document.querySelectorAll('[data-audio-output="remote"]')].every(element => element.sinkId === ""));
    await sample(a, "JVB: system default output restored", 2);
  }
  const suppression = settings.getByRole("switch", { name: "Noise suppression" });
  if (await suppression.isEnabled()) {
    await suppression.click(); await a.waitForTimeout(1500);
    await sample(b, "JVB: Chrome noise suppression enabled", 2);
    assert.equal(await suppression.getAttribute("aria-checked"), "true");
    await suppression.click(); await a.waitForTimeout(1500);
    await sample(b, "JVB: Chrome noise suppression disabled", 2);
    assert.equal(await suppression.getAttribute("aria-checked"), "false");
  }
  await settings.getByRole("button", { name: "Close settings" }).click();
  const stableUntil = Date.now() + stabilityMs;
  while (Date.now() < stableUntil) {
    await sample(a, "continuous audio: Chrome A", 2);
    await sample(b, "continuous audio: Firefox B", 2);
    await sample(c, "continuous audio: Chrome C", 2);
    if (Date.now() < stableUntil) await a.waitForTimeout(Math.min(5000, stableUntil - Date.now()));
  }
  await c.getByRole("button", { name: "Leave call" }).click(); await c.waitForTimeout(2500);
  await sample(a, "after third participant leaves: Chrome receives Firefox", 1);
  await sample(b, "after third participant leaves: Firefox receives Chrome", 1);
  process.stdout.write(`Passed ${output.length} live Jitsi audio checks in room ${code}.\n`);
} finally {
  for (const page of pages) {
    await page.getByRole("button", { name: "Leave call" }).click({ timeout: 3000 }).catch(() => undefined);
  }
  await chrome.close(); await fox?.close();
}
