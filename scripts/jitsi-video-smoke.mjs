import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const baseUrl = process.env.NINJITSI_BASE_URL ?? "http://localhost:3001";
const stabilityMs = Math.max(0, Number(process.env.NINJITSI_VIDEO_STABILITY_MS) || 0);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium",
].find(path => path && existsSync(path));
const browser = await chromium.launch({ executablePath, headless: true, args: [
  "--mute-audio",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
] });
const pages = [];

async function join(code, name) {
  const page = await browser.newPage();
  pages.push(page);
  page.on("pageerror", error => process.stderr.write(`${name}: ${error.message}\n`));
  await page.addInitScript(() => {
    localStorage.setItem("ninjitsi.locale", "en");
    window.__videoTestPCs = [];
    const PeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(PeerConnection, { construct(target, args) {
      const pc = new target(...args);
      window.__videoTestPCs.push(pc);
      return pc;
    } });
    let library;
    Object.defineProperty(window, "JitsiMeetJS", {
      configurable: true, get: () => library, set: value => {
        library = value;
        const init = value.JitsiConnection.prototype.initJitsiConference;
        value.JitsiConnection.prototype.initJitsiConference = function(...args) {
          const conference = init.apply(this, args);
          window.__videoTestConference = conference;
          window.__videoTestConstraints = [];
          const setConstraints = conference.setReceiverConstraints.bind(conference);
          conference.setReceiverConstraints = constraints => {
            window.__videoTestConstraints.push(structuredClone(constraints));
            return setConstraints(constraints);
          };
          return conference;
        };
      },
    });
    // Exercise real SDK publication/signalling/RTP, without an OS screen picker.
    // A moving synthetic screen also lets us distinguish it from the fake camera.
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext("2d");
      let frame = 0;
      const paint = () => {
        context.fillStyle = "#d2ff66"; context.fillRect(0, 0, 1280, 720);
        context.fillStyle = "#111111"; context.fillRect(frame++ % 1000, 200, 100, 200);
      };
      paint();
      const timer = setInterval(paint, 100);
      const stream = canvas.captureStream(10);
      window.__videoTestDesktop = stream.getVideoTracks()[0];
      const stop = window.__videoTestDesktop.stop.bind(window.__videoTestDesktop);
      window.__videoTestDesktop.stop = () => { clearInterval(timer); stop(); };
      window.__videoTestDesktop.addEventListener("ended", () => clearInterval(timer), { once: true });
      return stream;
    };
  });
  await page.goto(`${baseUrl}/room/${code}`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join room", exact: true }).click();
  await page.getByRole("button", { name: "Leave call" }).waitFor({ timeout: 90000 });
  await page.getByRole("dialog", { name: "Join room", exact: true }).waitFor({ state: "hidden", timeout: 90000 });
  if (await page.getByRole("button", { name: "Turn camera on", exact: true }).count()) {
    await page.getByRole("button", { name: "Turn camera on", exact: true }).click();
  }
  await page.getByRole("button", { name: "Turn camera off", exact: true }).waitFor();
  process.stdout.write(`${name} joined.\n`);
  return page;
}

async function movingVideo(page, sender, label) {
  const video = page.locator("[data-video-tile]").filter({ hasText: sender }).locator("video");
  await video.waitFor({ timeout: 30000 });
  const element = await video.elementHandle();
  await page.waitForFunction(element => element.videoWidth > 0 && !element.paused, element, { timeout: 30000 });
  const before = await video.evaluate(element => element.getVideoPlaybackQuality().totalVideoFrames);
  await page.waitForFunction(({ element, before }) => element.getVideoPlaybackQuality().totalVideoFrames > before + 2,
    { element, before }, { timeout: 30000 });
  const state = await video.evaluate(element => ({ width: element.videoWidth, height: element.videoHeight,
    frames: element.getVideoPlaybackQuality().totalVideoFrames, muted: element.muted }));
  assert(state.muted, `${label}: video must not bypass the audio sink`);
  process.stdout.write(`${JSON.stringify({ label, ...state })}\n`);
}

async function screenCycle(sender, receiver, nativeStop, cameraEnabled = true) {
  await sender.getByRole("button", { name: "Share screen", exact: true }).click();
  await sender.getByRole("button", { name: "Stop sharing", exact: true }).waitFor({ timeout: 30000 });
  const tile = receiver.locator("[data-video-tile]").filter({ hasText: "Video A" });
  await tile.getByText("screen", { exact: true }).waitFor({ timeout: 30000 });
  await movingVideo(receiver, "Video A", "screen received");
  if (nativeStop) {
    await sender.evaluate(() => {
      window.__videoTestDesktop.stop();
      window.__videoTestDesktop.dispatchEvent(new Event("ended"));
    });
  } else {
    await sender.getByRole("button", { name: "Stop sharing", exact: true }).click();
  }
  await sender.getByRole("button", { name: "Share screen", exact: true }).waitFor({ timeout: 30000 });
  await tile.getByText("screen", { exact: true }).waitFor({ state: "hidden", timeout: 30000 });
  if (cameraEnabled) {
    await movingVideo(receiver, "Video A", `camera restored after ${nativeStop ? "browser" : "app"} stop`);
  } else {
    await tile.locator("video").waitFor({ state: "hidden", timeout: 30000 });
    process.stdout.write("Stopping screen sharing preserves camera-off privacy.\n");
  }
}

try {
  const response = await fetch(`${baseUrl}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"password":""}' });
  const body = await response.json();
  assert(response.ok && body.room?.code, `Could not create room (${response.status})`);
  const a = await join(body.room.code, "Video A");
  const b = await join(body.room.code, "Video B");
  await movingVideo(b, "Video A", "two participants: camera");
  await screenCycle(a, b, false);
  await screenCycle(a, b, true);
  const c = await join(body.room.code, "Video C");
  await movingVideo(c, "Video A", "three participants: camera");
  await screenCycle(a, c, false);
  await screenCycle(a, c, true);
  // Another share must select the NEW source, not an old live desktop receiver.
  await screenCycle(a, c, false);
  const frozen = await c.evaluate(() => {
    const conference = window.__videoTestConference;
    const source = conference.getParticipants().find(p => p.getDisplayName() === "Video A")
      .getTracks().find(track => track.getType() === "video" && track.getVideoType() !== "desktop").getSourceName();
    conference.setReceiverConstraints({ lastN: -1, defaultConstraints: { maxHeight: 720 }, constraints: { [source]: { maxHeight: 0 } } });
    return { source, changes: window.__videoTestConstraints.length };
  });
  await c.waitForFunction(({ source, changes }) => window.__videoTestConstraints.slice(changes).some(
    policy => policy.constraints[source]?.maxHeight === 0), frozen, { timeout: 45000 });
  await c.waitForFunction(({ source, changes }) => window.__videoTestConstraints.slice(changes).some(
    policy => policy.constraints[source]?.maxHeight === 720), frozen, { timeout: 10000 });
  await movingVideo(c, "Video A", "frozen subscription recovered automatically");
  await c.waitForFunction(() => [...document.querySelectorAll('[data-video-tile]')]
    .find(tile => tile.textContent.includes("Video A"))?.querySelector("video")?.videoHeight >= 360,
    undefined, { timeout: 30000 });
  const remoteVideo = c.locator("[data-video-tile]").filter({ hasText: "Video A" }).locator("video");
  await remoteVideo.evaluate(element => element.pause());
  await movingVideo(c, "Video A", "interrupted playback resumed automatically");
  await c.evaluate(source => {
    window.__videoTestConference.setReceiverConstraints({ lastN: -1, defaultConstraints: { maxHeight: 720 },
      constraints: { [source]: { maxHeight: 180 } } });
  }, frozen.source);
  await c.waitForFunction(() => {
    const video = [...document.querySelectorAll('[data-video-tile]')].find(tile => tile.textContent.includes("Video A"))?.querySelector("video");
    return video && video.videoHeight > 0 && video.videoHeight <= 180;
  }, undefined, { timeout: 30000 });
  await c.waitForFunction(() => [...document.querySelectorAll('[data-video-tile]')]
    .find(tile => tile.textContent.includes("Video A"))?.querySelector("video")?.videoHeight >= 360,
    undefined, { timeout: 100000 });
  await movingVideo(c, "Video A", "sustained low-resolution subscription recovered automatically");
  const until = Date.now() + stabilityMs;
  while (Date.now() < until) {
    for (const [receiver, sender] of [[a, "Video B"], [b, "Video A"], [c, "Video A"]]) {
      await movingVideo(receiver, sender, "continuous decoded video");
    }
    await a.waitForTimeout(Math.min(10000, Math.max(0, until - Date.now())));
  }
  await c.getByRole("button", { name: "Leave call" }).click();
  await movingVideo(b, "Video A", "camera survives third participant leaving");
  await screenCycle(a, b, true);
  await a.getByRole("button", { name: "Turn camera off", exact: true }).click();
  await b.locator("[data-video-tile]").filter({ hasText: "Video A" }).locator("video").waitFor({ state: "hidden" });
  await screenCycle(a, b, false, false);
  await a.getByRole("button", { name: "Turn camera on", exact: true }).click();
  await movingVideo(b, "Video A", "camera can be re-enabled after screen sharing with camera off");
  process.stdout.write("Video smoke passed.\n");
} catch (error) {
  for (const page of pages) {
    process.stderr.write(`${JSON.stringify(await page.evaluate(() => ({
      tracks: window.__videoTestConference?.getParticipants().map(participant => ({
        name: participant.getDisplayName(), sharing: participant.getProperty("ninjitsiScreenSharing"),
        tracks: participant.getTracks().filter(track => track.getType() === "video")
          .map(track => ({ id: track.getId(), type: track.getVideoType(), muted: track.isMuted(),
            source: track.getSourceName(), readyState: track.getTrack()?.readyState, nativeMuted: track.getTrack()?.muted })),
      })),
      localTracks: window.__videoTestConference?.getLocalTracks("video").map(track => ({ type: track.getVideoType(),
        source: track.getSourceName(), readyState: track.getTrack()?.readyState, muted: track.isMuted(),
        nativeId: track.getTrack()?.id, nativeMuted: track.getTrack()?.muted, enabled: track.getTrack()?.enabled })),
      senders: window.__videoTestPCs.map(pc => ({ state: pc.connectionState, senders: pc.getSenders()
        .filter(sender => sender.track?.kind === "video").map(sender => ({ track: sender.track.id, state: sender.track.readyState,
          encodings: sender.getParameters().encodings })) })),
      constraints: window.__videoTestConstraints?.slice(-4),
      senderState: Object.fromEntries(Object.entries(window.__videoTestConference?.qualityController?.sendVideoController ?? {})
        .filter(([key]) => key !== "_conference").map(([key, value]) => [key, value instanceof Map ? [...value.entries()] : value])),
      sourceLimits: [...(window.__videoTestConference?.qualityController?.sendVideoController?._sessionSenderConstraints
        ?.get(window.__videoTestConference?.jvbJingleSession)?.entries() ?? [])],
      senderLimits: [...(window.__videoTestConference?.jvbJingleSession?.peerconnection?._senderMaxHeights?.entries() ?? [])],
      transfer: window.__videoTestConference?.jvbJingleSession?.peerconnection?.videoTransferActive,
      videos: [...document.querySelectorAll("video")].map(element => ({ width: element.videoWidth,
        paused: element.paused, state: element.readyState, frames: element.getVideoPlaybackQuality().totalVideoFrames })),
    })).catch(error => ({ error: error.message })))}\n`);
    process.stderr.write(`${JSON.stringify(await page.evaluate(async () => {
      const stats = await Promise.all(window.__videoTestPCs.map(pc => pc.getStats()));
      return stats.flatMap(report => [...report.values()].filter(item => ["inbound-rtp", "outbound-rtp"].includes(item.type) && item.kind === "video")
        .map(item => ({ type: item.type, ssrc: item.ssrc, width: item.frameWidth, height: item.frameHeight,
          framesEncoded: item.framesEncoded, framesDecoded: item.framesDecoded, reason: item.qualityLimitationReason })));
    }).catch(error => ({ error: error.message })))}\n`);
  }
  throw error;
} finally {
  await browser.close();
}
