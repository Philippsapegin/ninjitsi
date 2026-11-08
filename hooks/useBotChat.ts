"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/jitsi/types";

interface BotEvent {
  id: string; senderId: string; senderName: string; text: string; timestamp: number; isBot: boolean;
}

export function useBotChat(room: string, token: string | null, active: boolean, messages: ChatMessage[]) {
  const [botMessages, setBotMessages] = useState<ChatMessage[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const published = useRef(new Set<string>());
  const pendingMessages = useRef(new Map<string, ChatMessage>());
  const publishing = useRef(new Map<string, AbortSignal>());
  const received = useRef(new Set<string>());
  const outgoing = useRef<AbortController | null>(null);
  const url = `/api/v1/rooms/${encodeURIComponent(room)}`;

  useEffect(() => {
    outgoing.current = new AbortController();
    return () => { outgoing.current?.abort(); };
  }, [active, token, url]);

  useEffect(() => {
    if (!token || !active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    let epoch = "";
    const poll = async () => {
      let delay = 2000;
      try {
        const response = await fetch(`${url}/events?after=${cursor}&epoch=${epoch}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: "no-store",
        });
        if (!response.ok) throw new Error(`Bot API ${response.status}`);
        const data = await response.json() as { cursor: number; epoch: string; events: BotEvent[] };
        if (controller.signal.aborted) return;
        const incoming = data.events.filter(event => event.isBot && !received.current.has(event.id));
        for (const event of incoming) received.current.add(event.id);
        if (incoming.length) setBotMessages(current => [...current, ...incoming.map(event => ({
          ...event, isLocal: false, isBot: true,
        }))].slice(-500));
        // Keep deduplication bounded independently of meeting duration.
        if (received.current.size > 2000) received.current = new Set([...received.current].slice(-1000));
        cursor = data.cursor;
        epoch = data.epoch;
        setUnavailable(false);
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
        delay = 10_000;
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, token, url]);

  useEffect(() => {
    if (!token || !active) return;
    const controller = outgoing.current;
    if (!controller || controller.signal.aborted) return;
    // Only this client's new public text is relayed. Never mirror received
    // Jitsi messages, private messages, attachments or bot replies.
    const pending = messages.filter(message => message.isLocal && !message.isPrivate &&
      !message.attachments?.length && message.text && !published.current.has(message.id));
    for (const message of pendingMessages.current.values()) {
      if (!pending.some(candidate => candidate.id === message.id)) pending.push(message);
    }
    for (const message of pending) {
      if (publishing.current.get(message.id) === controller.signal) continue;
      published.current.add(message.id);
      pendingMessages.current.set(message.id, message);
      publishing.current.set(message.id, controller.signal);
      void (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch(`${url}/events`, {
              method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ id: message.id, text: message.text }),
              signal: controller.signal,
            });
            if (response.ok) { pendingMessages.current.delete(message.id); return; }
            if (response.status < 500) break;
          } catch { if (controller.signal.aborted) return; }
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
        pendingMessages.current.delete(message.id);
        if (!controller.signal.aborted) setUnavailable(true);
      })().finally(() => {
        if (publishing.current.get(message.id) === controller.signal) publishing.current.delete(message.id);
      });
    }
    // Do not abort already queued messages whenever the chat array changes.
    // Requests have short, bounded retries and remain idempotent on the server.
  }, [active, messages, token, url]);

  return { botMessages, unavailable };
}
