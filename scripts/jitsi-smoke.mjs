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
const stabilityMs = Math.max(
  0,
  Number.parseInt(process.env.NINJITSI_STABILITY_MS ?? "0", 10) || 0,
);
const forceJvb = process.env.NINJITSI_FORCE_JVB === "1";
const allowTransportRecoveryErrors =
  process.env.NINJITSI_ALLOW_TRANSPORT_RECOVERY_ERRORS === "1";

function installSoundProbe() {
  const originalPlay = HTMLMediaElement.prototype.play;

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
}

async function waitForSound(soundPage, filename, count = 1) {
  await soundPage.waitForFunction(
    ({ expectedCount, expectedFilename }) =>
      (window.__ninjitsiPlayedSounds ?? []).filter((source) =>
        source.endsWith(expectedFilename),
      ).length >= expectedCount,
    { expectedCount: count, expectedFilename: filename },
    { timeout: 30_000 },
  );
}

async function assertTwoParticipantRowDuring(page, buttonName) {
  await page.getByRole("button", { name: buttonName }).click();

  for (let sample = 0; sample < 8; sample += 1) {
    await page.waitForTimeout(50);
    const tilePositions = await page.locator("[data-video-tile]").evaluateAll(
      (tiles) =>
        tiles.map((tile) => {
          const rect = tile.getBoundingClientRect();

          return { left: rect.left, top: rect.top };
        }),
    );

    if (
      tilePositions.length === 2 &&
      (Math.abs(tilePositions[0].top - tilePositions[1].top) > 2 ||
        Math.abs(tilePositions[0].left - tilePositions[1].left) < 2)
    ) {
      throw new Error(
        `Чат перестроил две видеоплитки в колонку: ${JSON.stringify(tilePositions)}`,
      );
    }
  }
}

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
  ...(allowTransportRecoveryErrors
    ? [
        /\[rtc:BridgeChannel\].*Channel closed/,
        /WebSocket connection .*Data frame received after close/,
        /Cannot read properties of undefined \(reading 'payloads'\)/,
      ]
    : []),
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
  await page.addInitScript(installSoundProbe);
  await page.addInitScript(() => {
    const originalGetUserMedia =
      navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    localStorage.setItem("ninjitsi.locale", "ru");
    window.__ninjitsiCapturedConstraints = [];
    navigator.mediaDevices.getUserMedia = (constraints) => {
      window.__ninjitsiCapturedConstraints.push(constraints);
      return originalGetUserMedia(constraints);
    };
  });
  await page.addInitScript(
    ({ forceJvbForTesting, serverUrl }) => {
      localStorage.setItem("ninjitsi.locale", "ru");
      window.__NINJITSI_CONFIG__ = {
        forceJvbForTesting,
        jitsiUrl: serverUrl,
      };
    },
    { forceJvbForTesting: forceJvb, serverUrl: jitsiUrl },
  );
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

  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
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
  const usedSystemMicrophone = await page.evaluate(() =>
    window.__ninjitsiCapturedConstraints.some(
      (constraints) =>
        constraints.audio &&
        typeof constraints.audio === "object" &&
        constraints.audio.deviceId?.exact === "default",
    ),
  );

  if (!usedSystemMicrophone) {
    throw new Error("Системный микрофон не передан как deviceId=default");
  }
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

  await observerPage.addInitScript(installSoundProbe);
  observerPage.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(`[observer] ${message.text()}`);
    }
  });
  observerPage.on("pageerror", (pageError) => {
    browserErrors.push(`[observer] ${pageError.message}`);
  });
  await observerPage.addInitScript(
    ({ forceJvbForTesting, serverUrl }) => {
      localStorage.setItem("ninjitsi.locale", "ru");
      window.__NINJITSI_CONFIG__ = {
        forceJvbForTesting,
        jitsiUrl: serverUrl,
      };
    },
    { forceJvbForTesting: forceJvb, serverUrl: jitsiUrl },
  );
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
  await waitForSound(page, "Nin.Connect.wav");

  for (const [clientName, clientPage] of [
    ["publisher", page],
    ["observer", observerPage],
  ]) {
    const audioRouting = await clientPage.locator("audio").evaluateAll(
      (elements) =>
        elements.map((element) => ({
          participantId: element.dataset.participantAudio,
          source: element.dataset.audioSource,
        })),
    );

    if (
      audioRouting.length !== 1 ||
      audioRouting.some(
        ({ participantId, source }) =>
          !participantId || source !== "remote",
      )
    ) {
      throw new Error(
        `${clientName} client attached a local or unidentified audio stream: ${JSON.stringify(audioRouting)}`,
      );
    }
  }

  await page
    .getByRole("button", {
      name: "Громкость участника Remote Observer: 100%",
    })
    .click();
  await page
    .getByRole("slider", { name: "Громкость Remote Observer" })
    .fill("200");
  await page
    .locator(
      'audio[data-output-volume="2"][data-audio-gain="webaudio"]',
    )
    .waitFor({ state: "attached" });
  if (
    (await page
      .getByRole("button", {
        name: "Вернуть сетку из сцены Remote Observer",
      })
      .count()) !== 0
  ) {
    throw new Error("Регулятор громкости переключил плитку в сцену");
  }

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

  const sourceMessage = observerPage
    .locator("article")
    .filter({ hasText: chatProbe });

  await sourceMessage.click();
  await sourceMessage
    .getByRole("group", { name: "Действия с сообщением" })
    .getByRole("button", { name: "Ответить" })
    .click();
  await observerPage
    .getByText("Ответ для Ninjitsi Smoke", { exact: true })
    .waitFor();
  await observerPage.getByLabel("Сообщение в чат").fill(chatReply);
  await observerPage
    .getByRole("button", { name: "Отправить сообщение" })
    .click();
  await page
    .getByText(chatReply, { exact: true })
    .waitFor({ timeout: 30_000 });
  await page
    .locator("article")
    .filter({ hasText: chatReply })
    .getByText(chatProbe, { exact: true })
    .waitFor();

  const bystanderPage = await context.newPage();

  await bystanderPage.addInitScript(installSoundProbe);
  bystanderPage.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(`[bystander] ${message.text()}`);
    }
  });
  bystanderPage.on("pageerror", (pageError) => {
    browserErrors.push(`[bystander] ${pageError.message}`);
  });
  await bystanderPage.addInitScript(
    ({ forceJvbForTesting, serverUrl }) => {
      localStorage.setItem("ninjitsi.locale", "ru");
      window.__NINJITSI_CONFIG__ = {
        forceJvbForTesting,
        jitsiUrl: serverUrl,
      };
    },
    { forceJvbForTesting: forceJvb, serverUrl: jitsiUrl },
  );
  await bystanderPage.goto(`${baseUrl}/room/${roomName}`, {
    waitUntil: "networkidle",
  });
  await bystanderPage.getByLabel("Ваше имя").fill("Silent Bystander");
  await bystanderPage
    .getByRole("button", { name: "Войти в комнату" })
    .click();
  await bystanderPage
    .getByRole("dialog", { name: "Вход в комнату" })
    .waitFor({ state: "hidden", timeout: 90_000 });
  await bystanderPage
    .getByRole("button", {
      name: "Показать на сцене Remote Observer",
    })
    .waitFor({ timeout: 30_000 });
  await waitForSound(page, "Nin.Connect.wav", 2);

  const onlyToSource = `Источник only-to ${Date.now()}`;
  const onlyToProbe = `Только для автора ${Date.now()}`;

  await observerPage.getByLabel("Сообщение в чат").fill(onlyToSource);
  await observerPage
    .getByRole("button", { name: "Отправить сообщение" })
    .click();
  await page
    .getByText(onlyToSource, { exact: true })
    .waitFor({ timeout: 30_000 });
  await bystanderPage
    .getByText(onlyToSource, { exact: true })
    .waitFor({ timeout: 30_000 });
  const onlyToSourceMessage = page
    .locator("article")
    .filter({ hasText: onlyToSource });

  await onlyToSourceMessage.click();
  await onlyToSourceMessage
    .getByRole("group", { name: "Действия с сообщением" })
    .getByRole("button", { name: "Только ему" })
    .click();
  await page.getByLabel("Сообщение в чат").fill(onlyToProbe);
  await page
    .getByRole("button", { name: "Отправить сообщение" })
    .click();
  await observerPage
    .getByText(onlyToProbe, { exact: true })
    .waitFor({ timeout: 30_000 });
  await bystanderPage.waitForTimeout(1_500);
  if (
    (await bystanderPage.getByText(onlyToProbe, { exact: true }).count()) !== 0
  ) {
    throw new Error("Only-to сообщение увидел невыбранный участник");
  }
  await page
    .getByLabel("Выбрать получателей сообщения")
    .getByText("Всем", { exact: true })
    .waitFor();

  await page.getByRole("button", { name: "Свернуть чат" }).click();
  const collapsedProbe = `Непрочитанное ${Date.now()}`;

  await observerPage.getByLabel("Сообщение в чат").fill(collapsedProbe);
  await observerPage
    .getByRole("button", { name: "Отправить сообщение" })
    .click();
  const unreadTab = page.getByRole("button", {
    name: /Развернуть чат: 1 непрочитанных/,
  });

  await unreadTab.waitFor({ timeout: 30_000 });
  const unreadGlowState = await unreadTab.evaluate((button) => {
    const sidebar = button.closest("aside");

    return {
      boxShadow: getComputedStyle(button).boxShadow,
      sidebarOverflow: sidebar ? getComputedStyle(sidebar).overflow : null,
    };
  });

  if (
    unreadGlowState.sidebarOverflow !== "visible" ||
    unreadGlowState.boxShadow === "none"
  ) {
    throw new Error(
      `Свечение непрочитанного чата обрезается: ${JSON.stringify(unreadGlowState)}`,
    );
  }
  await waitForSound(page, "Nin.Message.wav");
  await unreadTab.click();
  await page
    .getByRole("button", { name: "Свернуть чат" })
    .waitFor({ timeout: 30_000 });

  const privateProbe = `Личное сообщение ${Date.now()}`;

  await page.getByLabel("Выбрать получателей сообщения").click();
  await page
    .getByRole("region", { name: "Получатели сообщения" })
    .getByRole("button")
    .filter({ hasText: "Remote Observer" })
    .click();
  await page.getByLabel("Сообщение в чат").fill(privateProbe);
  await page
    .getByRole("button", { name: "Отправить сообщение" })
    .click();
  await observerPage
    .getByText(privateProbe, { exact: true })
    .waitFor({ timeout: 30_000 });
  const originalPrivateArticle = page
    .locator("article")
    .filter({ hasText: privateProbe })
    .first();
  const privateAppearance = await originalPrivateArticle.evaluate(
    (article) => {
      const sender = article.querySelector("header strong");

      return {
        hasLock: Boolean(sender?.querySelector("svg")),
        hasPrivateLabel: Array.from(article.querySelectorAll("span")).some(
          (element) =>
            element.textContent?.trim() === "Личное сообщение" ||
            element.textContent?.trim().startsWith("Лично:"),
        ),
        senderColor: sender ? getComputedStyle(sender).color : null,
      };
    },
  );

  if (
    !privateAppearance.hasLock ||
    privateAppearance.hasPrivateLabel ||
    privateAppearance.senderColor !== "rgb(216, 255, 99)"
  ) {
    throw new Error(
      `Приватное сообщение оформлено неверно: ${JSON.stringify(privateAppearance)}`,
    );
  }
  await bystanderPage.waitForTimeout(1_500);
  if (
    (await bystanderPage.getByText(privateProbe, { exact: true }).count()) !==
    0
  ) {
    throw new Error("Личное сообщение увидел невыбранный участник");
  }
  const privateReplyProbe = `Приватный ответ ${Date.now()}`;
  const observerPrivateArticle = observerPage
    .locator("article")
    .filter({ hasText: privateProbe })
    .first();

  await observerPrivateArticle.click();
  await observerPrivateArticle
    .getByRole("group", { name: "Действия с сообщением" })
    .getByRole("button", { name: "Ответить" })
    .click();
  await observerPage
    .getByLabel("Выбрать получателей сообщения")
    .getByText("Лично: Ninjitsi Smoke", { exact: true })
    .waitFor();
  await observerPage
    .getByLabel("Сообщение в чат")
    .fill(privateReplyProbe);
  await observerPage
    .getByRole("button", { name: "Отправить сообщение" })
    .click();
  const receivedPrivateReply = page
    .locator("article")
    .filter({ hasText: privateReplyProbe });

  await receivedPrivateReply.waitFor({ timeout: 30_000 });
  await observerPage
    .getByLabel("Выбрать получателей сообщения")
    .getByText("Всем", { exact: true })
    .waitFor();
  await bystanderPage.waitForTimeout(1_500);
  if (
    (await bystanderPage
      .getByText(privateReplyProbe, { exact: true })
      .count()) !== 0
  ) {
    throw new Error("Приватный reply увидел участник вне исходного круга");
  }
  const originalPrivateMessageId =
    await originalPrivateArticle.getAttribute("data-chat-message");

  await receivedPrivateReply
    .getByRole("button", { name: "Перейти к исходному сообщению" })
    .click();
  await page.waitForFunction(
    (messageId) =>
      Array.from(document.querySelectorAll("[data-chat-message]")).some(
        (element) =>
          element.getAttribute("data-chat-message") === messageId &&
          element.getAttribute("data-chat-highlighted") === "true",
      ),
    originalPrivateMessageId,
  );
  await page.getByLabel("Выбрать получателей сообщения").click();
  await page
    .getByRole("region", { name: "Получатели сообщения" })
    .getByRole("button", { name: /Всем участникам/ })
    .click();
  await bystanderPage.close();
  await waitForSound(page, "Nin.Disconnect.wav");

  await page.locator("[data-video-tile]").nth(1).waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelectorAll("[data-video-tile]").length === 2,
    undefined,
    { timeout: 30_000 },
  );
  await assertTwoParticipantRowDuring(page, "Свернуть чат");
  await page
    .getByRole("button", { name: "Развернуть чат" })
    .waitFor({ timeout: 30_000 });
  await assertTwoParticipantRowDuring(page, "Развернуть чат");
  await page
    .getByRole("button", { name: "Свернуть чат" })
    .waitFor({ timeout: 30_000 });

  const attachmentName = `drop-${Date.now()}.txt`;
  const dataTransfer = await page.evaluateHandle((name) => {
    const transfer = new DataTransfer();

    transfer.items.add(
      new File(["temporary attachment"], name, {
        type: "text/plain",
      }),
    );
    return transfer;
  }, attachmentName);
  const chatSidebar = page.getByRole("complementary");

  await chatSidebar.dispatchEvent("dragenter", {
    dataTransfer,
  });
  await page.getByText("Отпустите файлы", { exact: true }).waitFor();
  await chatSidebar.dispatchEvent("drop", {
    dataTransfer,
  });
  await observerPage
    .getByText(attachmentName, { exact: true })
    .waitFor({ timeout: 30_000 });

  const remoteAttachmentHref = await observerPage
    .getByTitle(`Скачать ${attachmentName}`)
    .getAttribute("href");

  if (!remoteAttachmentHref?.startsWith("data:text/plain;base64,")) {
    throw new Error("Вложение не дошло как временный data URL");
  }

  const transparentImageName = `transparent-${Date.now()}.png`;
  const transparentImageTransfer = await page.evaluateHandle((name) => {
    const canvas = document.createElement("canvas");
    const transfer = new DataTransfer();

    canvas.width = 2;
    canvas.height = 2;
    const dataUrl = canvas.toDataURL("image/png");
    const binary = atob(dataUrl.split(",")[1]);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );

    transfer.items.add(
      new File([bytes], name, {
        type: "image/png",
      }),
    );
    return transfer;
  }, transparentImageName);

  await chatSidebar.dispatchEvent("drop", {
    dataTransfer: transparentImageTransfer,
  });
  const remoteImageButton = observerPage.getByRole("button", {
    name: `Открыть изображение ${transparentImageName}`,
  });

  await remoteImageButton.waitFor({ timeout: 30_000 });
  if (
    (await observerPage
      .locator(`a[download="${transparentImageName}"]`)
      .count()) !== 0 ||
    (await remoteImageButton.evaluate(
      (element, imageName) =>
        element.textContent?.includes(String(imageName)) ?? false,
      transparentImageName,
    ))
  ) {
    throw new Error("Remote image is still a captioned download.");
  }

  await remoteImageButton.click();
  const remoteImageViewer = observerPage.getByRole("dialog", {
    name: "Просмотр изображения",
  });
  const remoteImageState = await remoteImageViewer.locator("img").evaluate(
    async (image) => {
      if (!(image instanceof HTMLImageElement)) {
        return null;
      }

      await image.decode();
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      canvas.width = 1;
      canvas.height = 1;
      context?.drawImage(image, 0, 0, 1, 1);
      return {
        alpha: context?.getImageData(0, 0, 1, 1).data[3],
        isPng: image.src.startsWith("data:image/png"),
      };
    },
  );

  if (!remoteImageState?.isPng || remoteImageState.alpha !== 0) {
    throw new Error(
      `Remote transparent PNG was altered: ${JSON.stringify(remoteImageState)}`,
    );
  }
  await observerPage
    .getByRole("button", { name: "Закрыть изображение" })
    .click();

  await page.getByRole("button", { name: "Свернуть чат" }).click();
  await page.getByRole("button", { name: "Развернуть чат" }).waitFor();
  await page.getByRole("button", { name: "Развернуть чат" }).click();
  await page.getByRole("button", { name: "Добавить вложение" }).waitFor();

  await page
    .getByRole("button", { name: "Показать на сцене Remote Observer" })
    .click();
  await page
    .getByRole("button", {
      name: "Вернуть сетку из сцены Remote Observer",
    })
    .waitFor();
  await page
    .getByRole("button", {
      name: "Вернуть сетку из сцены Remote Observer",
    })
    .click();

  await page.locator("[data-connection-summary]").hover();
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("[data-participant-ping]")).some(
        (element) => /^\d+ мс$/.test(element.textContent?.trim() ?? ""),
      ),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () =>
      Array.from(
        document.querySelectorAll('[aria-label^="Соединение "]'),
      ).some((element) =>
        /^Соединение \d+%$/.test(element.getAttribute("aria-label") ?? ""),
      ),
    undefined,
    { timeout: 30_000 },
  );

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

  if (stabilityMs > 0) {
    await page.waitForTimeout(stabilityMs);
    await page
      .getByRole("dialog", { name: "Вход в комнату" })
      .waitFor({ state: "hidden" });
    await observerPage
      .getByRole("dialog", { name: "Вход в комнату" })
      .waitFor({ state: "hidden" });
    await remoteTile.locator("video").waitFor();
    await page
      .locator("[data-video-tile]")
      .filter({ hasText: "Remote Observer" })
      .locator("video")
      .waitFor();
  }

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

    localStorage.setItem("ninjitsi.locale", "ru");
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
  await recoveryPage.addInitScript(
    ({ forceJvbForTesting, serverUrl }) => {
      window.__NINJITSI_CONFIG__ = {
        forceJvbForTesting,
        jitsiUrl: serverUrl,
      };
    },
    { forceJvbForTesting: forceJvb, serverUrl: jitsiUrl },
  );
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
          attachments: "ephemeral drag-and-drop passed",
          imagePreview: "clickable transparent PNG passed",
          chat: "bidirectional transport and reply quoting passed",
          chatUnread: "collapsed glow and message sound passed",
          privateChat: "selected recipients only passed",
          privateReply:
            "original recipient set, quote navigation and reset passed",
          messageOnlyTo:
            "clicked sender only and recipient reset passed",
          connectionStats: "conference RTT passed",
          deviceSettings: "enumeration passed",
          gridDuringChat: "two-participant row remained stable",
          microphone: "toggle passed",
          microphoneDefault: "explicit default device passed",
          microphoneLevel: "reactive outline passed",
          ownAudioPlayback: "not attached",
          participantVolume: "0–200% local gain passed",
          noiseSuppression: "toggle passed",
          participantSounds: "connect and disconnect passed",
          remotePropagation: "passed",
          recoveryAfterInitialDenial: "passed",
          screenShare: "start/stop passed",
          stability:
            stabilityMs > 0 ? `${stabilityMs} ms passed` : "not requested",
          stageMode: "enter/exit passed",
        },
        roomName,
        status: "joined",
        tileCount: await page.locator("[data-video-tile]").count(),
        transport: forceJvb ? "JVB forced" : "deployment default",
        transportRecoveryErrors: allowTransportRecoveryErrors
          ? "expected during chaos test"
          : "strict",
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
