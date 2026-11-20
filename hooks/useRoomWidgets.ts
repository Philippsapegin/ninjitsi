"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/lib/jitsi/types';

export interface RoomWidget {
  id:string;title:string;url:string;commands:string[];active?:boolean;unavailable?:boolean;
  commandActions?:Record<string,string>;
  version?:number;activation?:string;state:unknown;serverNow?:number;roundTripMs?:number;
  pollAfterMs?:number;
  messages?:Array<{id:string;text:string;senderName:string;timestamp:number}>;
}
export function useRoomWidgets(room:string,token:string|null,active:boolean,chat:ChatMessage[]){
  const [widgets,setWidgets]=useState<RoomWidget[]>([]);
  const [messages,setMessages]=useState<ChatMessage[]>([]);
  const [error,setError]=useState('');
  const seen=useRef(new Set<string>());
  const messageCache=useRef(new Map<string,ChatMessage>());
  const stateRef=useRef<RoomWidget[]>([]);
  const url=`/api/v1/rooms/${encodeURIComponent(room)}/widgets`;
  useEffect(()=>{
    stateRef.current=[];messageCache.current.clear();seen.current.clear();
    queueMicrotask(()=>{setWidgets([]);setMessages([]);setError('');});
  },[room]);
  const call=useCallback(async(id:string,action:string,body:object)=>{
    const response=await fetch(`${url}/${id}/${action}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error??'Widget unavailable');
    return result;
  },[token,url]);
  useEffect(()=>{
    if(!token||!active)return;
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      const start=performance.now();
      try{
        const versions=Object.fromEntries(stateRef.current.map(widget=>[widget.id,widget.version??0]));
        const response=await fetch(`${url}?versions=${encodeURIComponent(JSON.stringify(versions))}`,{headers:{Authorization:`Bearer ${token}`},signal:abort.signal,cache:'no-store'});
        if(!response.ok)throw new Error('Widget connection unavailable');
        const data=await response.json() as {widgets:RoomWidget[]};
        if(abort.signal.aborted)return;
        stateRef.current=data.widgets.map(widget=>{
          const previous=stateRef.current.find(item=>item.id===widget.id);
          return {...widget,state:widget.state??previous?.state,active:widget.unavailable?previous?.active:widget.active,
            activation:widget.activation??previous?.activation,roundTripMs:performance.now()-start};
        });
        let changedMessages=false;
        for(const widget of stateRef.current)for(const message of widget.messages??[]){
          if(typeof message.id!=='string'||typeof message.text!=='string'||!Number.isFinite(message.timestamp))continue;
          const id=`widget-${widget.id}-${message.id}`;
          if(!messageCache.current.has(id)){messageCache.current.set(id,{id,senderId:`widget:${widget.id}`,senderName:widget.title,
            text:message.text.slice(0,4000),timestamp:message.timestamp,isLocal:false,isBot:true});changedMessages=true;}
        }
        while(messageCache.current.size>500)messageCache.current.delete(messageCache.current.keys().next().value!);
        if(changedMessages)setMessages([...messageCache.current.values()]);
        setWidgets(stateRef.current);setError('');
      }catch{if(!abort.signal.aborted)setError('Не удалось связаться с виджетами комнаты');}
      if(!abort.signal.aborted)timer=setTimeout(()=>void poll(),Math.min(1000,...stateRef.current.map(w=>Math.max(100,w.pollAfterMs??1000))));
    };
    void poll();return()=>{abort.abort();clearTimeout(timer);};
  },[active,token,url]);
  useEffect(()=>{
    if(!token||!active||!widgets.length)return;
    for(const message of chat){
      if(!message.isLocal||message.isPrivate||message.attachments?.length||seen.current.has(message.id))continue;
      const command=message.text.trim().match(/^\/([a-z][a-z0-9_-]*)(?:\s.*)?$/i)?.[1]?.toLowerCase();
      if(!command)continue;
      const widget=widgets.find(widget=>widget.commands.includes(command)||Object.hasOwn(widget.commandActions??{},command));if(!widget)continue;
      seen.current.add(message.id);
      const action=widget.commandActions?.[command];
      void call(widget.id,action?'actions':'activate',{requestId:message.id,...(action?{action,payload:{}}:{})}).catch(failure=>{
        // Retrying the chat command is explicit; repeating renders never
        // trigger an activation storm while a provider is unavailable.
        setError(failure.message);
      });
    }
  },[active,call,chat,token,widgets]);
  return {widgets:active?widgets:[],messages,error,call};
}
