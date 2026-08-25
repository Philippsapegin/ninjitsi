import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  CapacityError,
  ConcurrencyGate,
  SlidingWindowRateLimiter,
  clientIp,
  createJitsiToken,
  makeRoomCode,
  parseBoolean,
  parseInteger,
} from "./security.mjs";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const staticRoot = resolve(process.env.STATIC_ROOT ?? ".open-next/assets");
const dataRoot = resolve(process.env.DATA_DIR ?? ".data");
const roomsPath = join(dataRoot, "rooms.json");
const jitsiUrlArgument = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--jitsi-url="));
const jitsiUrl = (
  jitsiUrlArgument?.slice("--jitsi-url=".length) ??
  process.env.JITSI_URL ??
  "http://localhost:8000"
)
  .trim()
  .replace(/\/+$/, "");
const jitsiUrlObject = jitsiUrl ? new URL(jitsiUrl) : null;

if (
  jitsiUrlObject &&
  !["http:", "https:"].includes(jitsiUrlObject.protocol)
) {
  throw new Error("JITSI_URL must use HTTP or HTTPS");
}

if (jitsiUrlObject?.username || jitsiUrlObject?.password) {
  throw new Error("JITSI_URL must not contain credentials");
}
const maxRooms = parseInteger(process.env.MAX_ROOMS, 10_000, {
  max: 1_000_000,
  min: 1,
  name: "MAX_ROOMS",
});
const roomTtlHours = parseInteger(process.env.ROOM_TTL_HOURS, 720, {
  max: 8_760,
  min: 1,
  name: "ROOM_TTL_HOURS",
});
const roomTtlMs = roomTtlHours * 60 * 60 * 1_000;
const trustProxy = parseBoolean(process.env.TRUST_PROXY, false);
const jitsiJwtSecret = (process.env.JITSI_JWT_SECRET ?? "").trim();
const jitsiAuthMode = (
  process.env.JITSI_AUTH_MODE ?? (jitsiJwtSecret ? "token" : "open")
)
  .trim()
  .toLowerCase();
const jitsiJwtAppId = (process.env.JITSI_JWT_APP_ID ?? "ninjitsi").trim();
const jitsiJwtAudience = (
  process.env.JITSI_JWT_AUDIENCE ?? jitsiJwtAppId
).trim();
const jitsiJwtSubject = (
  process.env.JITSI_JWT_SUBJECT ?? "meet.jitsi"
).trim();
const jitsiJwtTtlSeconds = parseInteger(
  process.env.JITSI_JWT_TTL_SECONDS,
  43_200,
  {
    max: 86_400,
    min: 21_600,
    name: "JITSI_JWT_TTL_SECONDS",
  },
);
const roomCodePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const createRateLimiter = new SlidingWindowRateLimiter({
  limit: parseInteger(process.env.ROOM_CREATE_RATE_LIMIT, 10, {
    max: 1_000,
    min: 1,
    name: "ROOM_CREATE_RATE_LIMIT",
  }),
  windowMs:
    parseInteger(process.env.ROOM_CREATE_RATE_WINDOW_SECONDS, 600, {
      max: 86_400,
      min: 1,
      name: "ROOM_CREATE_RATE_WINDOW_SECONDS",
    }) * 1_000,
});
const globalCreateRateLimiter = new SlidingWindowRateLimiter({
  limit: parseInteger(process.env.ROOM_CREATE_GLOBAL_RATE_LIMIT, 120, {
    max: 100_000,
    min: 1,
    name: "ROOM_CREATE_GLOBAL_RATE_LIMIT",
  }),
  windowMs: 60_000,
});
const joinRateLimiter = new SlidingWindowRateLimiter({
  limit: parseInteger(process.env.ROOM_JOIN_RATE_LIMIT, 30, {
    max: 10_000,
    min: 1,
    name: "ROOM_JOIN_RATE_LIMIT",
  }),
  windowMs: 60_000,
});
const globalJoinRateLimiter = new SlidingWindowRateLimiter({
  limit: parseInteger(process.env.ROOM_JOIN_GLOBAL_RATE_LIMIT, 600, {
    max: 100_000,
    min: 1,
    name: "ROOM_JOIN_GLOBAL_RATE_LIMIT",
  }),
  windowMs: 60_000,
});
const passwordRateLimiter = new SlidingWindowRateLimiter({
  limit: parseInteger(process.env.ROOM_PASSWORD_RATE_LIMIT, 10, {
    max: 1_000,
    min: 1,
    name: "ROOM_PASSWORD_RATE_LIMIT",
  }),
  windowMs: 600_000,
});
const lookupRateLimiter = new SlidingWindowRateLimiter({
  limit: parseInteger(process.env.ROOM_LOOKUP_RATE_LIMIT, 120, {
    max: 100_000,
    min: 1,
    name: "ROOM_LOOKUP_RATE_LIMIT",
  }),
  windowMs: 60_000,
});
const scryptGate = new ConcurrencyGate({
  maxActive: parseInteger(process.env.SCRYPT_MAX_CONCURRENCY, 2, {
    max: 32,
    min: 1,
    name: "SCRYPT_MAX_CONCURRENCY",
  }),
  maxQueued: parseInteger(process.env.SCRYPT_MAX_QUEUE, 8, {
    max: 1_000,
    min: 0,
    name: "SCRYPT_MAX_QUEUE",
  }),
});
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const scrypt = promisify(scryptCallback);

let rooms = new Map();
let writeQueue = Promise.resolve();
let shuttingDown = false;

if (!["open", "token"].includes(jitsiAuthMode)) {
  throw new Error('JITSI_AUTH_MODE must be either "open" or "token"');
}

if (
  jitsiAuthMode === "token" &&
  (jitsiJwtSecret.length < 32 || /replace|change|example/i.test(jitsiJwtSecret))
) {
  throw new Error(
    "JITSI_JWT_SECRET must be a unique secret of at least 32 characters in token mode",
  );
}

if (
  jitsiAuthMode === "token" &&
  (!jitsiJwtAppId || !jitsiJwtAudience || !jitsiJwtSubject)
) {
  throw new Error(
    "JITSI_JWT_APP_ID, JITSI_JWT_AUDIENCE and JITSI_JWT_SUBJECT are required in token mode",
  );
}

function json(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function applySecurityHeaders(response) {
  const jitsiSources = [];

  if (jitsiUrlObject) {
    const websocketProtocol =
      jitsiUrlObject.protocol === "https:" ? "wss:" : "ws:";

    jitsiSources.push(jitsiUrlObject.origin);
    jitsiSources.push(`${websocketProtocol}//${jitsiUrlObject.host}`);
  }

  const connectSources = ["'self'", ...jitsiSources].join(" ");
  const scriptSources = ["'self'", "'unsafe-inline'", ...jitsiSources].join(
    " ",
  );

  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      `connect-src ${connectSources}`,
      "font-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "object-src 'none'",
      `script-src ${scriptSources}`,
      "style-src 'self' 'unsafe-inline'",
      `worker-src 'self' blob: ${jitsiSources.join(" ")}`.trim(),
    ].join("; "),
  );
  response.setHeader("Permissions-Policy", "camera=(self), display-capture=(self), fullscreen=(self), microphone=(self)");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function localizedError(request, english, russian) {
  return {
    error:
      request.headers["x-ninjitsi-locale"] === "ru"
        ? russian
        : english,
  };
}

function publicRoom(room) {
  return {
    code: room.code,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    passwordRequired: room.passwordRequired,
  };
}

function nextRoomCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = makeRoomCode();

    if (!rooms.has(code)) {
      return code;
    }
  }

  return `room-${randomBytes(12).toString("hex")}`;
}

async function passwordDigest(password, salt) {
  const digest = await scryptGate.run(() => scrypt(password, salt, 32));

  return Buffer.from(digest);
}

function roomExpiration(createdAt) {
  return new Date(Date.parse(createdAt) + roomTtlMs).toISOString();
}

function pruneExpiredRooms(now = Date.now()) {
  let changed = false;

  for (const [code, room] of rooms) {
    if (Date.parse(room.expiresAt) <= now) {
      rooms.delete(code);
      changed = true;
    }
  }

  return changed;
}

function issueJitsiToken(room, displayName) {
  if (jitsiAuthMode !== "token") {
    return null;
  }

  return createJitsiToken({
    appId: jitsiJwtAppId,
    audience: jitsiJwtAudience,
    displayName,
    expiresInSeconds: jitsiJwtTtlSeconds,
    room: room.code,
    secret: jitsiJwtSecret,
    subject: jitsiJwtSubject,
  });
}

function rateLimit(request, response, limiter, key, consume = true) {
  const result = consume ? limiter.check(key) : limiter.peek(key);

  response.setHeader("RateLimit-Limit", result.limit);
  response.setHeader("RateLimit-Remaining", result.remaining);
  response.setHeader("RateLimit-Reset", Math.ceil(result.resetAt / 1_000));

  if (result.allowed) {
    return true;
  }

  response.setHeader("Retry-After", result.retryAfterSeconds);
  json(
    response,
    429,
    localizedError(
      request,
      "Too many requests. Please wait and try again.",
      "Слишком много запросов. Подождите и попробуйте снова.",
    ),
  );
  return false;
}

function scryptBusy(request, response) {
  response.setHeader("Retry-After", "2");
  json(
    response,
    503,
    localizedError(
      request,
      "The room server is busy. Please try again in a moment.",
      "Сервер комнат занят. Попробуйте снова через несколько секунд.",
    ),
  );
}

function roomRegistryFull(request, response) {
  if (rooms.size < maxRooms) {
    return false;
  }

  response.setHeader("Retry-After", "3600");
  json(
    response,
    503,
    localizedError(
      request,
      "The room registry is full. An administrator must increase capacity or shorten room lifetime.",
      "Реестр комнат заполнен. Администратору нужно увеличить лимит или сократить срок хранения комнат.",
    ),
  );
  return true;
}

async function passwordMatches(room, password) {
  if (!room.passwordRequired) {
    return true;
  }

  const expected = Buffer.from(room.passwordHash, "hex");
  const actual = await passwordDigest(password, room.passwordSalt);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > 8 * 1024) {
      throw new Error("request-too-large");
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid-json");
  }
}

async function persistRooms() {
  const snapshot = JSON.stringify(
    {
      rooms: Array.from(rooms.values()),
      version: 2,
    },
    null,
    2,
  );
  const temporaryPath = `${roomsPath}.${process.pid}.tmp`;

  writeQueue = writeQueue
    .catch((error) => {
      console.error(`Previous room registry write failed: ${error.message}`);
    })
    .then(async () => {
      await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, roomsPath);
    });

  return writeQueue;
}

async function loadRooms() {
  await mkdir(dataRoot, { recursive: true });

  try {
    const stored = JSON.parse(await readFile(roomsPath, "utf8"));

    if (!Array.isArray(stored.rooms)) {
      return;
    }

    rooms = new Map(
      stored.rooms
        .filter(
          (room) =>
            room &&
            typeof room.code === "string" &&
            roomCodePattern.test(room.code) &&
            typeof room.createdAt === "string" &&
            Number.isFinite(Date.parse(room.createdAt)) &&
            typeof room.passwordRequired === "boolean" &&
            (!room.passwordRequired ||
              (typeof room.passwordHash === "string" &&
                /^[a-f0-9]{64}$/.test(room.passwordHash) &&
                typeof room.passwordSalt === "string" &&
                /^[a-f0-9]{32}$/.test(room.passwordSalt))),
        )
        .map((room) => {
          const expiresAt =
            typeof room.expiresAt === "string" &&
            Number.isFinite(Date.parse(room.expiresAt))
              ? room.expiresAt
              : roomExpiration(room.createdAt);

          return [room.code, { ...room, expiresAt }];
        }),
    );

    if (pruneExpiredRooms()) {
      await persistRooms();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Room registry could not be read: ${error.message}`);
    }
  }
}

async function handleApi(request, response, pathname) {
  if (pathname === "/api/health" && request.method === "GET") {
    json(response, 200, {
      authMode: jitsiAuthMode,
      jitsiConfigured: Boolean(jitsiUrl),
      ok: true,
      roomCount: rooms.size,
    });
    return true;
  }

  if (pathname === "/api/rooms" && request.method === "POST") {
    const address = clientIp(request, trustProxy);

    if (
      !rateLimit(request, response, createRateLimiter, address) ||
      !rateLimit(request, response, globalCreateRateLimiter, "global")
    ) {
      return true;
    }

    let body;

    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(
        response,
        error.message === "request-too-large" ? 413 : 400,
        localizedError(
          request,
          "Invalid room creation request.",
          "Некорректный запрос на создание комнаты.",
        ),
      );
      return true;
    }

    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      (body.password !== undefined && typeof body.password !== "string")
    ) {
      json(
        response,
        400,
        localizedError(
          request,
          "The password field must be a string.",
          "Поле password должно быть строкой.",
        ),
      );
      return true;
    }

    const password = body.password ?? "";

    if (password.length > 200) {
      json(
        response,
        400,
        localizedError(
          request,
          "The password is too long.",
          "Пароль слишком длинный.",
        ),
      );
      return true;
    }

    const prunedRooms = pruneExpiredRooms();

    if (prunedRooms) {
      await persistRooms();
    }

    if (roomRegistryFull(request, response)) {
      return true;
    }

    const passwordSalt = password ? randomBytes(16).toString("hex") : "";
    let passwordHash = "";

    try {
      passwordHash = password
        ? (await passwordDigest(password, passwordSalt)).toString("hex")
        : "";
    } catch (error) {
      if (error instanceof CapacityError) {
        scryptBusy(request, response);
        return true;
      }

      throw error;
    }

    // Password hashing yields to the event loop. Recheck after it finishes so
    // concurrent protected-room requests cannot exceed MAX_ROOMS.
    if (roomRegistryFull(request, response)) {
      return true;
    }

    const code = nextRoomCode();
    const createdAt = new Date().toISOString();
    const room = {
      code,
      createdAt,
      expiresAt: roomExpiration(createdAt),
      passwordHash,
      passwordRequired: Boolean(password),
      passwordSalt,
    };

    rooms.set(code, room);
    await persistRooms();
    json(response, 201, {
      joinPath: `/room/${code}`,
      room: publicRoom(room),
    });
    return true;
  }

  const admissionMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);

  if (admissionMatch && request.method === "POST") {
    const address = clientIp(request, trustProxy);

    if (
      !rateLimit(request, response, joinRateLimiter, address) ||
      !rateLimit(request, response, globalJoinRateLimiter, "global")
    ) {
      return true;
    }

    let code;
    let body;

    try {
      code = decodeURIComponent(admissionMatch[1]).toLowerCase();
      body = await readJsonBody(request);
    } catch (error) {
      json(
        response,
        error.message === "request-too-large" ? 413 : 400,
        localizedError(
          request,
          "Invalid room admission request.",
          "Некорректный запрос на вход.",
        ),
      );
      return true;
    }

    if (
      !roomCodePattern.test(code) ||
      code.length > 80 ||
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.password !== "string" ||
      body.password.length > 200 ||
      (body.displayName !== undefined &&
        (typeof body.displayName !== "string" || body.displayName.length > 80))
    ) {
      json(
        response,
        400,
        localizedError(
          request,
          "Invalid room admission request.",
          "Некорректный запрос на вход.",
        ),
      );
      return true;
    }

    const prunedRooms = pruneExpiredRooms();

    if (prunedRooms) {
      await persistRooms();
    }

    const room = rooms.get(code);

    if (!room) {
      json(
        response,
        404,
        localizedError(
          request,
          "Room not found. Ask its creator for a new link.",
          "Комната не найдена. Попросите создателя прислать новую ссылку.",
        ),
      );
      return true;
    }

    if (
      room.passwordRequired &&
      !rateLimit(
        request,
        response,
        passwordRateLimiter,
        `${address}:${code}`,
        false,
      )
    ) {
      return true;
    }

    let passwordAccepted;

    try {
      passwordAccepted = await passwordMatches(room, body.password);
    } catch (error) {
      if (error instanceof CapacityError) {
        scryptBusy(request, response);
        return true;
      }

      throw error;
    }

    if (!passwordAccepted) {
      passwordRateLimiter.check(`${address}:${code}`);
      json(
        response,
        403,
        localizedError(
          request,
          "The room password is incorrect.",
          "Пароль комнаты не подошёл.",
        ),
      );
      return true;
    }

    json(response, 200, {
      admitted: true,
      jitsiToken: issueJitsiToken(room, body.displayName?.trim() ?? ""),
      room: publicRoom(room),
    });
    return true;
  }

  const roomMatch = pathname.match(/^\/api\/rooms\/([^/]+)$/);

  if (roomMatch && request.method === "GET") {
    const address = clientIp(request, trustProxy);

    if (!rateLimit(request, response, lookupRateLimiter, address)) {
      return true;
    }

    let code;

    try {
      code = decodeURIComponent(roomMatch[1]).toLowerCase();
    } catch {
      json(
        response,
        400,
        localizedError(
          request,
          "Invalid room code.",
          "Некорректный код комнаты.",
        ),
      );
      return true;
    }

    if (!roomCodePattern.test(code) || code.length > 80) {
      json(
        response,
        400,
        localizedError(
          request,
          "Invalid room code.",
          "Некорректный код комнаты.",
        ),
      );
      return true;
    }

    const prunedRooms = pruneExpiredRooms();

    if (prunedRooms) {
      await persistRooms();
    }

    const room = rooms.get(code);

    if (!room) {
      json(
        response,
        404,
        localizedError(
          request,
          "Room not found. Ask its creator for a new link.",
          "Комната не найдена. Попросите создателя прислать новую ссылку.",
        ),
      );
      return true;
    }

    json(response, 200, { room: publicRoom(room) });
    return true;
  }

  if (pathname.startsWith("/api/")) {
    json(
      response,
      404,
      localizedError(
        request,
        "API route not found.",
        "API-маршрут не найден.",
      ),
    );
    return true;
  }

  return false;
}

async function sendFile(request, response, filePath) {
  const fileInfo = await stat(filePath);

  if (!fileInfo.isFile()) {
    return false;
  }

  const extension = extname(filePath).toLowerCase();
  const immutable = filePath.includes(`${sep}_next${sep}static${sep}`);

  response.writeHead(200, {
    "Cache-Control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "Content-Length": fileInfo.size,
    "Content-Type": contentTypes[extension] ?? "application/octet-stream",
  });

  if (request.method === "HEAD") {
    response.end();
    return true;
  }

  createReadStream(filePath).pipe(response);
  return true;
}

async function handleStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    json(
      response,
      405,
      localizedError(
        request,
        "Method not allowed.",
        "Метод не поддерживается.",
      ),
    );
    return;
  }

  if (pathname === "/runtime-config.js") {
    const source = `window.__NINJITSI_CONFIG__ = { ${JSON.stringify({
      jitsiUrl,
      roomApiEnabled: true,
    }).slice(1, -1)}, ...window.__NINJITSI_CONFIG__, roomApiEnabled: true };\n`;

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(source),
      "Content-Type": "text/javascript; charset=utf-8",
    });
    response.end(request.method === "HEAD" ? undefined : source);
    return;
  }

  let decodedPath;

  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    json(
      response,
      400,
      localizedError(request, "Invalid URL.", "Некорректный URL."),
    );
    return;
  }

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  const requestedPath = resolve(staticRoot, relativePath);
  const isInsideStaticRoot =
    requestedPath === staticRoot || requestedPath.startsWith(`${staticRoot}${sep}`);

  if (!isInsideStaticRoot) {
    json(
      response,
      403,
      localizedError(request, "Access denied.", "Доступ запрещён."),
    );
    return;
  }

  try {
    if (await sendFile(request, response, requestedPath)) {
      return;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const acceptsHtml = (request.headers.accept ?? "").includes("text/html");

  if (acceptsHtml) {
    await sendFile(request, response, join(staticRoot, "index.html"));
    return;
  }

  json(
    response,
    404,
    localizedError(request, "File not found.", "Файл не найден."),
  );
}

await loadRooms();

const server = createServer(async (request, response) => {
  try {
    applySecurityHeaders(response);

    if (shuttingDown) {
      response.setHeader("Connection", "close");
      json(
        response,
        503,
        localizedError(
          request,
          "The server is restarting. Please try again shortly.",
          "Сервер перезапускается. Попробуйте снова через несколько секунд.",
        ),
      );
      return;
    }

    if ((request.url?.length ?? 0) > 2_048) {
      json(
        response,
        414,
        localizedError(request, "The URL is too long.", "URL слишком длинный."),
      );
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (await handleApi(request, response, url.pathname)) {
      return;
    }

    await handleStatic(request, response, url.pathname);
  } catch (error) {
    console.error(error);

    if (!response.headersSent) {
      json(
        response,
        500,
        localizedError(
          request,
          "Internal server error.",
          "Внутренняя ошибка сервера.",
        ),
      );
    } else {
      response.destroy();
    }
  }
});

server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1_000;
server.requestTimeout = 15_000;

const cleanupTimer = setInterval(() => {
  if (pruneExpiredRooms()) {
    void persistRooms().catch((error) => {
      console.error(`Expired rooms could not be persisted: ${error.message}`);
    });
  }
}, Math.min(roomTtlMs, 60 * 60 * 1_000));

cleanupTimer.unref();

server.listen(port, host, () => {
  console.log(`Ninjitsi server: http://localhost:${port}`);
  console.log(`Room registry: ${roomsPath}`);
  console.log(`Jitsi: ${jitsiUrl || "not configured"}`);
  console.log(`Jitsi admission: ${jitsiAuthMode}`);
});

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(cleanupTimer);
  console.log(`${signal}: finishing active requests`);

  const forcedExit = setTimeout(() => {
    console.error("Graceful shutdown timed out");
    process.exit(1);
  }, 15_000);
  forcedExit.unref();

  await new Promise((resolveClose) => {
    server.close(resolveClose);
    server.closeIdleConnections?.();
  });
  await writeQueue.catch((error) => {
    console.error(`Final room registry write failed: ${error.message}`);
    process.exitCode = 1;
  });
  clearTimeout(forcedExit);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
