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

page.on("console", (message) => {
  if (message.type() === "error") {
    console.error(`[browser console] ${message.text()}`);
  }
});
page.on("pageerror", (pageError) => {
  console.error(`[browser error] ${pageError.message}`);
});

try {
  await page.goto(`${baseUrl}/room/grid-lab`, {
    waitUntil: "networkidle",
  });
  await page.getByLabel("Ваше имя").fill("Grid Tester");
  await page.getByRole("button", { name: "Войти в комнату" }).click();
  await page.locator("article").first().waitFor();
  await page
    .getByRole("region", { name: "Лаборатория видеосетки" })
    .waitFor();

  const viewportResults = [];

  for (const phantomCount of [0, 5, 15, 35]) {
    await page
      .getByRole("button", { name: String(phantomCount), exact: true })
      .click();

    for (const viewport of [
      { width: 1040, height: 720 },
      { width: 1920, height: 1080 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(400);

      const tileMetrics = await page.locator("article").evaluateAll((tiles) =>
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
          .querySelector("article")
          ?.parentElement?.parentElement?.getBoundingClientRect().top,
        scrollWidth: document.documentElement.scrollWidth,
      }));

      if (tileMetrics.length !== phantomCount + 1) {
        throw new Error(
          `Ожидалось ${phantomCount + 1} плиток, найдено ${tileMetrics.length}`,
        );
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

      viewportResults.push({
        pageMetrics,
        phantomCount,
        tileMetrics,
        viewport,
      });
    }
  }

  if ((await page.locator("aside").count()) !== 0) {
    throw new Error("Обнаружен нежелательный sidebar");
  }

  await page.screenshot({ path: screenshotPath });
  console.log(
    JSON.stringify(
      {
        screenshotPath,
        scenarios: viewportResults.map(
          ({ phantomCount, tileMetrics, viewport }) => ({
            phantomCount,
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
