import { createHmac, randomBytes } from "node:crypto";

export class CapacityError extends Error {
  constructor(message = "capacity-exhausted") {
    super(message);
    this.name = "CapacityError";
  }
}

export class ConcurrencyGate {
  #active = 0;
  #maxActive;
  #maxQueued;
  #queue = [];

  constructor({ maxActive, maxQueued }) {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
      throw new TypeError("maxActive must be a positive integer");
    }

    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) {
      throw new TypeError("maxQueued must be a non-negative integer");
    }

    this.#maxActive = maxActive;
    this.#maxQueued = maxQueued;
  }

  async run(task) {
    if (this.#active >= this.#maxActive) {
      if (this.#queue.length >= this.#maxQueued) {
        throw new CapacityError();
      }

      await new Promise((resolve) => this.#queue.push(resolve));
    }

    this.#active += 1;

    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#queue.shift()?.();
    }
  }
}

export class SlidingWindowRateLimiter {
  #entries = new Map();
  #limit;
  #maxEntries;
  #windowMs;

  constructor({ limit, maxEntries = 50_000, windowMs }) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("limit must be a positive integer");
    }

    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new TypeError("windowMs must be a positive integer");
    }

    this.#limit = limit;
    this.#maxEntries = maxEntries;
    this.#windowMs = windowMs;
  }

  check(key, now = Date.now()) {
    return this.#evaluate(key, now, true);
  }

  peek(key, now = Date.now()) {
    return this.#evaluate(key, now, false);
  }

  #evaluate(key, now, consume) {
    const cutoff = now - this.#windowMs;
    const previous = this.#entries.get(key) ?? [];
    const timestamps = previous.filter((timestamp) => timestamp > cutoff);

    if (timestamps.length >= this.#limit) {
      this.#entries.delete(key);
      this.#entries.set(key, timestamps);
      const resetAt = timestamps[0] + this.#windowMs;

      return {
        allowed: false,
        limit: this.#limit,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1_000)),
      };
    }

    if (consume) {
      timestamps.push(now);
    }
    this.#entries.delete(key);
    if (timestamps.length > 0) {
      this.#entries.set(key, timestamps);
    }
    this.#trim(cutoff);

    return {
      allowed: true,
      limit: this.#limit,
      remaining: this.#limit - timestamps.length,
      resetAt: (timestamps[0] ?? now) + this.#windowMs,
      retryAfterSeconds: 0,
    };
  }

  #trim(cutoff) {
    if (this.#entries.size <= this.#maxEntries) {
      return;
    }

    for (const [key, timestamps] of this.#entries) {
      if (timestamps.at(-1) <= cutoff) {
        this.#entries.delete(key);
      }

      if (this.#entries.size <= this.#maxEntries) {
        return;
      }
    }

    while (this.#entries.size > this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
  }
}

export function clientIp(request, trustProxy) {
  const forwardedFor = request.headers["x-forwarded-for"];

  if (trustProxy && typeof forwardedFor === "string") {
    const firstAddress = forwardedFor.split(",", 1)[0]?.trim();

    if (firstAddress) {
      return normalizeIp(firstAddress);
    }
  }

  return normalizeIp(request.socket.remoteAddress ?? "unknown");
}

export function createJitsiToken({
  appId,
  audience = appId,
  displayName = "",
  expiresInSeconds,
  room,
  secret,
  subject,
  nowSeconds = Math.floor(Date.now() / 1_000),
}) {
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson({
    aud: audience,
    context: {
      user: {
        name: displayName,
      },
    },
    exp: nowSeconds + expiresInSeconds,
    iat: nowSeconds,
    iss: appId,
    nbf: nowSeconds - 5,
    room,
    sub: subject,
  });
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");

  return `${header}.${payload}.${signature}`;
}

export function makeRoomCode() {
  const wordEntropy = randomBytes(2);
  const words = [
    "amber",
    "bright",
    "calm",
    "clear",
    "quiet",
    "swift",
    "warm",
    "blue",
    "green",
    "silver",
    "studio",
    "signal",
    "circle",
    "harbor",
    "orbit",
    "room",
  ];
  const first = words[wordEntropy[0] % words.length];
  const second = words[wordEntropy[1] % words.length];
  const suffix = randomBytes(12).toString("hex");

  return `${first}-${second}-${suffix}`;
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === "") {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }

  throw new Error(`Invalid boolean value: ${value}`);
}

export function parseInteger(value, fallback, { max, min, name }) {
  const source = value ?? String(fallback);

  if (!/^-?\d+$/.test(source.trim())) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  const parsed = Number(source);

  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  return parsed;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function normalizeIp(value) {
  const closingBracket = value.indexOf("]");
  const unwrapped =
    value.startsWith("[") && closingBracket > 1
      ? value.slice(1, closingBracket)
      : value;

  return unwrapped.startsWith("::ffff:") ? unwrapped.slice(7) : unwrapped;
}
