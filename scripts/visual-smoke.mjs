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
      right: bounds.right,
      viewportWidth: document.documentElement.clientWidth,
      width: bounds.width,
    };
  });

  if (
    Math.abs(chatPosition.right - chatPosition.viewportWidth) > 1 ||
    chatPosition.borderWidth !== "0px"
  ) {
    throw new Error(
      `Чат не закреплён справа или сохранил строук: ${JSON.stringify(chatPosition)}`,
    );
  }

  await page.getByRole("button", { name: "Свернуть чат" }).click();
  await page.waitForTimeout(260);
  const collapsedWidth = await chatSidebar.evaluate(
    (element) => element.getBoundingClientRect().width,
  );

  if (collapsedWidth > 45) {
    throw new Error(`Чат не свернулся: width=${collapsedWidth}`);
  }

  await page.getByRole("button", { name: "Развернуть чат" }).click();
  await page.waitForTimeout(260);

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
