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
const maxRooms = Number.parseInt(process.env.MAX_ROOMS ?? "10000", 10);
const roomCodePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const codeWords = [
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
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const scrypt = promisify(scryptCallback);

let rooms = new Map();
let writeQueue = Promise.resolve();

function json(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
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
    passwordRequired: room.passwordRequired,
  };
}

function makeRoomCode() {
  const entropy = randomBytes(4);
  const first = codeWords[entropy[0] % codeWords.length];
  const second = codeWords[entropy[1] % codeWords.length];
  const suffix = entropy.readUInt16BE(2).toString().padStart(5, "0");

  return `${first}-${second}-${suffix}`;
}

function nextRoomCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = makeRoomCode();

    if (!rooms.has(code)) {
      return code;
    }
  }

  return `room-${randomBytes(10).toString("hex")}`;
}

async function passwordDigest(password, salt) {
  const digest = await scrypt(password, salt, 32);

  return Buffer.from(digest);
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
      version: 1,
    },
    null,
    2,
  );
  const temporaryPath = `${roomsPath}.${process.pid}.tmp`;

  writeQueue = writeQueue.then(async () => {
    await writeFile(temporaryPath, snapshot, "utf8");
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
            typeof room.passwordRequired === "boolean" &&
            (!room.passwordRequired ||
              (typeof room.passwordHash === "string" &&
                /^[a-f0-9]{64}$/.test(room.passwordHash) &&
                typeof room.passwordSalt === "string" &&
                /^[a-f0-9]{32}$/.test(room.passwordSalt))),
        )
        .map((room) => [room.code, room]),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Room registry could not be read: ${error.message}`);
    }
  }
}

async function handleApi(request, response, pathname) {
  if (pathname === "/api/health" && request.method === "GET") {
    json(response, 200, {
      jitsiConfigured: Boolean(jitsiUrl),
      ok: true,
      roomCount: rooms.size,
    });
    return true;
  }

  if (pathname === "/api/rooms" && request.method === "POST") {
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

    if (rooms.size >= maxRooms) {
      const oldestCode = rooms.keys().next().value;

      if (oldestCode) {
        rooms.delete(oldestCode);
      }
    }

    const code = nextRoomCode();
    const passwordSalt = password ? randomBytes(16).toString("hex") : "";
    const passwordHash = password
      ? (await passwordDigest(password, passwordSalt)).toString("hex")
      : "";
    const room = {
      code,
      createdAt: new Date().toISOString(),
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
      body.password.length > 200
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

    if (!(await passwordMatches(room, body.password))) {
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

    json(response, 200, { admitted: true, room: publicRoom(room) });
    return true;
  }

  const roomMatch = pathname.match(/^\/api\/rooms\/([^/]+)$/);

  if (roomMatch && request.method === "GET") {
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

server.listen(port, host, () => {
  console.log(`Ninjitsi server: http://localhost:${port}`);
  console.log(`Room registry: ${roomsPath}`);
  console.log(`Jitsi: ${jitsiUrl || "not configured"}`);
});
