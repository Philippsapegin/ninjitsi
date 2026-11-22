"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readPushToTalkPreference } from "@/lib/jitsi/mediaPreferences";

export type PushToTalkInput = "space" | "pointer" | "enter";

export function usePushToTalk(setMuted: (muted: boolean, pushToTalk: boolean) => Promise<void>, active: boolean) {
  const [enabled, setEnabled] = useState(false);
  const [pressed, setPressed] = useState(false);
  const enabledRef = useRef(false);
  const held = useRef(new Set<PushToTalkInput>());
  const setterRef = useRef(setMuted);
  useEffect(() => { setterRef.current = setMuted; }, [setMuted]);

  const change = useCallback((value: boolean) => {
    enabledRef.current = value;
    held.current.clear();
    setEnabled(value);
    setPressed(false);
    try { localStorage.setItem("ninjitsi.pushToTalk", String(value)); } catch { /* Optional. */ }
    // Disabling PTT leaves the mic muted; an explicit click can open it.
    void setterRef.current(true, value);
  }, []);

  useEffect(() => {
    if (readPushToTalkPreference()) queueMicrotask(() => change(true));
  }, [change]);

  const press = useCallback((input: PushToTalkInput) => {
    if (!enabledRef.current || !active || held.current.has(input)) return;
    held.current.add(input);
    if (held.current.size !== 1) return;
    setPressed(true);
    void setterRef.current(false, true);
  }, [active]);
  const release = useCallback((input?: PushToTalkInput) => {
    if (input ? !held.current.delete(input) || held.current.size > 0 : held.current.size === 0) return;
    held.current.clear();
    setPressed(false);
    void setterRef.current(true, true);
  }, []);

  useEffect(() => {
    if (!enabled || !active) return;
    const down = (event: KeyboardEvent) => {
      if ((event.code !== "Space" && event.key !== " ") || event.altKey || event.ctrlKey || event.metaKey ||
          (event.target instanceof Element && event.target.closest(
            'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
          ))) return;
      event.preventDefault();
      if (!event.repeat) press("space");
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space" || event.key === " ") release("space");
    };
    const blur = () => release();
    const hidden = () => { if (document.visibilityState !== "visible") release(); };
    document.addEventListener("keydown", down, true);
    document.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("keydown", down, true);
      document.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hidden);
      release();
    };
  }, [active, enabled, press, release]);

  return { enabled, pressed, change, press, release };
}
