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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

await page.addInitScript(() => {
  const originalPlay = HTMLMediaElement.prototype.play;

  localStorage.setItem("ninjitsi.locale", "ru");
  window.__NINJITSI_CONFIG__ = { jitsiUrl: "" };
  window.__ninjitsiPlayedSounds = [];
  HTMLMediaElement.prototype.play = function play() {
    const source = this.currentSrc || this.src;

    if (source.includes("/Sounds/")) {
      window.__ninjitsiPlayedSounds.push(
        new URL(source, window.location.href).pathname,
      );
      queueMicrotask(() => this.dispatchEvent(new Event("ended")));
      return Promise.resolve();
    }

    return originalPlay.call(this);
  };
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  if ((await page.getByLabel("Ваше имя").inputValue()) !== "") {
    throw new Error("Без сохранённых профилей имя должно быть пустым");
  }
  await page.getByLabel("Ваше имя").fill("Profile Tester");
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
  await page.getByLabel("Пароль комнаты").fill("profile-secret");
  await page
    .getByRole("button", { name: "Создать комнату" })
    .click();
  await page
    .getByRole("dialog", { name: "Вход в комнату" })
    .waitFor({ timeout: 30_000 });

  if ((await page.getByLabel("Ваше имя").inputValue()) !== "Profile Tester") {
    throw new Error("Профиль не перешёл из создания комнаты во вход");
  }

  const joinOverlayStrokes = await page
    .getByRole("dialog", { name: "Вход в комнату" })
    .evaluate((dialog) => {
      const elements = Array.from(dialog.querySelectorAll("*")).filter(
        (element) => element instanceof HTMLElement,
      );

      return elements
        .map((element) => ({
          borderWidth: getComputedStyle(element).borderWidth,
          label:
            element.getAttribute("aria-label") ??
            element.textContent?.trim().slice(0, 60),
        }))
        .filter(({ borderWidth }) => borderWidth !== "0px");
    });

  if (joinOverlayStrokes.length > 0) {
    throw new Error(
      `На экране входа остались строуки: ${JSON.stringify(joinOverlayStrokes)}`,
    );
  }

  await page.getByRole("button", { name: "Войти в комнату" }).click();
  await page
    .getByRole("dialog", { name: "Вход в комнату" })
    .waitFor({ state: "hidden" });
  await page.locator("[data-video-tile]").first().locator("img").waitFor();
  await page.waitForFunction(
    () =>
      (window.__ninjitsiPlayedSounds ?? []).some((source) =>
        source.endsWith("Nin.initial_room_enter.wav"),
      ),
    undefined,
    { timeout: 10_000 },
  );
  await page.getByRole("button", { name: "Настройки" }).click();
  const creatorPassword = page.getByLabel("Пароль комнаты создателя");

  await creatorPassword.waitFor();
  if (
    (await creatorPassword.inputValue()) !== "profile-secret" ||
    (await creatorPassword.getAttribute("type")) !== "password"
  ) {
    throw new Error("Создатель не видит сохранённый пароль комнаты.");
  }
  await page.getByRole("button", { name: "Закрыть настройки" }).click();

  const storedProfiles = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("ninjitsi.profiles") ?? "[]"),
  );

  if (
    storedProfiles.length !== 1 ||
    storedProfiles[0].displayName !== "Profile Tester" ||
    !storedProfiles[0].avatarDataUrl.startsWith("data:image/webp")
  ) {
    throw new Error(
      `Профиль сохранился неверно: ${JSON.stringify(storedProfiles)}`,
    );
  }

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="Ваше имя"]')?.value ===
      "Profile Tester",
  );
  await page.getByRole("button", { name: "Новый" }).click();

  if ((await page.getByLabel("Ваше имя").inputValue()) !== "") {
    throw new Error("Новый профиль не очистил редактор");
  }

  await page
    .getByRole("button", { name: "Выбрать профиль Profile Tester" })
    .click();

  if ((await page.getByLabel("Ваше имя").inputValue()) !== "Profile Tester") {
    throw new Error("Сохранённый профиль нельзя выбрать повторно");
  }

  const selectedProfileButton = page.getByRole("button", {
    name: "Выбрать профиль Profile Tester",
  });

  if (
    (await selectedProfileButton.evaluate(
      (button) => getComputedStyle(button).outlineColor,
    )) === "rgba(0, 0, 0, 0)"
  ) {
    throw new Error(
      `На экране входа остались строуки либо потерян зелёный выбор профиля: ${JSON.stringify(joinOverlayStrokes)}`,
    );
  }

  await page
    .getByRole("button", { name: "Удалить профиль Profile Tester" })
    .click();

  if (
    (await page.getByLabel("Ваше имя").inputValue()) !== "" ||
    (await page.evaluate(() =>
      JSON.parse(localStorage.getItem("ninjitsi.profiles") ?? "[]"),
    )).length !== 0
  ) {
    throw new Error("Крестик не удалил выбранный профиль");
  }

  console.log(
    JSON.stringify(
      {
        avatar: "uploaded and restored",
        deletion: "selected profile removed",
        initialRoomSound: "played for creator",
        joinOverlayStrokes: "removed",
        profileCount: storedProfiles.length,
        selection: "restored",
        status: "passed",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
