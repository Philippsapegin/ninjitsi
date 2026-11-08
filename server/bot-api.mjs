import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SlidingWindowRateLimiter } from "./security.mjs";

const digest = value => createHash("sha256").update(value).digest();
const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;

// This is a bounded, ephemeral public-chat bridge, not a Jitsi/media identity.
export function createBotApi({ configuration = "[]", signingSecret, getRoom, readJsonBody, json, now = Date.now }) {
  const configured = JSON.parse(configuration);
  if (!Array.isArray(configured) || configured.length > 50) throw new Error("NINJITSI_BOTS must be an array of at most 50 bots");
  const ids = new Set();
  const tokens = new Set();
  const bots = configured.map(bot => {
    if (!bot || typeof bot.id !== "string" || !idPattern.test(bot.id) || ids.has(bot.id) || typeof bot.name !== "string" ||
        !bot.name.trim() || bot.name.length > 80 || typeof bot.token !== "string" || bot.token.length < 32 ||
        tokens.has(bot.token) || !Array.isArray(bot.rooms) || !bot.rooms.length || bot.rooms.length > 100 ||
        !bot.rooms.every(room => typeof room === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(room) && room.length <= 80)) {
      throw new Error("Invalid NINJITSI_BOTS entry: unique id/token, name, token >=32 characters and explicit rooms required");
    }
    ids.add(bot.id); tokens.add(bot.token);
    return { id: bot.id, name: bot.name.trim(), hash: digest(bot.token), rooms: bot.rooms };
  });
  const secret = signingSecret || randomBytes(32);
  const epoch = randomBytes(12).toString("hex");
  const streams = new Map();
  const limiter = new SlidingWindowRateLimiter({ limit: 120, windowMs: 60_000 });
  const writes = new SlidingWindowRateLimiter({ limit: 30, windowMs: 60_000 });
  const globalWrites = new SlidingWindowRateLimiter({ limit: 600, windowMs: 60_000 });
  let nextSequence = 0;
  const retentionMs = 30 * 60_000;

  function enabled(room) { return bots.some(bot => bot.rooms.includes(room)); }
  function issueAdmission(room, name) {
    if (!enabled(room.code)) return null;
    const payload = Buffer.from(JSON.stringify({ room: room.code, name: name.slice(0, 80),
      id: randomBytes(16).toString("hex"), exp: Math.min(Date.parse(room.expiresAt), now() + 12 * 60 * 60_000) })).toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  }
  function authenticate(token, room) {
    const hash = digest(token);
    const bot = bots.find(candidate => equal(hash, candidate.hash));
    if (bot) return bot.rooms.includes(room) ? { ...bot, bot: true } : null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const expected = createHmac("sha256", secret).update(payload).digest();
    if (!equal(Buffer.from(signature, "base64url"), expected)) return null;
    try {
      const value = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (value.room === room && value.exp > now() && typeof value.id === "string") return value;
    } catch { /* Invalid token. */ }
    return null;
  }
  function prune() {
    let total = 0;
    for (const [room, stream] of streams) {
      const record = getRoom(room);
      for (const event of stream.events) {
        if (event.timestamp <= now() - retentionMs) stream.floor = Math.max(stream.floor, event.sequence);
      }
      stream.events = stream.events.filter(event => event.timestamp > now() - retentionMs);
      if (!record || Date.parse(record.expiresAt) <= now()) streams.delete(room);
      else total += stream.events.length;
    }
    // Global bound as well as the per-room bound; remove oldest events first.
    while (total > 10_000) {
      let oldest;
      for (const stream of streams.values()) {
        if (!stream.events.length) continue;
        if (!oldest || stream.events[0].sequence < oldest.events[0].sequence) oldest = stream;
      }
      oldest.floor = oldest.events.shift().sequence; total--;
    }
  }
  function append(room, actor, body) {
    prune();
    const stream = streams.get(room) ?? { events: [], floor: 0 };
    const duplicate = stream.events.find(event => event.requestId === body.id && event.actorId === actor.id);
    if (duplicate) return duplicate;
    const event = { sequence: ++nextSequence, id: `botchat-${epoch}-${nextSequence}`, type: "message.created",
      requestId: body.id, actorId: actor.id, senderId: `${actor.bot ? "bot" : "user"}:${actor.id}`,
      senderName: actor.name || "Participant", isBot: Boolean(actor.bot), text: body.text.trim(), timestamp: now() };
    stream.events.push(event);
    if (stream.events.length > 500) stream.floor = stream.events.shift().sequence;
    streams.set(room, stream);
    prune();
    return event;
  }

  async function handle(request, response, url) {
    const match = url.pathname.match(/^\/api\/v1\/rooms\/([a-z0-9-]{1,80})\/(events|messages)$/);
    if (!match) return false;
    const [, code, resource] = match;
    const record = getRoom(code);
    const token = request.headers.authorization?.match(/^Bearer (\S{1,2048})$/)?.[1] ?? "";
    const actor = authenticate(token, code);
    if (!actor) { json(response, 401, { error: "Invalid or expired room/bot token" }); return true; }
    if (!record || Date.parse(record.expiresAt) <= now()) { json(response, 404, { error: "Room not found" }); return true; }
    if (!enabled(code)) { json(response, 403, { error: "Bot API disabled for this room" }); return true; }
    if (!limiter.check(actor.id).allowed) {
      response.setHeader("Retry-After", "60"); json(response, 429, { error: "Rate limit exceeded" }); return true;
    }
    if (resource === "events" && request.method === "GET") {
      const cursor = url.searchParams.get("after") ?? "0";
      if (!/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
        json(response, 400, { error: "after must be a non-negative integer" }); return true;
      }
      prune();
      const after = Number(cursor);
      const events = streams.get(code)?.events ?? [];
      const reset = url.searchParams.get("epoch") !== epoch || after > nextSequence;
      const effectiveAfter = reset ? 0 : after;
      const selected = events.filter(event => event.sequence > effectiveAfter);
      json(response, 200, { version: 1, epoch, cursor: nextSequence,
        truncated: reset || effectiveAfter < (streams.get(code)?.floor ?? 0),
        events: actor.bot ? selected : selected.filter(event => event.isBot) });
      return true;
    }
    if (request.method !== "POST" || (resource === "messages") !== Boolean(actor.bot)) {
      json(response, 403, { error: "Bots post messages; participants publish public chat events" }); return true;
    }
    if (!writes.check(actor.id).allowed || !globalWrites.check("global").allowed) {
      response.setHeader("Retry-After", "60"); json(response, 429, { error: "Message rate limit exceeded" }); return true;
    }
    let body;
    try { body = await readJsonBody(request); } catch (error) {
      json(response, error.message === "request-too-large" ? 413 : 400, { error: "Invalid JSON body" }); return true;
    }
    if (!body || typeof body.id !== "string" || !idPattern.test(body.id) ||
        typeof body.text !== "string" || !body.text.trim() || body.text.length > 4000 ||
        Object.keys(body).some(key => !["id", "text"].includes(key))) {
      json(response, 400, { error: "Expected {id, text}: id 1-100 letters/digits/_/-, text 1-4000 characters" }); return true;
    }
    json(response, 201, { event: append(code, actor, body) });
    return true;
  }
  return { handle, issueAdmission };
}
