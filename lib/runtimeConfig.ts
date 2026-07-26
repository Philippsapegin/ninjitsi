"use client";

import { useSyncExternalStore } from "react";

const buildTimeJitsiUrl =
  process.env.NEXT_PUBLIC_JITSI_URL?.trim().replace(/\/+$/, "") ?? "";
const subscribeToRuntimeConfig = () => () => undefined;

function getClientJitsiUrl() {
  const runtimeUrl = window.__NINJITSI_CONFIG__?.jitsiUrl;

  return runtimeUrl?.trim().replace(/\/+$/, "") || buildTimeJitsiUrl;
}

export function useJitsiServerUrl() {
  return useSyncExternalStore(
    subscribeToRuntimeConfig,
    getClientJitsiUrl,
    () => buildTimeJitsiUrl,
  );
}
