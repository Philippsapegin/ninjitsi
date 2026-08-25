import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  CapacityError,
  ConcurrencyGate,
  SlidingWindowRateLimiter,
  createJitsiToken,
  makeRoomCode,
} from "../server/security.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

test("room codes carry at least 96 bits of random suffix entropy", () => {
  const codes = new Set(Array.from({ length: 2_000 }, () => makeRoomCode()));

  assert.equal(codes.size, 2_000);
  for (const code of codes) {
    assert.match(code, /^[a-z]+-[a-z]+-[a-f0-9]{24}$/);
  }
});

test("sliding-window limiter blocks and reports its reset", () => {
  const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 1_000 });

  assert.deepEqual(limiter.check("client", 1_000), {
    allowed: true,
    limit: 2,
    remaining: 1,
    resetAt: 2_000,
    retryAfterSeconds: 0,
  });
  assert.equal(limiter.check("client", 1_500).allowed, true);
  assert.deepEqual(limiter.check("client", 1_750), {
    allowed: false,
    limit: 2,
    remaining: 0,
    resetAt: 2_000,
    retryAfterSeconds: 1,
  });
  assert.equal(limiter.check("client", 2_001).allowed, true);

  const failureLimiter = new SlidingWindowRateLimiter({
    limit: 1,
    windowMs: 1_000,
  });
  assert.deepEqual(failureLimiter.peek("shared-nat", 5_000), {
    allowed: true,
    limit: 1,
    remaining: 1,
    resetAt: 6_000,
    retryAfterSeconds: 0,
  });
  assert.equal(failureLimiter.peek("shared-nat", 5_000).allowed, true);
  assert.equal(failureLimiter.check("shared-nat", 5_000).allowed, true);
  assert.equal(failureLimiter.peek("shared-nat", 5_001).allowed, false);
});

test("concurrency gate caps active and queued expensive work", async () => {
  const gate = new ConcurrencyGate({ maxActive: 1, maxQueued: 1 });
  let releaseFirst;
  const first = gate.run(
    () =>
      new Promise((resolveRun) => {
        releaseFirst = resolveRun;
      }),
  );
  const second = gate.run(async () => "second");

  await assert.rejects(() => gate.run(async () => "third"), CapacityError);
  releaseFirst("first");
  assert.equal(await first, "first");
  assert.equal(await second, "second");
});

test("Jitsi tokens are room-scoped, expiring HS256 tokens", () => {
  const secret = "a".repeat(64);
  const token = createJitsiToken({
    appId: "ninjitsi",
    audience: "ninjitsi",
    displayName: "Alice",
    expiresInSeconds: 43_200,
    nowSeconds: 1_000,
    room: "quiet-room-0123456789abcdef01234567",
    secret,
    subject: "meet.jitsi",
  });
  const [encodedHeader, encodedPayload, signature] = token.split(".");
  const expectedSignature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url"));

  assert.equal(signature, expectedSignature);
  assert.equal(payload.room, "quiet-room-0123456789abcdef01234567");
  assert.equal(payload.context.user.name, "Alice");
  assert.equal(payload.sub, "meet.jitsi");
  assert.equal(payload.exp, 44_200);
});

test("room server prunes expired rooms, preserves capacity and issues admission tokens", async (context) => {
  const dataRoot = join(
    tmpdir(),
    `ninjitsi-security-${process.pid}-${Date.now()}`,
  );
  const port = await reservePort();
  const secret = "b".repeat(64);
  const oldCreatedAt = "2020-01-01T00:00:00.000Z";

  await mkdir(dataRoot, { recursive: true });
  await writeFile(
    join(dataRoot, "rooms.json"),
    JSON.stringify({
      rooms: [
        {
          code: "legacy-room-00001",
          createdAt: oldCreatedAt,
          passwordHash: "",
          passwordRequired: false,
          passwordSalt: "",
        },
      ],
      version: 1,
    }),
  );

  const child = spawn(process.execPath, ["server/server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DATA_DIR: dataRoot,
      HOST: "127.0.0.1",
      JITSI_AUTH_MODE: "token",
      JITSI_JWT_APP_ID: "ninjitsi",
      JITSI_JWT_AUDIENCE: "ninjitsi",
      JITSI_JWT_SECRET: secret,
      JITSI_JWT_SUBJECT: "meet.jitsi",
      JITSI_URL: "https://jitsi.example.test",
      MAX_ROOMS: "2",
      PORT: String(port),
      ROOM_CREATE_GLOBAL_RATE_LIMIT: "100",
      ROOM_CREATE_RATE_LIMIT: "20",
      ROOM_LOOKUP_RATE_LIMIT: "20",
      STATIC_ROOT: projectRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  child.stdout.on("data", (chunk) => {
    serverOutput += chunk;
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += chunk;
  });

  context.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }

    await rm(dataRoot, { force: true, recursive: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child, () => serverOutput);

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  const health = await healthResponse.json();

  assert.equal(health.authMode, "token");
  assert.equal(health.roomCount, 0);
  assert.match(
    healthResponse.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal(healthResponse.headers.get("x-frame-options"), "DENY");
  assert.match(
    healthResponse.headers.get("permissions-policy"),
    /microphone=\(self\)/,
  );

  const concurrentCreates = await Promise.all(
    Array.from({ length: 4 }, async () => {
      const response = await fetch(`${baseUrl}/api/rooms`, {
        body: JSON.stringify({ password: "correct horse battery staple" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      return { body: await response.json(), status: response.status };
    }),
  );
  const successfulCreates = concurrentCreates.filter(
    ({ status }) => status === 201,
  );

  assert.equal(successfulCreates.length, 2);
  assert.equal(
    concurrentCreates.filter(({ status }) => status === 503).length,
    2,
  );
  const [first, second] = successfulCreates.map(({ body }) => body);

  assert.match(first.room.code, /^[a-z]+-[a-z]+-[a-f0-9]{24}$/);
  assert.notEqual(first.room.code, second.room.code);
  assert.ok(Date.parse(first.room.expiresAt) > Date.parse(first.room.createdAt));

  const wrongPassword = await fetch(
    `${baseUrl}/api/rooms/${first.room.code}/join`,
    {
      body: JSON.stringify({ displayName: "Alice", password: "wrong" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(wrongPassword.status, 403);

  const admittedResponse = await fetch(
    `${baseUrl}/api/rooms/${first.room.code}/join`,
    {
      body: JSON.stringify({
        displayName: "Alice",
        password: "correct horse battery staple",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  const admitted = await admittedResponse.json();

  assert.equal(admittedResponse.status, 200);
  assert.equal(admitted.admitted, true);
  assert.equal(typeof admitted.jitsiToken, "string");
  const tokenPayload = JSON.parse(
    Buffer.from(admitted.jitsiToken.split(".")[1], "base64url"),
  );
  assert.equal(tokenPayload.room, first.room.code);
  assert.equal(tokenPayload.context.user.name, "Alice");

  const fullResponse = await fetch(`${baseUrl}/api/rooms`, {
    body: JSON.stringify({ password: "" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(fullResponse.status, 503);
  assert.equal(
    (await fetch(`${baseUrl}/api/rooms/${first.room.code}`)).status,
    200,
  );

  const stored = JSON.parse(
    await readFile(join(dataRoot, "rooms.json"), "utf8"),
  );
  assert.equal(stored.version, 2);
  assert.equal(stored.rooms.length, 2);
});

async function reservePort() {
  const server = createServer();

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));

  return address.port;
}

async function waitForHealth(baseUrl, child, output) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Room server exited early:\n${output()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // The server has not bound its socket yet.
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  throw new Error(`Room server did not become healthy:\n${output()}`);
}
