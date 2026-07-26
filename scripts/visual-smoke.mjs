import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const screenshotPath =
  process.env.NINJITSI_SCREENSHOT ??
  join(tmpdir(), `ninjitsi-grid-${Date.now()}.png`);
const landingScreenshotPath = join(
  tmpdir(),
  `ninjitsi-landing-${Date.now()}.png`,
);
const volumeScreenshotPath = join(
  tmpdir(),
  `ninjitsi-volume-${Date.now()}.png`,
);
const chatScreenshotPath = join(
  tmpdir(),
  `ninjitsi-chat-${Date.now()}.png`,
);
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.addInitScript(() => {
  window.__NINJITSI_CONFIG__ = { jitsiUrl: "" };
});

page.on("console", (message) => {
  if (message.type() === "error") {
    console.error(`[browser console] ${message.text()}`);
  }
});
page.on("pageerror", (pageError) => {
  console.error(`[browser error] ${pageError.message}`);
});

try {
  const landingResults = [];

  for (const viewport of [
    { width: 1040, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page
      .getByRole("heading", { name: "Проще некуда" })
      .waitFor();

    const preview = page.locator("[data-landing-preview]");
    const previewTopBefore = await preview.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    const strokes = await Promise.all([
      page.locator("form").first().evaluate(
        (element) => getComputedStyle(element).borderWidth,
      ),
      page.getByLabel("Действие с комнатой").evaluate(
        (element) => getComputedStyle(element).borderWidth,
      ),
      page.getByLabel("Пароль комнаты").evaluate(
        (element) => getComputedStyle(element).borderWidth,
      ),
      preview.evaluate(
        (element) => getComputedStyle(element).borderWidth,
      ),
    ]);

    if (strokes.some((borderWidth) => borderWidth !== "0px")) {
      throw new Error(
        `На главной остались строуки: ${JSON.stringify(strokes)}`,
      );
    }

    await page
      .getByRole("button", { name: "Войти по коду" })
      .click();
    await page.waitForTimeout(100);
    const previewTopAfter = await preview.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    const pageMetrics = await page.evaluate(() => {
      const formBounds = document
        .querySelector("form")
        ?.getBoundingClientRect();
      const previewBounds = document
        .querySelector("[data-landing-preview]")
        ?.getBoundingClientRect();

      return {
        clientHeight: document.documentElement.clientHeight,
        clientWidth: document.documentElement.clientWidth,
        formBottom: formBounds?.bottom,
        previewBottom: previewBounds?.bottom,
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });

    if (Math.abs(previewTopAfter - previewTopBefore) > 1) {
      throw new Error(
        `Демо прыгает при смене режима: ${previewTopBefore} -> ${previewTopAfter}`,
      );
    }

    if (
      pageMetrics.scrollHeight !== pageMetrics.clientHeight ||
      pageMetrics.scrollWidth !== pageMetrics.clientWidth ||
      (pageMetrics.formBottom ?? Number.POSITIVE_INFINITY) >
        pageMetrics.clientHeight ||
      (pageMetrics.previewBottom ?? Number.POSITIVE_INFINITY) >
        pageMetrics.clientHeight
    ) {
      throw new Error(
        `Главная не помещается в ${viewport.width}x${viewport.height}: ${JSON.stringify(pageMetrics)}`,
      );
    }

    landingResults.push({ pageMetrics, viewport });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.screenshot({ path: landingScreenshotPath });

  const createResponse = await fetch(`${baseUrl}/api/rooms`, {
    body: JSON.stringify({ password: "" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!createResponse.ok) {
    throw new Error(`Сервер не создал тестовую комнату: ${createResponse.status}`);
  }

  const { room } = await createResponse.json();

  await page.goto(`${baseUrl}/room/${room.code}`, {
    waitUntil: "networkidle",
  });
  await page.getByLabel("Ваше имя").fill("Visual Tester");
  await page.getByRole("button", { name: "Войти в комнату" }).click();
  const videoTiles = page.locator("[data-video-tile]");

  await videoTiles.first().waitFor();

  const viewportResults = [];

  for (const viewport of [
    { width: 1040, height: 720 },
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(400);

    const tileMetrics = await videoTiles.evaluateAll((tiles) =>
      tiles.map((tile) => {
        const bounds = tile.getBoundingClientRect();

        return {
          bottom: bounds.bottom,
          height: bounds.height,
          ratio: bounds.width / bounds.height,
          top: bounds.top,
          width: bounds.width,
        };
      }),
    );
    const pageMetrics = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      controlsTop: document
        .querySelector("footer")
        ?.getBoundingClientRect().top,
      gridTop: document
        .querySelector("[data-video-tile]")
        ?.parentElement?.parentElement?.getBoundingClientRect().top,
      scrollWidth: document.documentElement.scrollWidth,
    }));

    if (tileMetrics.length !== 7) {
      throw new Error(`Ожидалось 7 плиток, найдено ${tileMetrics.length}`);
    }

    if (
      !tileMetrics.every(
        ({ ratio }) => Math.abs(ratio - 16 / 9) < 0.001,
      )
    ) {
      throw new Error(
        `Нарушено соотношение плиток: ${JSON.stringify(tileMetrics)}`,
      );
    }

    if (
      tileMetrics.some(
        ({ bottom, top }) =>
          top < (pageMetrics.gridTop ?? 0) ||
          bottom > (pageMetrics.controlsTop ?? Number.POSITIVE_INFINITY),
      )
    ) {
      throw new Error(
        `Плитки пересекаются с панелями на ${viewport.width}x${viewport.height}: ${JSON.stringify({ pageMetrics, tileMetrics })}`,
      );
    }

    if (pageMetrics.scrollWidth !== pageMetrics.clientWidth) {
      throw new Error(
        `На ${viewport.width}x${viewport.height} появился горизонтальный скролл`,
      );
    }

    viewportResults.push({ pageMetrics, tileMetrics, viewport });
  }

  const chatSidebar = page.getByRole("complementary");

  if ((await chatSidebar.count()) !== 1) {
    throw new Error("Не найден единственный правый чат");
  }

  const chatPosition = await chatSidebar.evaluate((element) => {
    const bounds = element.getBoundingClientRect();

    return {
      borderWidth: getComputedStyle(element).borderWidth,
      bottom: bounds.bottom,
      right: bounds.right,
      viewportHeight: document.documentElement.clientHeight,
      viewportWidth: document.documentElement.clientWidth,
      width: bounds.width,
    };
  });

  if (
    Math.abs(chatPosition.right - chatPosition.viewportWidth) > 1 ||
    Math.abs(chatPosition.bottom - chatPosition.viewportHeight) > 1 ||
    chatPosition.borderWidth !== "0px"
  ) {
    throw new Error(
      `Чат не закреплён справа или сохранил строук: ${JSON.stringify(chatPosition)}`,
    );
  }

  const copyButton = page.getByRole("button", {
    name: "Скопировать ссылку",
  });
  const fullscreenButton = page.getByRole("button", {
    name: "Полноэкранный режим",
  });
  const headerBackgrounds = await Promise.all([
    copyButton.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
    page
      .locator("[data-connection-summary]")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);

  if (headerBackgrounds[0] !== headerBackgrounds[1]) {
    throw new Error(
      `Таймер и кнопки имеют разную подложку: ${JSON.stringify(headerBackgrounds)}`,
    );
  }

  for (const button of [copyButton, fullscreenButton]) {
    await button.hover();
    await page.waitForTimeout(180);
    const colors = await button.evaluate((element) => {
      const probe = document.createElement("span");

      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;

      probe.remove();
      return {
        accent,
        current: getComputedStyle(element).color,
      };
    });

    if (colors.current !== colors.accent) {
      throw new Error(
        `Верхняя кнопка не зеленеет при наведении: ${JSON.stringify(colors)}`,
      );
    }
  }

  await page.getByRole("button", { name: "Свернуть чат" }).click();
  await page.waitForTimeout(260);
  const collapsedTab = page.getByRole("button", {
    name: "Развернуть чат",
  });
  const collapsedWidth = await chatSidebar.evaluate(
    (element) => element.getBoundingClientRect().width,
  );

  if (
    collapsedWidth > 45 ||
    (await collapsedTab.textContent())?.trim()
  ) {
    throw new Error(`Чат не свернулся: width=${collapsedWidth}`);
  }

  await collapsedTab.click();
  await page.waitForTimeout(260);

  const remoteVolumeButton = page.getByRole("button", {
    name: "Громкость участника Лера К.: 100%",
  });

  await remoteVolumeButton.click();
  const volumeSlider = page.getByRole("slider", {
    name: "Громкость Лера К.",
  });

  await volumeSlider.fill("200");
  await page
    .getByRole("button", {
      name: "Громкость участника Лера К.: 200%",
    })
    .waitFor();
  await page.screenshot({ path: volumeScreenshotPath });
  if (
    (await page
      .getByRole("button", {
        name: "Вернуть сетку из сцены Лера К.",
      })
      .count()) !== 0
  ) {
    throw new Error("Клик по имени переключил сетку в режим сцены");
  }

  await page.getByLabel("Выбрать получателей сообщения").click();
  await page
    .getByRole("region", { name: "Получатели сообщения" })
    .getByRole("button", { name: /Лера К\./ })
    .click();
  await page.getByLabel("Сообщение в чат").fill("Личное демо");
  await page
    .getByRole("button", { name: "Отправить сообщение" })
    .click();
  await page
    .locator("article")
    .filter({ hasText: "Личное демо" })
    .getByText("Лично: Лера К.", { exact: true })
    .waitFor();
  await page.getByText("Visual Tester", { exact: true }).last().waitFor();
  await page.screenshot({ path: chatScreenshotPath });

  await page
    .getByRole("button", { name: "Показать на сцене Visual Tester" })
    .click();
  await page
    .getByRole("button", {
      name: "Вернуть сетку из сцены Visual Tester",
    })
    .waitFor();
  await page
    .getByRole("button", {
      name: "Вернуть сетку из сцены Visual Tester",
    })
    .click();
  await page
    .getByRole("button", { name: "Показать на сцене Visual Tester" })
    .waitFor();

  await page.getByRole("button", { name: "Настройки" }).click();
  await page
    .getByRole("dialog", { name: "Настройки устройств" })
    .waitFor();

  const tileAppearance = await videoTiles.first().evaluate(
    (tile) => {
      const style = getComputedStyle(tile);

      return {
        borderWidth: style.borderWidth,
        radius: style.borderRadius,
      };
    },
  );

  if (tileAppearance.borderWidth !== "0px" || tileAppearance.radius !== "8px") {
    throw new Error(
      `Оформление видеоплитки не соответствует макету: ${JSON.stringify(tileAppearance)}`,
    );
  }

  await page.screenshot({ path: screenshotPath });
  console.log(
    JSON.stringify(
      {
        screenshotPath,
        chatScreenshotPath,
        landingScreenshotPath,
        volumeScreenshotPath,
        landing: landingResults.map(({ viewport }) => viewport),
        scenarios: viewportResults.map(
          ({ tileMetrics, viewport }) => ({
            tileCount: tileMetrics.length,
            viewport,
          }),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
