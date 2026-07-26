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

const roomName = `ninjitsi-smoke-${Date.now()}`;
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
  await page.getByRole("button", { name: "Войти в комнату" }).click();
  await page
    .getByRole("button", { name: "Завершить звонок" })
    .waitFor({ state: "visible", timeout: 90_000 });
  await page
    .getByRole("dialog", { name: "Вход в комнату" })
    .waitFor({ state: "hidden", timeout: 90_000 });
  await page.locator("article").first().waitFor({ timeout: 30_000 });
  await page
    .getByRole("button", { name: "Выключить микрофон" })
    .waitFor({ timeout: 30_000 });
  await page
    .getByRole("button", { name: "Выключить камеру" })
    .waitFor({ timeout: 30_000 });

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
  await observerPage.locator("article").nth(1).waitFor({ timeout: 30_000 });

  const remoteTile = observerPage
    .locator("article")
    .filter({ hasText: "Ninjitsi Smoke" });

  await remoteTile.locator("video").waitFor({ timeout: 30_000 });
  await observerPage.locator("audio").first().waitFor({
    state: "attached",
    timeout: 30_000,
  });

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

  if (browserErrors.length > 0) {
    throw new Error(
      `Ошибки Chrome во время медиатеста: ${browserErrors.join(" | ")}`,
    );
  }

  const recoveryRoomName = `ninjitsi-recovery-${Date.now()}`;
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
        browserErrors,
        jitsiUrl,
        media: {
          camera: "toggle passed",
          microphone: "toggle passed",
          remotePropagation: "passed",
          recoveryAfterInitialDenial: "passed",
          screenShare: "start/stop passed",
        },
        roomName,
        status: "joined",
        tileCount: await page.locator("article").count(),
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
