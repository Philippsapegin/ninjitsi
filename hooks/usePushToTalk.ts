"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function usePushToTalk(setMuted: (muted: boolean) => Promise<void>, active: boolean) {
  const [enabled, setEnabled] = useState(false);
  const [pressed, setPressed] = useState(false);
  const enabledRef = useRef(false);
  const pressedRef = useRef(false);
  const setterRef = useRef(setMuted);
  useEffect(() => { setterRef.current = setMuted; }, [setMuted]);

  const change = useCallback((value: boolean) => {
    enabledRef.current = value;
    pressedRef.current = false;
    setEnabled(value);
    setPressed(false);
    try { localStorage.setItem("ninjitsi.pushToTalk", String(value)); } catch { /* Optional. */ }
    // Disabling PTT leaves the mic muted; an explicit click can open it.
    void setterRef.current(true);
  }, []);

  useEffect(() => {
    try {
      if (localStorage.getItem("ninjitsi.pushToTalk") === "true") {
        queueMicrotask(() => change(true));
      }
    } catch { /* Optional. */ }
  }, [change]);

  const press = useCallback(() => {
    if (!enabledRef.current || !active || pressedRef.current) return;
    pressedRef.current = true;
    setPressed(true);
    void setterRef.current(false);
  }, [active]);
  const release = useCallback(() => {
    if (!enabledRef.current) return;
    pressedRef.current = false;
    setPressed(false);
    void setterRef.current(true);
  }, []);

  useEffect(() => {
    if (!enabled || !active) return;
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
          (event.target instanceof Element && event.target.closest(
            'input, textarea, select, button, a, [contenteditable="true"], [role="textbox"]',
          ))) return;
      event.preventDefault();
      press();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") release();
    };
    const hidden = () => { if (document.visibilityState !== "visible") release(); };
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", hidden);
      release();
    };
  }, [active, enabled, press, release]);

  return { enabled, pressed, change, press, release };
}
