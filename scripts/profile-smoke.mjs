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
  const appearanceLayout = await page.evaluate(() => {
    const avatar = document.querySelector("[data-profile-avatar]");
    const actions = Array.from(
      document.querySelectorAll(
        "[data-profile-editor] button[data-tooltip]",
      ),
    );

    return {
      actions: actions.map((action) => {
        const rect = action.getBoundingClientRect();
        const icon = action.querySelector("svg")?.getBoundingClientRect();
        const style = getComputedStyle(action);

        return {
          background: style.backgroundColor,
          bottom: rect.bottom,
          color: style.color,
          height: rect.height,
          iconHeight: icon?.height,
          label: action.getAttribute("aria-label"),
          left: rect.left,
          title: action.getAttribute("title"),
          tooltip: getComputedStyle(action, "::after").content,
          top: rect.top,
          width: rect.width,
        };
      }),
      avatar: avatar?.getBoundingClientRect().toJSON(),
    };
  });

  if (
    !appearanceLayout.avatar ||
    appearanceLayout.actions.length !== 3 ||
    appearanceLayout.actions.some(
      (action) =>
        action.left <= appearanceLayout.avatar.right ||
        action.top < appearanceLayout.avatar.top ||
        action.bottom > appearanceLayout.avatar.bottom ||
        action.width !== 16 ||
        action.height !== 16 ||
        !action.iconHeight ||
        action.iconHeight < 11 ||
        action.title !== null ||
        action.tooltip === "none",
    ) ||
    appearanceLayout.actions.some(
      (action, index) =>
        index > 0 &&
        action.top - appearanceLayout.actions[index - 1].bottom < 1,
    ) ||
    appearanceLayout.actions[1].background !== "rgb(216, 255, 99)" ||
    appearanceLayout.actions[1].color !== "rgb(17, 20, 11)" ||
    appearanceLayout.actions[2].background !== "rgb(52, 59, 67)" ||
    appearanceLayout.actions[2].color !== "rgb(216, 255, 99)"
  ) {
    throw new Error(
      `Рейка кнопок профиля выглядит неверно: ${JSON.stringify(appearanceLayout)}`,
    );
  }

  const backgroundAction = page.getByRole("button", {
    name: "Добавить фон без камеры",
  });

  await backgroundAction.hover();
  await page.waitForTimeout(120);
  if (
    (await backgroundAction.evaluate(
      (button) => getComputedStyle(button, "::after").opacity,
    )) !== "1"
  ) {
    throw new Error("Кастомный тултип фона не появляется при наведении");
  }
  const avatarDataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");

    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");

    context.fillStyle = "#7557d6";
    context.fillRect(0, 0, 128, 128);
    return canvas.toDataURL("image/png");
  });

  await page.locator('input[type="file"]').first().setInputFiles({
    buffer: Buffer.from(avatarDataUrl.split(",")[1], "base64"),
    mimeType: "image/png",
    name: "avatar.png",
  });
  await page
    .getByRole("button", { name: "Сменить аватарку" })
    .waitFor();

  await page.getByRole("button", { name: "Цвет плитки" }).click();
  await page.getByLabel("HEX-цвет плитки").fill("#326E72");
  await page.getByLabel("HEX-цвет плитки").press("Enter");
  await page
    .getByRole("button", { name: "Добавить фон без камеры" })
    .click();
  await page.getByRole("dialog", { name: "Видеофон" }).waitFor();
  const backgroundDataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");

    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");

    context.fillStyle = "#326e72";
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = "#d8ff63";
    context.fillRect(40, 40, 180, 80);
    return canvas.toDataURL("image/png");
  });

  await page.locator('input[accept*=".jpg"]').setInputFiles({
    buffer: Buffer.from(backgroundDataUrl.split(",")[1], "base64"),
    mimeType: "image/png",
    name: "background.png",
  });
  await page
    .getByRole("dialog", { name: "Видеофон" })
    .locator("img")
    .waitFor();
  await page.getByRole("button", { name: "Закрыть" }).click();
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
  const videoBackgroundToggle = page.getByRole("switch", {
    name: "Фон профиля",
  });

  await videoBackgroundToggle.waitFor();
  await videoBackgroundToggle.click();
  await page.locator("[data-video-background]").waitFor();
  await page.getByRole("button", { name: "Закрыть настройки" }).click();

  const storedProfiles = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("ninjitsi.profiles") ?? "[]"),
  );

  if (
    storedProfiles.length !== 1 ||
    storedProfiles[0].displayName !== "Profile Tester" ||
    !storedProfiles[0].avatarDataUrl.startsWith("data:image/webp") ||
    storedProfiles[0].tileColor !== "#326E72" ||
    !storedProfiles[0].videoBackgroundRevision
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

  await page
    .getByRole("button", { name: "Сменить фон без камеры" })
    .click();
  await page
    .getByRole("dialog", { name: "Видеофон" })
    .locator("img")
    .waitFor();
  await page.getByRole("button", { name: "Закрыть" }).click();

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
        background: "stored in IndexedDB and rendered while camera is off",
        color: "custom HEX restored",
        deletion: "selected profile removed",
        initialRoomSound: "played for creator",
        joinOverlayStrokes: "removed",
        profileActions: "external rail, colors and tooltips passed",
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
