import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium, firefox } from "playwright-core";

const chromePath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].find((candidate) => candidate && existsSync(candidate));
if (!chromePath) throw new Error("Chrome is required for remote audio tests.");

// Exercise the production renderer with a REMOTE decoded RTP track. A local
// oscillator stream alone does not expose Chromium's WebRTC decoder gating.
const bundle = await build({
  bundle: true, format: "iife", platform: "browser", write: false,
  stdin: { loader: "js", resolveDir: process.cwd(), contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AudioTrack, VideoTrack } from './components/meeting/MediaTrack.tsx';
    import { createBrowserMicrophoneTrack } from './lib/jitsi/noiseSuppression.ts';
    const NativeAudioContext = window.AudioContext;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    let pc, sender, source, nativeTrack, track, root, gainVolume = 1;
    let attachCount = 0, detachCount = 0;
    const gather = async () => {
      if (pc.iceGatheringState === 'complete') return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ICE gathering timed out')), 10000);
        const onChange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', onChange); resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', onChange); onChange();
      });
    };
    const makeSource = async (kind, noise = false) => {
      if (kind === 'microphone') {
        const library = { createLocalTracksFromMediaStreams: infos => infos.map(info => ({
          getType: () => info.mediaType, getTrack: () => info.track,
        })) };
        let wrapped;
        try {
          wrapped = await createBrowserMicrophoneTrack(library, '', noise);
        } catch (error) {
          // Firefox's synthetic device deliberately ignores enabled processing.
          // Exercise the same disabled-capture recovery used by the conference.
          if(!noise || !/Firefox/.test(navigator.userAgent)) throw error;
          wrapped = await createBrowserMicrophoneTrack(library, '', false);
        }
        const native = wrapped.getTrack();
        return { track: native, stream: new MediaStream([native]), stop: () => native.stop() };
      }
      const context = new NativeAudioContext();
      const oscillator = context.createOscillator();
      const amplitude = context.createGain();
      const destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 440; amplitude.gain.value = 0.08;
      oscillator.connect(amplitude).connect(destination); oscillator.start(); await context.resume();
      if (kind === 'file') {
        // A looping WAV -> HTMLMediaElement.captureStream source, distinct from
        // a microphone and a Web Audio destination (e.g. shared media).
        const frames = 48000, bytes = new Uint8Array(44 + frames * 2), view = new DataView(bytes.buffer);
        const text = (offset, value) => [...value].forEach((c, i) => bytes[offset+i] = c.charCodeAt(0));
        text(0, 'RIFF'); view.setUint32(4, 36 + frames*2, true); text(8, 'WAVE'); text(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 48000, true); view.setUint32(28, 96000, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data');
        view.setUint32(40, frames*2, true);
        for(let i=0;i<frames;i++) view.setInt16(44+i*2, Math.sin(2*Math.PI*440*i/48000)*2600, true);
        const audio = document.body.appendChild(document.createElement('audio'));
        const url = URL.createObjectURL(new Blob([bytes], {type:'audio/wav'}));
        audio.src=url; audio.loop=true; audio.muted=true; await audio.play();
        const stream = (audio.captureStream ?? audio.mozCaptureStream).call(audio);
        for(let i=0; !stream.getAudioTracks().length && i<50; i++) await sleep(20);
        const fileTrack = stream.getAudioTracks()[0];
        if(!fileTrack) throw new Error('Media file produced no audio track');
        await context.close();
        return {track:fileTrack, stream, stop:() => {audio.pause();fileTrack.stop();audio.remove();URL.revokeObjectURL(url);}};
      }
      return {track:destination.stream.getAudioTracks()[0], stream:destination.stream,
        stop:() => {destination.stream.getTracks().forEach(t=>t.stop());void context.close();}};
    };
    const render = () => root.render(React.createElement(React.Fragment, null,
      React.createElement(AudioTrack, {outputDeviceId:'',participantId:'remote',track,volume:gainVolume}),
      React.createElement(VideoTrack, {isLocal:false,track:{...track,attach:async el => {
        // A video tile may be handed a bundled audio/video stream by Jitsi.
        el.srcObject=new MediaStream([nativeTrack]);
      }, detach:el => {el.srcObject=null;}}})
    ));
    window.__remoteAudio = {
      async offer() {
        pc = new RTCPeerConnection(); source=await makeSource('tone');
        sender=pc.addTrack(source.track, source.stream);
        await pc.setLocalDescription(await pc.createOffer()); await gather(); return pc.localDescription.toJSON();
      },
      async accept(offer, failure) {
        if(failure === 'autoplay') {
          window.__audioTestPlaybackAllowed=false;
          const play=HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play=function(){
            return window.__audioTestPlaybackAllowed ? play.call(this)
              : Promise.reject(new DOMException('Simulated autoplay denial','NotAllowedError'));
          };
        }
        if(failure === 'context') window.AudioContext=function(){throw new Error('Simulated Web Audio failure');};
        if(failure === 'processed-play') {
          const play=HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play=function(){
            return this.dataset.audioSink === 'remote'
              ? Promise.reject(new DOMException('Simulated autoplay denial','NotAllowedError')) : play.call(this);
          };
        }
        pc=new RTCPeerConnection();
        pc.ontrack=e=> {
          nativeTrack=e.track;
          track={getTrack:()=>nativeTrack,getType:()=> 'audio',isLocal:()=>false,
            attach:async el=>{attachCount++;el.srcObject=e.streams[0] ?? new MediaStream([nativeTrack]);},
            detach:el=>{detachCount++;if(el)el.srcObject=null;}};
          root=createRoot(document.body.appendChild(document.createElement('div'))); render();
        };
        await pc.setRemoteDescription(offer); await pc.setLocalDescription(await pc.createAnswer()); await gather();
        return pc.localDescription.toJSON();
      },
      async answer(answer) { await pc.setRemoteDescription(answer); },
      async volume(value) { gainVolume=value; render(); await sleep(150); },
      async mute(value) { source.track.enabled=!value; await sleep(300); },
      async replace(kind, noise = false) {
        // Ending the old capture avoids Chromium sharing its noise-processing
        // settings with a second concurrent capture of the same microphone.
        source.stop(); source=await makeSource(kind,noise); await sender.replaceTrack(source.track); await sleep(400);
        return source.track.getSettings();
      },
      async sample() {
        const output=document.querySelector('[data-audio-output="remote"]');
        if(!(output?.srcObject instanceof MediaStream)) throw new Error('No active remote output');
        const context=new NativeAudioContext(), analyser=context.createAnalyser(), silence=context.createGain();
        silence.gain.value=0; analyser.fftSize=2048;
        const input=context.createMediaStreamSource(output.srcObject); input.connect(analyser).connect(silence).connect(context.destination);
        await context.resume(); const values=new Float32Array(2048); let energy=0;
        for(let i=0;i<40;i++){analyser.getFloatTimeDomainData(values);for(const x of values)energy+=x*x;await sleep(20);}
        input.disconnect();analyser.disconnect();silence.disconnect();await context.close();
        return {rms:Math.sqrt(energy/(40*values.length)),mode:output.dataset.audioGain ?? 'webaudio',
          paused:output.paused,muted:output.muted, sourceMuted:document.querySelector('[data-audio-source]').muted,
          videoMuted:document.querySelector('video').muted,attachCount,detachCount};
      },
      async stats() {return [...(await pc.getStats()).values()].filter(s => s.type==='inbound-rtp' && s.kind==='audio')
        .map(s=>({packetsReceived:s.packetsReceived,packetsLost:s.packetsLost}));},
      async remount() { root.unmount(); await sleep(50);root=createRoot(document.body.appendChild(document.createElement('div')));render();await sleep(300); },
      async close() { root?.unmount();pc?.close();source?.stop();await sleep(50);return {attachCount,detachCount}; },
    };
  ` },
});
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/test.js" ? "text/javascript" : "text/html");
  response.end(request.url === "/test.js" ? bundle.outputFiles[0].text
    : '<!doctype html><html><body><script src="/test.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const testUrl = `http://127.0.0.1:${server.address().port}`;
const chrome = await chromium.launch({ executablePath: chromePath, headless: true, args: [
  "--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
  ...(process.env.NINJITSI_FAKE_AUDIO_FILE ? [`--use-file-for-fake-audio-capture=${process.env.NINJITSI_FAKE_AUDIO_FILE}`] : []),
] });
let fox;
const results = [];
try {
  fox = await firefox.launch({ headless: true, firefoxUserPrefs: {
    "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true,
    "media.autoplay.default": 0, "media.autoplay.block-webaudio": false,
  } });
  const browsers = { Chrome: chrome, Firefox: fox };
  for (const [sendName, receiveName, failure] of [
    ["Chrome", "Chrome"], ["Chrome", "Firefox"], ["Firefox", "Chrome"], ["Firefox", "Firefox"],
    ["Chrome", "Chrome", "context"], ["Chrome", "Chrome", "processed-play"],
    ["Chrome", "Chrome", "autoplay"],
  ]) {
    const send = await browsers[sendName].newPage();
    const receive = await browsers[receiveName].newPage();
    try {
      await Promise.all([send.goto(testUrl), receive.goto(testUrl)]);
      const offer = await send.evaluate(() => window.__remoteAudio.offer());
      const answer = await receive.evaluate(({ offer, failure }) => window.__remoteAudio.accept(offer, failure), { offer, failure });
      await send.evaluate((answer) => window.__remoteAudio.answer(answer), answer);
      if (failure === "autoplay") {
        await receive.waitForFunction(() => document.querySelector('[data-audio-source]')?.dataset.audioPlayback === "blocked");
        await receive.evaluate(() => {
          window.__audioTestPlaybackAllowed = true;
          document.dispatchEvent(new Event("ninjitsi:retry-audio"));
        });
      }
      await receive.waitForFunction(() => document.querySelector('[data-audio-source]')?.dataset.audioPlayback === "playing", null, { timeout: 15000 });
      const sample = () => receive.evaluate(() => window.__remoteAudio.sample());
      const initial = await sample();
      assert(initial.rms > 0.015, `${sendName} -> ${receiveName}: silent remote RTP ${JSON.stringify(initial)}`);
      assert.equal(initial.paused, false); assert.equal(initial.muted, false); assert.equal(initial.videoMuted, true);
      if (!failure || failure === "autoplay") {
        assert.equal(initial.sourceMuted, true, "The raw primer must not play a second copy of the voice");
        await receive.evaluate(() => window.__remoteAudio.volume(2));
        const doubled = await sample(); assert(doubled.rms > initial.rms * 1.8, "200% did not amplify actual remote RTP");
        await receive.evaluate(() => window.__remoteAudio.volume(0));
        assert((await sample()).rms < 0.001, "0% did not silence remote RTP");
        await receive.evaluate(() => window.__remoteAudio.volume(1));
        await send.evaluate(() => window.__remoteAudio.mute(true));
        assert((await sample()).rms < 0.001, "Muted source leaked audio");
        await send.evaluate(() => window.__remoteAudio.mute(false));
        assert((await sample()).rms > 0.015, "Unmuted remote source stayed silent");
        await receive.evaluate(() => window.__remoteAudio.remount());
        assert((await sample()).rms > 0.015, "Reattached track stayed silent");
        await send.evaluate(() => window.__remoteAudio.replace("file"));
        assert((await sample()).rms > 0.01, "Shared media file was silent");
        for (const noise of [false, true, false]) {
          const settings = await send.evaluate((noise) => window.__remoteAudio.replace("microphone", noise), noise);
          assert.equal(settings.noiseSuppression, noise && sendName !== "Firefox");
          const micOutput = await sample();
          // Native noise suppression can reject the fake device's test tone;
          // use a speech WAV fixture in Chrome to test speech preservation.
          if (!noise || (process.env.NINJITSI_FAKE_AUDIO_FILE && sendName === "Chrome")) {
            assert(micOutput.rms > 0.003, `Microphone was silent (${sendName}, suppression=${noise})`);
          }
        }
      } else {
        assert.equal(initial.sourceMuted, false, "Direct fallback must be audible");
        assert.equal(initial.mode, "element");
      }
      const stats = await receive.evaluate(() => window.__remoteAudio.stats());
      assert(stats.some((stat) => stat.packetsReceived > 10), "No real RTP packets received");
      const cleanup = await receive.evaluate(() => window.__remoteAudio.close());
      assert.equal(cleanup.attachCount, cleanup.detachCount, "A remote source was left attached after cleanup");
      const result = { from: sendName, to: receiveName, fallback: failure ?? false, rms: initial.rms, stats, passed: true };
      results.push(result); process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally { await Promise.all([send.close(), receive.close()]); }
  }
} finally {
  await chrome.close(); await fox?.close(); await new Promise((resolve) => server.close(resolve));
}
process.stdout.write(`Passed ${results.length} remote audio paths.\n`);
