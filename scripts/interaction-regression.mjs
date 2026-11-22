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
    import {ChatSidebar} from './components/meeting/ChatSidebar';
    import {MeetingToasts} from './components/meeting/MeetingToasts';
    import {SettingsPanel} from './components/meeting/SettingsPanel';
    import {VideoTile} from './components/meeting/VideoTile';
    import {CAMERA_OFF_PROPERTY} from './lib/jitsi/videoPolicy';
    const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=';
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const events=new Proxy({}, {get:(_,key)=>String(key)});
    const context=new AudioContext(), destination=context.createMediaStreamDestination();
    let current, captureError, captureDelay=0;
    const cameraStarts=[], cameraStops=[];
    function makeTrack(type) {
      const native=type==='audio' ? destination.stream.getAudioTracks()[0].clone() :
        Object.assign(new EventTarget(),{readyState:'live',enabled:true,stop(){this.readyState='ended';}});
      let muted=false;
      return { getType:()=>type, getTrack:()=>native, isLocal:()=>true, isMuted:()=>type==='video'?false:muted,
        mute:async()=>{await wait(30);muted=true;native.enabled=false;current?.emit('TRACK_MUTE_CHANGED');},
        unmute:async()=>{
          await wait(300);
          muted=false;native.enabled=true;current?.emit('TRACK_MUTE_CHANGED');
        },
        dispose:async()=>{native.stop();if(type==='video')cameraStops.push(performance.now());},
        attach:async()=>{},detach:()=>{},getVideoType:()=>'camera' };
    }
    class Conference {
      tracks=[];handlers={};properties={};participants=[];
      constructor(){current=this;}
      on=(e,fn)=>{(this.handlers[e]??=[]).push(fn);};
      emit=(e,...args)=>this.handlers[e]?.forEach(fn=>fn(...args));
      getLocalTracks=(type)=>this.tracks.filter(t=>!type || t.getType()===type);
      getParticipants=()=>this.participants;isModerator=()=>false;myUserId=()=>'local';
      setDisplayName=()=>{};setLocalParticipantProperty=(key,value)=>{this.properties[key]=value;};setReceiverConstraints=()=>{};
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
    window.JitsiMeetJS={JitsiConnection:Connection,init:()=>{},createLocalTracks:async opts=>Promise.all(opts.devices.map(async type=>{
        if(type==='video'){
          cameraStarts.push(performance.now());
          if(captureDelay)await wait(captureDelay);
          if(captureError){const error=captureError;captureError=null;throw error;}
          if(current?.getLocalTracks('video').some(track=>track.getTrack().readyState==='ended')){
            throw new Error('Old camera still attached');
          }
        }
        return makeTrack(type);
      })),
      events:{conference:events,connection:events,track:events,connectionQuality:events,e2eping:events}};
    for(const id of ['ninjitsi-config','ninjitsi-lib-jitsi-meet']){
      const s=document.createElement('script');s.id=id;s.dataset.loaded='true';document.head.append(s);
    }
    function Harness(){
      const c=useJitsiConference('test-room');
      const ptt=usePushToTalk(c.setAudioMuted,c.status==='joined');
      const [messages,setMessages]=useState([]);
      const [showToasts,setShowToasts]=useState(false);
      const bots=useBotChat('test-room',window.__EVENTS_TOKEN__,c.status==='joined',messages);
      window.__interaction={c,ptt,send:message=>setMessages(old=>[...old,message]),
        native:()=>current?.getLocalTracks('audio')[0]?.getTrack(),
        endMic:()=>{current.getLocalTracks('audio')[0].getTrack().stop();current.emit('TRACK_MUTE_CHANGED');},
        microphoneMuted:()=>current.properties.ninjitsiMicrophoneMuted,
        cameraOff:()=>current.properties[CAMERA_OFF_PROPERTY],
        cameraStats:()=>({starts:cameraStarts,stops:cameraStops,
          tracks:current.getLocalTracks('video').map(track=>track.getTrack().readyState)}),
        endCamera:()=>{current.getLocalTracks('video')[0].getTrack().stop();current.emit('TRACK_MUTE_CHANGED');},
        delayCameraCapture:ms=>{captureDelay=ms;},
        failCameraCapture:(name)=>{captureError={name:'gum.failed',gum:{error:new DOMException(name,name)}};},
        showToasts:setShowToasts,
        remoteCamera:(off)=>{
          if(!current.participants.length){
            const track=makeTrack('video');
            const properties={ninjitsiVideoBackgroundEnabled:'true',ninjitsiVideoBackgroundRevision:'remote-test'};
            current.participants.push({properties,getProperty:key=>properties[key],getId:()=>'remote',
              getTracks:()=>[track],getDisplayName:()=>'Remote',getRole:()=>'participant',
              isAudioMuted:()=>true,isVideoMuted:()=>false});
            const packet={type:'ninjitsi.video-background.v1',revision:'remote-test'};
            for(const part of [{kind:'start',totalChunks:1},{kind:'chunk',index:0,data:image},{kind:'end'}]){
              current.emit('ENDPOINT_MESSAGE_RECEIVED','remote',{...packet,...part});
            }
          }
          current.participants[0].properties[CAMERA_OFF_PROPERTY]=String(off);
          current.emit('PARTICIPANT_PROPERTY_CHANGED');
        },
        join:()=>c.join({displayName:'Alice',avatarDataUrl:'',isCreator:false,password:'',profileId:'',startAudioMuted:false,
          startVideoMuted:true,tileColor:'#abcdef',videoBackgroundDataUrl:image,videoBackgroundRevision:'local-test'})};
      return <><input aria-label="Chat input"/><SettingsPanel audioInputId={c.audioInputId} audioOutputId=""
        busy={c.isDeviceSwitchBusy} localAudioLevel={0} noiseSuppressionEnabled={false} noiseSuppressionSupported={false}
        onAudioInputChange={c.setAudioInputDevice} onAudioOutputChange={async()=>{}} onNoiseSuppressionChange={async()=>{}}
        pushToTalkEnabled={ptt.enabled} onPushToTalkChange={ptt.change} onVideoInputChange={async()=>{}}
        onVideoBackgroundChange={async()=>{}} roomPassword={null} status={c.status}
        videoBackgroundAvailable={false} videoBackgroundEnabled={false} videoBusy={c.isVideoBusy} videoInputId=""/>
        <CallControls isAudioBusy={c.isAudioBusy} isAudioMuted={c.isAudioMuted} localAudioLevel={0}
        isScreenShareBusy={false} isScreenSharing={false} isVideoBusy={c.isVideoBusy} isVideoStarting={c.isVideoStarting} isVideoMuted={c.isVideoMuted}
        onHangup={()=>{}} onToggleAudio={c.toggleAudio} onToggleScreenShare={()=>{}} onToggleVideo={c.toggleVideo}
        pushToTalkEnabled={ptt.enabled} pushToTalkPressed={ptt.pressed} onPushToTalkPress={ptt.press} onPushToTalkRelease={ptt.release}/>
        <div data-bot-messages>{bots.botMessages.map(m=><p key={m.id}>{m.senderName}: {m.text}</p>)}</div>
        {c.participants.map(p=><div key={p.id} data-testid={'tile-'+p.id}><VideoTile activationLabel="Focus" onActivate={()=>{}} onVolumeChange={()=>{}} participant={p} volume={1}/></div>)}
        <ChatSidebar disabled={false} isSendingAttachment={false} messages={[...messages.filter(m=>!m.attachments)]}
          participants={c.participants} onSend={()=>{}} onSendAttachment={async()=>{}}/>
        <MeetingToasts conferenceError={c.error} widgetError={showToasts?'Widget request failed':undefined}
          botUnavailable={showToasts} reconnecting={showToasts}/></>;
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
  // Focus remains on the settings switch after enabling PTT.
  await page.keyboard.down("Space");
  await page.waitForFunction(() => !window.__interaction.c.isAudioMuted);
  assert.equal(await page.evaluate(() => window.__interaction.native().enabled), true);
  assert.equal(await page.evaluate(() => window.__interaction.microphoneMuted()), "false");
  await page.keyboard.up("Space");
  assert.equal(await page.evaluate(() => window.__interaction.native().enabled), false);
  assert.equal(await page.evaluate(() => window.__interaction.microphoneMuted()), "true");
  await page.waitForFunction(() => window.__interaction.c.isAudioMuted);
  assert.equal(await page.getByRole("switch", { name: "Push-to-talk" }).getAttribute("aria-checked"), "true");
  // A tap must leave no delayed unmute.
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
  await page.keyboard.down("Space");
  await page.keyboard.up("Space");
  assert.equal(await page.evaluate(() => window.__interaction.native().enabled), true,
    "releasing Space must not interrupt a held microphone button");
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

  // The SDK can leave a camera track present and report it unmuted.
  const local=page.getByTestId("tile-local"), remote=page.getByTestId("tile-remote");
  await local.locator("[data-video-background]").waitFor();
  assert.equal(await page.evaluate(()=>window.__interaction.c.videoBackgroundEnabled),true);
  assert.equal(await page.evaluate(()=>window.__interaction.cameraOff()),"true");

  const cameraOn=page.getByRole("button",{name:"Turn camera on",exact:true});
  const cameraOff=page.getByRole("button",{name:"Turn camera off",exact:true});
  const cancelStart=page.getByRole("button",{name:"Cancel camera start",exact:true});
  const cameraStats=()=>page.evaluate(()=>window.__interaction.cameraStats());
  assert.deepEqual((await cameraStats()).starts,[],"joining with the camera off must not open the device");
  await cameraOn.click();
  await local.locator("video").waitFor();
  assert.equal((await cameraStats()).starts.length,1);

  await cameraOff.click();
  await cameraOn.click();
  await cancelStart.waitFor();
  assert.equal((await cameraStats()).starts.length,1,"do not reopen the camera during its cooldown");
  await cancelStart.click();
  await cameraOn.waitFor();
  assert.equal((await cameraStats()).starts.length,1,"cancelling the cooldown must skip capture");

  await cameraOn.click();
  await page.evaluate(()=>window.__interaction.c.setVideoInputDevice("blocked-device"));
  await local.locator("video").waitFor();
  const reopened=await cameraStats();
  assert.equal(reopened.starts.length,2);
  assert(reopened.starts.at(-1)-reopened.stops.at(-1)>=1000,"the camera must be closed for a full second");
  assert.equal(await page.evaluate(()=>window.__interaction.c.videoInputId),"");

  await page.evaluate(()=>window.__interaction.endCamera());
  await cameraOn.click();
  await local.locator("video").waitFor();
  assert.deepEqual((await cameraStats()).tracks,["live"]);

  await cameraOff.click();
  await page.evaluate(()=>window.__interaction.delayCameraCapture(300));
  await cameraOn.click();
  await page.waitForFunction(()=>window.__interaction.cameraStats().starts.length===4);
  await cancelStart.click();
  await cameraOn.waitFor();
  const cancelled=await cameraStats();
  assert.deepEqual(cancelled.tracks,[],"a camera returned after cancel must be disposed before publication");
  assert.equal(cancelled.stops.length,4);
  await page.evaluate(()=>window.__interaction.delayCameraCapture(0));

  await page.evaluate(()=>window.__interaction.failCameraCapture("AbortError"));
  await cameraOn.click();
  await cameraOn.waitFor();
  assert.equal((await cameraStats()).starts.length,5,"a failed opening must not retry automatically");

  await page.evaluate(()=>window.__interaction.failCameraCapture("NotAllowedError"));
  await cameraOn.click();
  const cameraToast=page.getByRole("button",{name:/permission to use the camera.*Dismiss notification/});
  await cameraToast.waitFor();
  const failures=await cameraStats();
  assert.equal(failures.starts.length,6,"permission denial must not trigger another capture");
  assert(failures.starts.at(-1)-failures.starts.at(-2)>=1000,"a new request must wait after a failed opening");
  await cameraToast.click();
  await cameraToast.waitFor({state:"hidden"});
  assert.ok(await page.evaluate(()=>window.__interaction.c.error));
  await page.evaluate(()=>window.__interaction.c.toggleVideo());
  await local.locator("video").waitFor();

  await page.evaluate(()=>window.__interaction.c.toggleVideo());
  await local.locator("[data-video-background]").waitFor();
  assert.equal(await page.evaluate(()=>window.__interaction.cameraOff()),"true");
  await page.evaluate(()=>window.__interaction.remoteCamera(false));
  await remote.locator("video").waitFor();
  await page.evaluate(()=>window.__interaction.remoteCamera(true));
  await remote.locator("[data-video-background]").waitFor();

  const list=page.locator("[data-chat-messages]");
  await list.evaluate(element=>Object.assign(element.style,{height:"100px",overflowY:"auto"}));
  const appendHistory=async (from,to)=>page.evaluate(([from,to])=>{
    for(let i=from;i<to;i++)window.__interaction.send({
      isLocal:false,senderId:"remote",senderName:"Remote",timestamp:Date.now(),id:"history-"+i,text:"Message "+i,
    });
  },[from,to]);
  await appendHistory(0,24);
  await page.waitForFunction(()=>{const list=document.querySelector("[data-chat-messages]");return list.scrollHeight>list.clientHeight&&list.scrollTop>0;});
  await list.evaluate(element=>{element.scrollTop=0;});
  await page.waitForTimeout(60);
  await page.evaluate(()=>window.__interaction.remoteCamera(false));
  await appendHistory(24,25);
  await page.getByText("Message 24",{exact:true}).waitFor();
  assert.equal(await list.evaluate(element=>element.scrollTop),0,"rerenders and new messages must preserve history reading");
  await list.evaluate(element=>{element.scrollTop=element.scrollHeight;});
  await page.waitForTimeout(60);
  await appendHistory(25,26);
  await page.getByText("Message 25",{exact:true}).waitFor();
  assert.equal(await list.evaluate(element=>element.scrollHeight-element.clientHeight-element.scrollTop),0,"the latest message is followed near the bottom");
  await page.clock.install();
  await page.evaluate(()=>window.__interaction.showToasts(true));
  const widgetToast=page.getByRole("button",{name:/Widget request failed.*Dismiss notification/});
  const botToast=page.getByRole("button",{name:/Bot connection unavailable.*Dismiss notification/});
  const reconnectToast=page.getByRole("button",{name:/Connection interrupted.*Dismiss notification/});
  for(const toast of [widgetToast,botToast,reconnectToast])await toast.waitFor();
  await widgetToast.click();
  await widgetToast.waitFor({state:"hidden"});
  await page.clock.fastForward(6100);
  await botToast.waitFor({state:"hidden"});
  await reconnectToast.waitFor({state:"hidden"});
  assert.equal(await widgetToast.count(),0,"the dismissed warning stays hidden while its cause persists");
  await page.evaluate(()=>window.__interaction.showToasts(false));
  await page.waitForTimeout(50);
  await page.evaluate(()=>window.__interaction.showToasts(true));
  await widgetToast.waitFor();
  assert.deepEqual(errors, []);
  console.log("Passed: PTT, bot chat isolation, camera-off backgrounds, camera recovery and permission denial, chat scroll retention, and timed/dismissible toasts.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
