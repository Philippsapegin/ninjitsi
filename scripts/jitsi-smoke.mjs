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
    .getByRole("button", { name: "Войти в комнату" })
    .waitFor({ state: "hidden", timeout: 90_000 });
  await page.locator("article").first().waitFor({ timeout: 30_000 });

  console.log(
    JSON.stringify(
      {
        browserErrors,
        jitsiUrl,
        roomName,
        status: "joined",
        tileCount: await page.locator("article").count(),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
