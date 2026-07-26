import type { JitsiMeetJSLibrary } from "./types";

interface JitsiRuntime {
  config: Record<string, unknown>;
  library: JitsiMeetJSLibrary;
}

interface JitsiBaseRuntime {
  config: Record<string, unknown>;
  library: JitsiMeetJSLibrary;
  serverUrl: string;
}

let runtimePromise: Promise<JitsiBaseRuntime> | null = null;

function loadScript(id: string, source: string): Promise<void> {
  const existing = document.getElementById(id) as HTMLScriptElement | null;

  if (existing?.dataset.loaded === "true") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = existing ?? document.createElement("script");

    script.id = id;
    script.async = true;
    script.src = source;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () => reject(new Error(`Не удалось загрузить ${source}`));

    if (!existing) {
      document.head.appendChild(script);
    }
  });
}

function absoluteUrl(value: unknown, serverUrl: string): string | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }

  return new URL(value, `${serverUrl}/`).toString();
}

function appendRoom(url: string, roomName: string): string {
  const parsed = new URL(url);

  parsed.searchParams.set("room", roomName);
  return parsed.toString();
}

export function loadJitsiRuntime(
  rawServerUrl: string,
  roomName: string,
): Promise<JitsiRuntime> {
  const serverUrl = rawServerUrl.replace(/\/+$/, "");

  if (!runtimePromise) {
    runtimePromise = (async () => {
      await loadScript("ninjitsi-config", `${serverUrl}/config.js`);

      const deploymentConfig = window.config;

      if (!deploymentConfig?.hosts) {
        throw new Error("Jitsi config.js не содержит hosts");
      }

      await loadScript(
        "ninjitsi-lib-jitsi-meet",
        `${serverUrl}/libs/lib-jitsi-meet.min.js`,
      );

      const library = window.JitsiMeetJS;

      if (!library) {
        throw new Error("lib-jitsi-meet загрузился без JitsiMeetJS");
      }

      return { config: deploymentConfig, library, serverUrl };
    })();
  }

  return runtimePromise.then((runtime) => {
    if (runtime.serverUrl !== serverUrl) {
      throw new Error(
        "Нельзя переключить Jitsi-сервер без перезагрузки страницы",
      );
    }

    const bosh = absoluteUrl(runtime.config.bosh, serverUrl);
    const websocket = absoluteUrl(runtime.config.websocket, serverUrl);
    const serviceUrl = websocket ?? bosh;

    if (!serviceUrl) {
      throw new Error("В конфигурации Jitsi нет websocket или bosh");
    }

    const config = {
      ...runtime.config,
      bosh,
      ...(window.__NINJITSI_CONFIG__?.forceJvbForTesting
        ? {
            p2p: {
              ...(typeof runtime.config.p2p === "object" &&
              runtime.config.p2p
                ? runtime.config.p2p
                : {}),
              enabled: false,
            },
          }
        : {}),
      websocket,
      serviceUrl: appendRoom(serviceUrl, roomName),
    };

    return { config, library: runtime.library };
  });
}
