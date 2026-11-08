import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { createBotApi } from "../server/bot-api.mjs";

const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"]
  .find(path => path && existsSync(path));
const botToken = "interaction-test-only-bot-token-1234567890";
const room = { code: "test-room", expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
const botApi = createBotApi({ configuration: JSON.stringify([{ id: "dice", name: "Dice", token: botToken, rooms: [room.code] }]),
  getRoom: code => code === room.code ? room : undefined,
  readJsonBody: async request => { let body = ""; for await (const chunk of request) body += chunk; return JSON.parse(body); },
  json: (response, status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); },
});

const bundle = await build({ bundle: true, platform: "browser", format: "iife", write: false,
  define: { "process.env.NEXT_PUBLIC_JITSI_URL": '""' },
  plugins: [{ name: "css-test", setup(build) { build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}" })); } }],
  stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {I18nProvider} from './lib/i18n';
    import {useJitsiConference} from './lib/jitsi/useJitsiConference';
    import {usePushToTalk} from './hooks/usePushToTalk';
    import {useBotChat} from './hooks/useBotChat';
    import {CallControls} from './components/meeting/CallControls';
    import {SettingsPanel} from './components/meeting/SettingsPanel';
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const events=new Proxy({}, {get:(_,key)=>String(key)});
    const context=new AudioContext(), destination=context.createMediaStreamDestination();
    let current;
    function makeTrack(type) {
      const native=type==='audio' ? destination.stream.getAudioTracks()[0].clone() : undefined;
      let muted=false;
      return { getType:()=>type, getTrack:()=>native, isMuted:()=>muted,
        mute:async()=>{await wait(30);muted=true;if(native)native.enabled=false;current?.emit('TRACK_MUTE_CHANGED');},
        unmute:async()=>{await wait(300);muted=false;if(native)native.enabled=true;current?.emit('TRACK_MUTE_CHANGED');},
        dispose:async()=>native?.stop(), attach:async()=>{},detach:()=>{},getVideoType:()=>'camera' };
    }
    class Conference {
      tracks=[];handlers={};
      constructor(){current=this;}
      on=(e,fn)=>{(this.handlers[e]??=[]).push(fn);};
      emit=(e,...args)=>this.handlers[e]?.forEach(fn=>fn(...args));
      getLocalTracks=(type)=>this.tracks.filter(t=>!type || t.getType()===type);
      getParticipants=()=>[];isModerator=()=>false;myUserId=()=>'local';
      setDisplayName=()=>{};setLocalParticipantProperty=()=>{};setReceiverConstraints=()=>{};
      join=()=>queueMicrotask(()=>this.emit('CONFERENCE_JOINED'));
      leave=async()=>{};sendTextMessage=()=>{};
      addTrack=async track=>{this.tracks.push(track);this.emit('TRACK_ADDED',track);};
      removeTrack=async track=>{this.tracks=this.tracks.filter(t=>t!==track);};
      replaceTrack=async(old,track)=>{await this.removeTrack(old);await this.addTrack(track);};
    }
    class Connection {
      handlers={};addEventListener=(e,fn)=>this.handlers[e]=fn;
      connect=()=>queueMicrotask(()=>this.handlers.CONNECTION_ESTABLISHED?.('local'));
      disconnect=()=>{};initJitsiConference=()=>new Conference();
    }
    window.__NINJITSI_CONFIG__={jitsiUrl:location.origin};
    window.config={hosts:{domain:'test',muc:'conference.test'},websocket:'wss://test/xmpp'};
    window.JitsiMeetJS={JitsiConnection:Connection,init:()=>{},createLocalTracks:async opts=>opts.devices.map(makeTrack),
      events:{conference:events,connection:events,track:events,connectionQuality:events,e2eping:events}};
    for(const id of ['ninjitsi-config','ninjitsi-lib-jitsi-meet']){
      const s=document.createElement('script');s.id=id;s.dataset.loaded='true';document.head.append(s);
    }
    function Harness(){
      const c=useJitsiConference('test-room');
      const ptt=usePushToTalk(c.setAudioMuted,c.status==='joined');
      const [messages,setMessages]=useState([]);
      const bots=useBotChat('test-room',window.__EVENTS_TOKEN__,c.status==='joined',messages);
      window.__interaction={c,ptt,send:message=>setMessages(old=>[...old,message]),
        native:()=>current?.getLocalTracks('audio')[0]?.getTrack(),
        endMic:()=>{current.getLocalTracks('audio')[0].getTrack().stop();current.emit('TRACK_MUTE_CHANGED');},
        join:()=>c.join({displayName:'Alice',avatarDataUrl:'',isCreator:false,password:'',profileId:'',startAudioMuted:false,
          startVideoMuted:true,tileColor:'#abcdef',videoBackgroundDataUrl:'',videoBackgroundRevision:''})};
      return <><input aria-label="Chat input"/><SettingsPanel audioInputId={c.audioInputId} audioOutputId=""
        busy={c.isDeviceSwitchBusy} localAudioLevel={0} noiseSuppressionEnabled={false} noiseSuppressionSupported={false}
        onAudioInputChange={c.setAudioInputDevice} onAudioOutputChange={async()=>{}} onNoiseSuppressionChange={async()=>{}}
        pushToTalkEnabled={ptt.enabled} onPushToTalkChange={ptt.change} onVideoInputChange={async()=>{}}
        onVideoBackgroundChange={async()=>{}} roomPassword={null} status={c.status}
        videoBackgroundAvailable={false} videoBackgroundEnabled={false} videoInputId=""/>
        <CallControls isAudioBusy={c.isAudioBusy} isAudioMuted={c.isAudioMuted} localAudioLevel={0}
        isScreenShareBusy={false} isScreenSharing={false} isVideoBusy={false} isVideoMuted={true}
        onHangup={()=>{}} onToggleAudio={c.toggleAudio} onToggleScreenShare={()=>{}} onToggleVideo={()=>{}}
        pushToTalkEnabled={ptt.enabled} pushToTalkPressed={ptt.pressed} onPushToTalkPress={ptt.press} onPushToTalkRelease={ptt.release}/>
        <div data-bot-messages>{bots.botMessages.map(m=><p key={m.id}>{m.senderName}: {m.text}</p>)}</div></>;
    }
    createRoot(document.getElementById('root')).render(<I18nProvider><Harness/></I18nProvider>);
  ` },
});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (await botApi.handle(request, response, url)) return;
  response.setHeader("Content-Type", url.pathname === "/test.js" ? "text/javascript" : "text/html");
  response.end(url.pathname === "/test.js" ? bundle.outputFiles[0].text :
    `<!doctype html><div id="root"></div><script>window.__EVENTS_TOKEN__=${JSON.stringify(botApi.issueAdmission(room, "Alice"))}</script><script src="/test.js"></script>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true, args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(baseUrl);
  await page.waitForFunction(() => Boolean(window.__interaction));
  await page.evaluate(() => window.__interaction.join());
  await page.waitForFunction(() => window.__interaction.c.status === "joined" && !window.__interaction.c.isAudioBusy);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Push-to-talk" }).click();
  await page.waitForFunction(() => window.__interaction.c.isAudioMuted);
  await page.evaluate(() => { document.activeElement?.blur(); });
  await page.keyboard.down("Space");
  await page.waitForFunction(() => !window.__interaction.c.isAudioMuted);
  await page.keyboard.up("Space");
  assert.equal(await page.evaluate(() => window.__interaction.native().enabled), false);
  await page.waitForFunction(() => window.__interaction.c.isAudioMuted);
  // Key-up while slow unmute is pending must keep the native gate closed.
  await page.keyboard.down("Space");
  await page.waitForTimeout(60);
  await page.keyboard.up("Space");
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__interaction.native().enabled), false);
  const holdButton = page.getByRole("button", { name: "Hold to talk" });
  const bounds = await holdButton.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => !window.__interaction.c.isAudioMuted);
  await page.mouse.move(1000, 500);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__interaction.native().enabled), false);
  await page.waitForFunction(() => window.__interaction.c.isAudioMuted);
  await page.getByRole("textbox", { name: "Chat input" }).focus();
  await page.keyboard.press("Space");
  assert.equal(await page.evaluate(() => window.__interaction.ptt.pressed), false);
  await page.getByRole("button", { name: "Hold to talk" }).focus();
  await page.keyboard.down("Enter");
  await page.waitForFunction(() => !window.__interaction.c.isAudioMuted);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  assert.equal(await page.evaluate(() => window.__interaction.native().enabled), false);
  await page.keyboard.up("Enter");
  await page.waitForFunction(() => window.__interaction.c.isAudioMuted);
  await page.evaluate(async () => window.__interaction.c.setAudioInputDevice("test-device"));
  assert.equal(await page.evaluate(() => window.__interaction.native().enabled), false);
  await page.evaluate(() => window.__interaction.ptt.change(false));
  await page.waitForFunction(() => !window.__interaction.c.isAudioBusy);
  await page.evaluate(() => window.__interaction.c.toggleAudio());
  await page.waitForFunction(() => !window.__interaction.c.isAudioMuted);
  await page.evaluate(() => window.__interaction.endMic());
  await page.waitForFunction(() => window.__interaction.c.isAudioMuted);
  await page.evaluate(() => window.__interaction.c.toggleAudio());
  await page.waitForFunction(() => !window.__interaction.c.isAudioMuted);
  assert.equal(await page.evaluate(() => window.__interaction.native().readyState), "live", "manual toggle must recover an ended microphone");
  await page.evaluate(() => window.__interaction.ptt.change(true));
  await page.reload();
  await page.waitForFunction(() => window.__interaction?.ptt.enabled);
  await page.evaluate(() => window.__interaction.join());
  await page.waitForFunction(() => window.__interaction.c.status === "joined" && !window.__interaction.c.isAudioBusy);
  assert.equal(await page.evaluate(() => window.__interaction.native().enabled), false, "saved PTT must start muted");

  await page.evaluate(() => {
    const base={isLocal:true,senderId:'local',senderName:'Alice',timestamp:Date.now()};
    window.__interaction.send({...base,id:'public-1',text:'/roll 2d20+3'});
    window.__interaction.send({...base,id:'private-1',text:'secret',isPrivate:true});
    window.__interaction.send({...base,id:'attachment-1',text:'file',attachments:[{id:'a'}]});
  });
  await page.waitForTimeout(200);
  const events = await (await fetch(`${baseUrl}/api/v1/rooms/test-room/events`, { headers: { Authorization: `Bearer ${botToken}` } })).json();
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].text, "/roll 2d20+3");
  await fetch(`${baseUrl}/api/v1/rooms/test-room/messages`, { method: "POST",
    headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "reply-1", text: "2d20+3 = 19" }) });
  await page.getByText("Dice: 2d20+3 = 19", { exact: true }).waitFor();
  await page.waitForTimeout(2200);
  assert.equal(await page.getByText("Dice: 2d20+3 = 19", { exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log("Passed: PTT keyboard/pointer capture, async race, text input, blur, device replacement, ended-mic recovery, reload persistence; bot commands/replies/private isolation.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
