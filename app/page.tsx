"use client";

import { useSyncExternalStore } from "react";
import { LandingPage } from "@/components/landing/LandingPage";
import { MeetingRoom } from "@/components/meeting/MeetingRoom";

function roomNameFromPath(pathname: string) {
  const match = pathname.match(/^\/room\/([^/]+)\/?$/);

  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export default function HomePage() {
  const pathname = useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener("popstate", onStoreChange);
      return () => window.removeEventListener("popstate", onStoreChange);
    },
    () => window.location.pathname,
    () => "",
  );
  const roomName = pathname ? roomNameFromPath(pathname) : undefined;

  if (roomName === undefined) {
    return null;
  }

  return roomName ? <MeetingRoom roomName={roomName} /> : <LandingPage />;
}
