import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({ bundle: true, platform: "node", format: "esm", write: false,
  stdin: { resolveDir: process.cwd(), contents: `
    export * from './lib/jitsi/mediaDevices.ts';
    export * from './lib/jitsi/noiseSuppression.ts';
    export * from './lib/jitsi/videoPolicy.ts';
    export * from './lib/jitsi/videoHealth.ts';
  ` } });
const media = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function navigatorFor(t, userAgent, mediaDevices = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent, mediaDevices } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  });
}

function track(type = "camera", state = "live") {
  return { getType: () => "video", getVideoType: () => type, isMuted: () => false,
    getTrack: () => ({ readyState: state }), dispose: async () => {} };
}

test("system mic alias is Chromium-only, never iPhone Safari/Chrome/Firefox or desktop Firefox", () => {
  for (const agent of [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/140.0.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/140.0 Mobile/15E148 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
    "Mozilla/5.0 Firefox/143.0",
  ]) assert.equal(media.systemMicrophoneId(agent), "", agent);
  assert.equal(media.systemMicrophoneId("Mozilla/5.0 Chrome/143.0.0.0 Safari/537.36"), "default");
  assert.equal(media.systemMicrophoneId("Mozilla/5.0 HeadlessChrome/143.0.0.0 Safari/537.36"), "default");
  assert.equal(media.systemMicrophoneId("Mozilla/5.0 Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"), "default");
});

test("iPhone microphone capture omits synthetic deviceId even with an old saved default", async t => {
  let constraints;
  let stopped = false;
  const native = { getSettings: () => ({}), stop: () => { stopped = true; } };
  navigatorFor(t, "AppleWebKit/605.1.15 CriOS/140.0 Mobile/15E148 Safari/604.1", {
    getSupportedConstraints: () => ({ noiseSuppression: true }),
    getUserMedia: async value => { constraints = value; return { getAudioTracks: () => [native], getTracks: () => [native] }; },
  });
  const mic = { getType: () => "audio" };
  const result = await media.createLocalTrack({ createLocalTracksFromMediaStreams: () => [mic] }, "audio", "default");
  assert.equal(result, mic);
  assert.equal(constraints.audio.deviceId, undefined);
  assert.equal(stopped, false, "missing optional noiseSuppression setting must not discard a valid Safari mic");
});

test("Safari SDK fallback also omits default; stale microphone selection retries without a device constraint", async t => {
  navigatorFor(t, "AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15");
  const calls = [];
  const mic = { getType: () => "audio" };
  const library = { createLocalTracks: async options => {
    calls.push(options);
    if (options.micDeviceId) throw new DOMException("stale device", "OverconstrainedError");
    return [mic];
  } };
  assert.equal(await media.createLocalTrack(library, "audio"), mic);
  assert.equal(calls[0].micDeviceId, undefined);
  assert.equal(await media.createLocalTrack(library, "audio", "expired-id"), mic);
  assert.deepEqual(calls.slice(1).map(call => call.micDeviceId), ["expired-id", undefined]);
});

test("permission denial does not retry or bypass the user's microphone choice", async t => {
  navigatorFor(t, "Chrome/143.0");
  let calls = 0;
  await assert.rejects(media.createLocalTrack({ createLocalTracks: async () => {
    calls++;
    throw new DOMException("denied", "NotAllowedError");
  } }, "audio", "chosen-device"), { name: "NotAllowedError" });
  assert.equal(calls, 1);
  assert(media.isMediaPermissionError({ name: "gum.permission_denied", gum: { error: { name: "NotAllowedError" } } }));
  assert(media.isDeviceSelectionError({ name: "gum.constraint_failed", gum: { error: { name: "OverconstrainedError" } } }));
});

test("actual rejected noise suppression settings release the capture before fallback", async t => {
  let stopped = false;
  const native = { getSettings: () => ({ noiseSuppression: true }), stop: () => { stopped = true; } };
  navigatorFor(t, "Chrome/143.0", {
    getSupportedConstraints: () => ({ noiseSuppression: true }),
    getUserMedia: async () => ({ getAudioTracks: () => [native], getTracks: () => [native] }),
  });
  await assert.rejects(media.createBrowserMicrophoneTrack({ createLocalTracksFromMediaStreams: () => [] }, "", false));
  assert(stopped);
});

test("stopped or explicitly finished screen never wins over camera, even if remote SDK keeps it live", () => {
  const camera = track();
  const desktop = track("desktop");
  assert.equal(media.pickPreferredVideo([camera, desktop]), desktop);
  assert.equal(media.pickPreferredVideo([camera, desktop], true), desktop);
  assert.equal(media.pickPreferredVideo([camera, desktop], false), camera);
  assert.equal(media.pickPreferredVideo([track("desktop", "ended"), camera]), camera);
  assert.equal(media.pickPreferredVideo([desktop], false), undefined);
  assert.equal(media.pickPreferredVideo([track("desktop", "ended")]), undefined);
  const fresh = { ...track("desktop"), getSourceName: () => "person-v2" };
  assert.equal(media.pickPreferredVideo([desktop, camera, fresh], "person-v2"), fresh);
});

test("video policy requests all sources with adaptive 720p/1080p ceilings and source-only recovery", () => {
  const camera = { ...track(), getSourceName: () => "one-v0" };
  const desktop = { ...track("desktop"), getSourceName: () => "two-v1" };
  const conference = { getParticipants: () => [{ getTracks: () => [camera, desktop] }] };
  assert.deepEqual(media.receiveVideoConstraints(conference), {
    lastN: -1, defaultConstraints: { maxHeight: 720 },
    constraints: { "one-v0": { maxHeight: 720 }, "two-v1": { maxHeight: 1080 } },
  });
  const paused = media.receiveVideoConstraints(conference, "one-v0");
  assert.equal(paused.constraints["one-v0"].maxHeight, 0);
  assert.equal(paused.constraints["two-v1"].maxHeight, 1080);
  assert.equal(media.receiveVideoConstraints(conference).constraints["one-v0"].maxHeight, 720);
});

test("video watchdog survives six hours, recovers a freeze, and bounds retries", () => {
  const observe = media.createVideoHealthMonitor();
  const sample = (now, frames, extra = {}) => observe({ now, frames, height: 720, active: true, screen: false, ...extra });
  // Drive six hours of healthy decoded frames with a monotonic clock.
  for (let now = 0; now < 6 * 3600_000; now += 2000) assert.equal(sample(now, now / 100), undefined);
  const start = 6 * 3600_000;
  assert.equal(sample(start, 216000), undefined);
  assert.equal(sample(start + 12000, 216000), "reattach");
  assert.equal(sample(start + 24000, 0), "resubscribe");
  for (let now = start + 26000; now < start + 84000; now += 2000) assert.equal(sample(now, 0), undefined);
  assert.equal(sample(start + 84000, 0), "resubscribe");
  assert.equal(sample(start + 86000, 5), undefined);
});

test("watchdog ignores static screens, hidden tabs and muted sources, and retries sustained quality drops", () => {
  const observe = media.createVideoHealthMonitor();
  const sample = (now, frames, extra = {}) => observe({ now, frames, height: 720, active: true, screen: false, ...extra });
  sample(0, 1);
  assert.equal(sample(90000, 1, { screen: true }), undefined);
  assert.equal(sample(180000, 1, { active: false }), undefined);
  assert.equal(sample(182000, 2), undefined);
  assert.equal(sample(184000, 3, { height: 180 }), undefined);
  assert.equal(sample(244000, 1000, { height: 180 }), "resubscribe");
  assert.equal(sample(246000, 1001, { height: 180 }), undefined);
  assert.equal(sample(248000, 1002, { height: 720 }), undefined);
  const from360 = media.createVideoHealthMonitor();
  from360({ now: 0, frames: 1, height: 360, active: true, screen: false });
  from360({ now: 2000, frames: 2, height: 180, active: true, screen: false });
  assert.equal(from360({ now: 62000, frames: 100, height: 180, active: true, screen: false }), "resubscribe");
});
