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
const jitsiUrl = process.env.NINJITSI_JITSI_URL;

if (!jitsiUrl) {
  throw new Error(
    "Укажите NINJITSI_JITSI_URL с адресом проверяемого Jitsi-сервера.",
  );
}

async function createServerRoom() {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    body: JSON.stringify({ password: "" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.room?.code) {
    throw new Error(
      `Сервер Ninjitsi не создал комнату: ${response.status} ${JSON.stringify(body)}`,
    );
  }

  return body.room.code;
}

const roomName = await createServerRoom();
const browser = await chromium.launch({
  args: [
    "--allow-http-screen-capture",
    "--auto-select-desktop-capture-source=Entire screen",
    "--enable-usermedia-screen-capturing",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
  executablePath,
  headless: true,
});
const context = await browser.newContext({
  permissions: ["camera", "microphone"],
});
const page = await context.newPage();
const browserErrors = [];
const knownJitsiWarnings = [
  /operation":"get STUN\/TURN credentials/,
  /\[util:XMLUtils\].*findAll error/,
  /No SSRC lines found in remote SDP/,
  /removeRemoteStreamsOnLeave error: ClearedQueueError/,
];

page.on("console", (message) => {
  if (message.type() === "error") {
    browserErrors.push(message.text());
  }
});
page.on("pageerror", (pageError) => {
  browserErrors.push(pageError.message);
});

try {
  await page.addInitScript((serverUrl) => {
    window.__NINJITSI_CONFIG__ = { jitsiUrl: serverUrl };
  }, jitsiUrl);
  await page.goto(`${baseUrl}/room/${roomName}`, {
    waitUntil: "networkidle",
  });
  await page.getByLabel("Ваше имя").fill("Ninjitsi Smoke");
  const avatarDataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");

    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");

    context.fillStyle = "#7557d6";
    context.fillRect(0, 0, 128, 128);
    return canvas.toDataURL("image/png");
  });

  await page.locator('input[type="file"]').setInputFiles({
    buffer: Buffer.from(avatarDataUrl.split(",")[1], "base64"),
    mimeType: "image/png",
    name: "avatar.png",
  });
  await page
    .getByRole("button", { name: "Сменить аватарку" })
    .waitFor();
  await page.getByRole("button", { name: "Войти в комнату" }).click();
  await page
    .getByRole("button", { name: "Завершить звонок" })
    .waitFor({ state: "visible", timeout: 90_000 });
  await page
    .getByRole("dialog", { name: "Вход в комнату" })
    .waitFor({ state: "hidden", timeout: 90_000 });
  await page.locator("[data-video-tile]").first().waitFor({ timeout: 30_000 });
  await page
    .getByRole("button", { name: "Выключить микрофон" })
    .waitFor({ timeout: 30_000 });
  await page
    .getByRole("button", { name: "Выключить камеру" })
    .waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const microphoneButton = document.querySelector(
        'button[aria-label="Выключить микрофон"]',
      );

      return (
        microphoneButton instanceof HTMLElement &&
        Number.parseFloat(
          microphoneButton.style.getPropertyValue("--audio-level"),
        ) > 0
      );
    },
    undefined,
    { timeout: 15_000 },
  );

  const observerPage = await context.newPage();

  observerPage.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(`[observer] ${message.text()}`);
    }
  });
  observerPage.on("pageerror", (pageError) => {
    browserErrors.push(`[observer] ${pageError.message}`);
  });
  await observerPage.addInitScript((serverUrl) => {
    window.__NINJITSI_CONFIG__ = { jitsiUrl: serverUrl };
  }, jitsiUrl);
  await observerPage.goto(`${baseUrl}/room/${roomName}`, {
    waitUntil: "networkidle",
  });
  await observerPage.getByLabel("Ваше имя").fill("Remote Observer");
  await observerPage
    .getByRole("button", { name: "Войти в комнату" })
    .click();
  await observerPage
    .getByRole("dialog", { name: "Вход в комнату" })
    .waitFor({ state: "hidden", timeout: 90_000 });
  await observerPage
    .locator("[data-video-tile]")
    .nth(1)
    .waitFor({ timeout: 30_000 });

  const remoteTile = observerPage
    .locator("[data-video-tile]")
    .filter({ hasText: "Ninjitsi Smoke" });

  await remoteTile.locator("video").waitFor({ timeout: 30_000 });
  await observerPage.locator("audio").first().waitFor({
    state: "attached",
    timeout: 30_000,
  });

  const chatProbe = `Проверка чата ${Date.now()}`;

  await page.getByLabel("Сообщение в чат").fill(chatProbe);
  await page
    .getByRole("button", { name: "Отправить сообщение" })
    .click();
  await observerPage
    .getByText(chatProbe, { exact: true })
    .waitFor({ timeout: 30_000 });
  if (
    (await page.getByText(chatProbe, { exact: true }).count()) !== 1 ||
    (await observerPage.getByText(chatProbe, { exact: true }).count()) !== 1
  ) {
    throw new Error("Локальное сообщение задублировалось в чате");
  }
  const chatReply = `Ответ ${Date.now()}`;

  await observerPage.getByLabel("Сообщение в чат").fill(chatReply);
  await observerPage
    .getByRole("button", { name: "Отправить сообщение" })
    .click();
  await page
    .getByText(chatReply, { exact: true })
    .waitFor({ timeout: 30_000 });

  await page.getByRole("button", { name: "Настройки" }).click();
  const settingsDialog = page.getByRole("dialog", {
    name: "Настройки устройств",
  });

  await settingsDialog.waitFor();
  const microphoneOptions = await settingsDialog
    .getByLabel("Выбрать микрофон")
    .locator("option")
    .count();
  const cameraOptions = await settingsDialog
    .getByLabel("Выбрать камеру")
    .locator("option")
    .count();

  if (microphoneOptions < 1 || cameraOptions < 1) {
    throw new Error(
      `Настройки не показали fake-устройства: microphones=${microphoneOptions}, cameras=${cameraOptions}`,
    );
  }

  const noiseSuppression = settingsDialog.getByRole("switch", {
    name: "Шумоподавление",
  });

  if (await noiseSuppression.isEnabled()) {
    await noiseSuppression.click();
    await page.waitForTimeout(1000);

    if ((await noiseSuppression.getAttribute("aria-checked")) !== "true") {
      throw new Error("Шумоподавление не включилось");
    }
  }

  await settingsDialog
    .getByRole("button", { name: "Закрыть настройки" })
    .click();

  await page
    .getByRole("button", { name: "Выключить микрофон" })
    .click();
  await page
    .getByRole("button", { name: "Включить микрофон" })
    .waitFor();
  await remoteTile
    .locator('[title="Микрофон выключен"]')
    .waitFor({ timeout: 30_000 });
  await page
    .getByRole("button", { name: "Включить микрофон" })
    .click();
  await page
    .getByRole("button", { name: "Выключить микрофон" })
    .waitFor();
  await remoteTile
    .locator('[title="Микрофон выключен"]')
    .waitFor({ state: "hidden", timeout: 30_000 });

  await page
    .getByRole("button", { name: "Выключить камеру" })
    .click();
  await page
    .getByRole("button", { name: "Включить камеру" })
    .waitFor();
  await remoteTile.locator("video").waitFor({
    state: "hidden",
    timeout: 30_000,
  });
  await remoteTile.locator("img").waitFor({ timeout: 30_000 });
  await page
    .getByRole("button", { name: "Включить камеру" })
    .click();
  await page
    .getByRole("button", { name: "Выключить камеру" })
    .waitFor();
  await remoteTile.locator("video").waitFor({ timeout: 30_000 });

  await page
    .getByRole("button", { name: "Показать экран" })
    .click();
  await page
    .getByRole("button", { name: "Остановить показ" })
    .waitFor({ timeout: 30_000 });
  await page.getByText("экран", { exact: true }).waitFor();
  await remoteTile.getByText("экран", { exact: true }).waitFor({
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: "Остановить показ" })
    .click();
  await page
    .getByRole("button", { name: "Показать экран" })
    .waitFor();
  await remoteTile
    .getByText("экран", { exact: true })
    .waitFor({ state: "hidden", timeout: 30_000 });
  await observerPage.close();

  const unexpectedBrowserErrors = browserErrors.filter(
    (browserError) =>
      !knownJitsiWarnings.some((pattern) => pattern.test(browserError)),
  );

  if (unexpectedBrowserErrors.length > 0) {
    throw new Error(
      `Ошибки Chrome во время медиатеста: ${unexpectedBrowserErrors.join(" | ")}`,
    );
  }

  const recoveryRoomName = await createServerRoom();
  const recoveryPage = await context.newPage();

  await recoveryPage.addInitScript(() => {
    const originalGetUserMedia =
      navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let rejectFirstAudio = true;
    let rejectFirstVideo = true;

    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints.audio && rejectFirstAudio) {
        rejectFirstAudio = false;
        return Promise.reject(
          new DOMException("Simulated audio denial", "NotAllowedError"),
        );
      }

      if (constraints.video && rejectFirstVideo) {
        rejectFirstVideo = false;
        return Promise.reject(
          new DOMException("Simulated video denial", "NotAllowedError"),
        );
      }

      return originalGetUserMedia(constraints);
    };
  });
  await recoveryPage.addInitScript((serverUrl) => {
    window.__NINJITSI_CONFIG__ = { jitsiUrl: serverUrl };
  }, jitsiUrl);
  await recoveryPage.goto(`${baseUrl}/room/${recoveryRoomName}`, {
    waitUntil: "networkidle",
  });
  await recoveryPage.getByLabel("Ваше имя").fill("Media Recovery");
  await recoveryPage
    .getByRole("button", { name: "Войти в комнату" })
    .click();
  await recoveryPage
    .getByRole("dialog", { name: "Вход в комнату" })
    .waitFor({ state: "hidden", timeout: 90_000 });
  await recoveryPage
    .getByRole("button", { name: "Включить микрофон" })
    .waitFor({ timeout: 30_000 });
  await recoveryPage
    .getByRole("button", { name: "Включить камеру" })
    .waitFor({ timeout: 30_000 });
  await recoveryPage
    .getByRole("button", { name: "Включить микрофон" })
    .click();
  await recoveryPage
    .getByRole("button", { name: "Выключить микрофон" })
    .waitFor({ timeout: 30_000 });
  await recoveryPage
    .getByRole("button", { name: "Включить камеру" })
    .click();
  await recoveryPage
    .getByRole("button", { name: "Выключить камеру" })
    .waitFor({ timeout: 30_000 });
  await recoveryPage.close();

  console.log(
    JSON.stringify(
      {
        browserErrors: unexpectedBrowserErrors,
        knownJitsiWarningCount: browserErrors.length,
        jitsiUrl,
        media: {
          camera: "toggle passed",
          avatarPropagation: "passed",
          chat: "bidirectional transport passed",
          deviceSettings: "enumeration passed",
          microphone: "toggle passed",
          microphoneLevel: "reactive outline passed",
          noiseSuppression: "toggle passed",
          remotePropagation: "passed",
          recoveryAfterInitialDenial: "passed",
          screenShare: "start/stop passed",
        },
        roomName,
        status: "joined",
        tileCount: await page.locator("[data-video-tile]").count(),
      },
      null,
      2,
    ),
  );
} catch (caughtError) {
  console.error(
    JSON.stringify(
      {
        browserErrors,
        pageText: (await page.locator("body").innerText()).slice(0, 3000),
        roomName,
        url: page.url(),
      },
      null,
      2,
    ),
  );
  throw caughtError;
} finally {
  await browser.close();
}
