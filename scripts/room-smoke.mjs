import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const chromeCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) =>
  existsSync(candidate),
);

if (!executablePath) {
  throw new Error(
    "Chrome не найден. Укажите PLAYWRIGHT_CHROMIUM_EXECUTABLE.",
  );
}

const baseUrl = process.env.NINJITSI_BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const creator = await browser.newPage();

  await creator.addInitScript(() => {
    localStorage.setItem("ninjitsi.locale", "ru");
  });
  await creator.goto(baseUrl, { waitUntil: "networkidle" });
  await creator.getByLabel("Ваше имя").fill("Создатель");
  await creator.getByRole("button", { name: "Создать комнату" }).click();
  await creator.waitForURL(/\/room\/[^/]+$/, { timeout: 15_000 });
  await creator
    .getByRole("dialog", { name: "Вход в комнату" })
    .waitFor({ timeout: 15_000 });

  const roomCode = decodeURIComponent(
    new URL(creator.url()).pathname.split("/").at(-1),
  );
  const lookupResponse = await fetch(
    `${baseUrl}/api/rooms/${encodeURIComponent(roomCode)}`,
  );

  if (!lookupResponse.ok) {
    throw new Error("Созданная через UI комната отсутствует в API.");
  }

  const protectedCreateResponse = await fetch(`${baseUrl}/api/rooms`, {
    body: JSON.stringify({ password: "smoke-secret" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const protectedRoom = await protectedCreateResponse.json();
  const wrongPasswordResponse = await fetch(
    `${baseUrl}/api/rooms/${protectedRoom.room.code}/join`,
    {
      body: JSON.stringify({ password: "wrong-secret" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  const correctPasswordResponse = await fetch(
    `${baseUrl}/api/rooms/${protectedRoom.room.code}/join`,
    {
      body: JSON.stringify({ password: "smoke-secret" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  const wrongPasswordBody = await wrongPasswordResponse.json();
  const russianWrongPasswordResponse = await fetch(
    `${baseUrl}/api/rooms/${protectedRoom.room.code}/join`,
    {
      body: JSON.stringify({ password: "wrong-secret" }),
      headers: {
        "Content-Type": "application/json",
        "X-Ninjitsi-Locale": "ru",
      },
      method: "POST",
    },
  );
  const russianWrongPasswordBody =
    await russianWrongPasswordResponse.json();

  if (
    wrongPasswordResponse.status !== 403 ||
    wrongPasswordBody.error !== "The room password is incorrect." ||
    russianWrongPasswordBody.error !== "Пароль комнаты не подошёл." ||
    !correctPasswordResponse.ok
  ) {
    throw new Error("Сервер некорректно проверяет пароль комнаты.");
  }

  const guest = await browser.newPage();

  await guest.addInitScript(() => {
    localStorage.setItem("ninjitsi.locale", "ru");
  });
  await guest.goto(baseUrl, { waitUntil: "networkidle" });
  await guest.getByRole("button", { name: "Войти по коду" }).click();
  await guest.getByLabel("Код комнаты").fill(roomCode);
  await guest.getByLabel("Ваше имя").fill("Гость");
  await guest.getByRole("button", { name: "Войти в комнату" }).click();
  await guest.waitForURL(new RegExp(`/room/${roomCode}$`), {
    timeout: 15_000,
  });
  await guest
    .getByRole("dialog", { name: "Вход в комнату" })
    .waitFor({ timeout: 15_000 });

  const invalid = await browser.newPage();

  await invalid.addInitScript(() => {
    localStorage.setItem("ninjitsi.locale", "ru");
  });
  await invalid.goto(`${baseUrl}/room/not-created-99999`, {
    waitUntil: "networkidle",
  });
  await invalid.getByText("Войти не получилось").waitFor({
    timeout: 15_000,
  });

  console.log(
    JSON.stringify(
      {
        directUnknownRoom: "rejected",
        existingRoomJoin: "accepted",
        passwordAdmission: "enforced",
        roomCode,
        uiRoomCreation: "persisted",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
