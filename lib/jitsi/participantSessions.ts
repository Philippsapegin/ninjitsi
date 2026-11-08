import type { JitsiParticipantLike } from "./types";

export const SESSION_PROPERTY = "ninjitsiSessionV1";
interface Session { tab: string; generation: number }
let pageSession: Session | undefined;

export function nextParticipantSession(room: string): Session {
  // Preserve identity on reload, but start a separate lineage for a new tab or
  // ordinary navigation (sessionStorage can be copied when duplicating a tab).
  const key = `ninjitsi.session.${room}`;
  let previous: Session | undefined;
  try {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    if (pageSession || navigation?.type === "reload") {
      previous = JSON.parse(sessionStorage.getItem(key) ?? "null") ?? undefined;
    }
  } catch { /* Storage is optional. */ }
  pageSession = {
    tab: pageSession?.tab ?? previous?.tab ?? crypto.randomUUID(),
    generation: Math.max(pageSession?.generation ?? 0, previous?.generation ?? 0) + 1,
  };
  try { sessionStorage.setItem(key, JSON.stringify(pageSession)); } catch { /* Optional. */ }
  return pageSession;
}

function session(participant: JitsiParticipantLike): Session | undefined {
  try {
    const value = JSON.parse(String(participant.getProperty?.(SESSION_PROPERTY)));
    if (typeof value?.tab === "string" && /^[\w-]{20,80}$/.test(value.tab) &&
        Number.isSafeInteger(value.generation) && value.generation > 0) return value;
  } catch { /* Older clients have no session marker. */ }
}

export function currentParticipantSessions(participants: JitsiParticipantLike[], latest = new Map<string, number>()) {
  for (const participant of participants) {
    const value = session(participant);
    if (value) latest.set(value.tab, Math.max(latest.get(value.tab) ?? 0, value.generation));
  }
  return participants.filter(participant => {
    const value = session(participant);
    return !value || value.generation === latest.get(value.tab);
  });
}
