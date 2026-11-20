"use client";

import { useEffect, useRef, useState } from 'react';
import { Minus, X } from 'lucide-react';
import type { RoomWidget } from '@/hooks/useRoomWidgets';
import { useI18n } from '@/lib/i18n';
import styles from './RoomWidgets.module.css';

interface Props{widget:RoomWidget;room:string;call:(id:string,action:string,body:object)=>Promise<unknown>;avatarDataUrl?:string}
function widgetViewport(){const chat=document.querySelector<HTMLElement>('[data-room-chat]');return {left:0,top:0,width:chat?.dataset.open==='true'&&matchMedia('(min-width:1040px)').matches?Math.max(1,chat.getBoundingClientRect().left):innerWidth,height:innerHeight};}
function WidgetWindow({widget,room,call,avatarDataUrl}:Props){
  const {tr}=useI18n();
  const [channel]=useState(()=>crypto.randomUUID());
  const [position,setPosition]=useState<{x:number;y:number}|null>(null);
  const [hiddenActivation,setHiddenActivation]=useState<string|null>(null);
  const [minimized,setMinimized]=useState(false);
  const [layout,setLayout]=useState({width:320,height:112,frameless:false});
  const panel=useRef<HTMLElement>(null);
  const externalDrag=useRef<{x:number;y:number;left:number;top:number}|null>(null);
  const controls=useRef<HTMLIFrameElement>(null),stage=useRef<HTMLIFrameElement>(null);
  const dragging=useRef<{x:number;y:number}|null>(null);
  const avatar=useRef('');
  useEffect(()=>{let cancelled=false;avatar.current='';if(avatarDataUrl&&/^data:image\/(png|jpeg|webp);base64,/.test(avatarDataUrl)){const image=new Image();image.onload=()=>{const c=document.createElement('canvas');c.width=c.height=64;c.getContext('2d')?.drawImage(image,0,0,64,64);const url=c.toDataURL('image/webp',.7);if(!cancelled&&url.length<=12000)avatar.current=url;};image.src=avatarDataUrl;}return()=>{cancelled=true;};},[avatarDataUrl]);
  const hidden=hiddenActivation===widget.activation;
  const origin=new URL(widget.url).origin;
  const makeUrl=(view:string)=>{
    const url=new URL(widget.url);url.searchParams.set('view',view);url.searchParams.set('room',room);
    url.searchParams.set('channel',channel);url.searchParams.set('parentOrigin',window.location.origin);return url.href;
  };
  const current=useRef(widget);
  useEffect(()=>{current.current=widget;},[widget]);
  useEffect(()=>{
    const send=()=>{
      const value=current.current;
      for(const frame of [controls.current,stage.current])frame?.contentWindow?.postMessage({type:'ninjitsi.widget.state.v1',channel,state:value.state,serverNow:value.serverNow,roundTripMs:value.roundTripMs,viewport:widgetViewport()},origin);
    };
    send();
  },[channel,origin,widget]);
  useEffect(()=>{const send=()=>{for(const frame of [controls.current,stage.current])frame?.contentWindow?.postMessage({type:'ninjitsi.widget.viewport.v1',channel,viewport:widgetViewport()},origin);};const chat=document.querySelector('[data-room-chat]'),resize=new ResizeObserver(send),mutation=new MutationObserver(send);if(chat){resize.observe(chat);mutation.observe(chat,{attributes:true,attributeFilter:['data-open']});}window.addEventListener('resize',send);send();return()=>{resize.disconnect();mutation.disconnect();window.removeEventListener('resize',send);};},[channel,origin]);
  useEffect(()=>{
    const listener=async(event:MessageEvent)=>{
      if(event.origin!==origin||event.data?.channel!==channel)return;
      const control=controls.current?.contentWindow,overlay=stage.current?.contentWindow;
      if(event.source!==control&&event.source!==overlay)return;
      if(event.data.type==='ninjitsi.widget.ready.v1'){
        const value=current.current;
        (event.source as Window).postMessage({type:'ninjitsi.widget.state.v1',channel,state:value.state,serverNow:value.serverNow,roundTripMs:value.roundTripMs,viewport:widgetViewport()},origin);return;
      }
      if(event.source!==control)return;
      if(event.data.type==='ninjitsi.widget.layout.v1'){
        const {width,height,frameless}=event.data;
        if(Number.isFinite(width)&&Number.isFinite(height)&&width>=100&&height>=32){
          setLayout({width:Math.min(640,innerWidth-24,width),height:Math.min(480,height),frameless:frameless===true});
        }
        return;
      }
      if(event.data.type==='ninjitsi.widget.close.v1'){setHiddenActivation(current.current.activation??'');return;}
      if(event.data.type==='ninjitsi.widget.drag.v1'){
        const {phase,x,y}=event.data;
        if(phase==='end'){externalDrag.current=null;return;}
        if(!Number.isFinite(x)||!Number.isFinite(y)||!panel.current)return;
        const rect=panel.current.getBoundingClientRect();
        if(phase==='start')externalDrag.current={x,y,left:rect.left,top:rect.top};
        else if(phase==='move'&&externalDrag.current){
          const start=externalDrag.current;
          setPosition({x:Math.max(0,Math.min(innerWidth-rect.width,start.left+x-start.x)),y:Math.max(0,Math.min(innerHeight-rect.height,start.top+y-start.y))});
        }
        return;
      }
      if(event.data.type!=='ninjitsi.widget.request.v1')return;
      const {id,action,payload}=event.data;
      if(typeof id!=='string'||id.length>100||typeof action!=='string'||!/^[-\w]{1,40}$/.test(action)||!payload||typeof payload!=='object')return;
      try{
        const result=await call(widget.id,'actions',{action,payload,requestId:payload.requestId??id,presentation:{avatarUrl:avatar.current}});
        control?.postMessage({type:'ninjitsi.widget.response.v1',channel,id,result},origin);
      }catch(failure){control?.postMessage({type:'ninjitsi.widget.response.v1',channel,id,error:failure instanceof Error?failure.message:'Widget unavailable'},origin);}
    };
    window.addEventListener('message',listener);return()=>window.removeEventListener('message',listener);
  },[call,channel,origin,widget.id]);
  const style={width:layout.width,...(position?{left:position.x,top:position.y,right:'auto',bottom:'auto'}:{})};
  if(hidden)return null;
  return <>
    <iframe className={styles.overlay} style={{colorScheme:'normal'}} ref={stage} src={makeUrl('stage')} title={`${widget.title}: общая анимация`} sandbox="allow-scripts allow-same-origin" tabIndex={-1} aria-hidden="true" />
    <section ref={panel} className={`${styles.panel} ${layout.frameless?styles.frameless:''}`} style={style} aria-label={widget.title} data-room-widget={widget.id}>
      {!layout.frameless&&<header onPointerDown={event=>{
        if(event.target instanceof Element&&event.target.closest('button'))return;
        if(event.button!==0)return;
        const rect=event.currentTarget.parentElement!.getBoundingClientRect();dragging.current={x:event.clientX-rect.left,y:event.clientY-rect.top};event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event=>{
        if(!dragging.current)return;
        setPosition({x:Math.max(0,Math.min(innerWidth-Math.min(320,innerWidth-24),event.clientX-dragging.current.x)),y:Math.max(0,Math.min(innerHeight-48,event.clientY-dragging.current.y))});
      }} onPointerUp={()=>{dragging.current=null;}} onPointerCancel={()=>{dragging.current=null;}}>
        <strong>{widget.title}</strong><div>
          <button type="button" aria-label={`${tr('Minimize','Свернуть')} ${widget.title}`} onClick={()=>setMinimized(value=>!value)}><Minus size={14}/></button>
          <button type="button" aria-label={`${tr('Close','Закрыть')} ${widget.title}`} onClick={()=>setHiddenActivation(widget.activation??'')}><X size={14}/></button>
        </div>
      </header>}
      <iframe hidden={minimized} ref={controls} style={{height:layout.height,colorScheme:'normal'}} src={makeUrl('controls')} title={`${widget.title}: управление`} sandbox="allow-scripts allow-same-origin"/>
      {widget.unavailable&&<small role="status">{tr('Widget unavailable','Нет связи с виджетом')}</small>}
    </section>
  </>;
}
export function RoomWidgets({widgets,room,call,avatarDataUrl}:{widgets:RoomWidget[];room:string;call:Props['call'];avatarDataUrl?:string}){
  return <>{widgets.filter(widget=>widget.active).map(widget=><WidgetWindow key={widget.id} widget={widget} room={room} call={call} avatarDataUrl={avatarDataUrl}/>)}</>;
}
