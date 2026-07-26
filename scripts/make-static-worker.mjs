import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const sourceHtml = resolve(".next/server/app/index.html");
const assetsHtml = resolve(".open-next/assets/index.html");
const sourceIcon = resolve("app/icon.svg");
const assetsIcon = resolve(".open-next/assets/icon.svg");
const workerPath = resolve(".open-next/worker.js");

if (!existsSync(sourceHtml)) {
  throw new Error(`Static shell not found: ${sourceHtml}`);
}

mkdirSync(dirname(assetsHtml), { recursive: true });
copyFileSync(sourceHtml, assetsHtml);
copyFileSync(sourceIcon, assetsIcon);

writeFileSync(
  workerPath,
  `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const acceptsHtml = (request.headers.get("Accept") ?? "").includes(
      "text/html",
    );

    if (
      request.method === "GET" &&
      acceptsHtml &&
      !url.pathname.startsWith("/_next/")
    ) {
      const indexUrl = new URL("/index.html", request.url);
      return env.ASSETS.fetch(new Request(indexUrl, request));
    }

    const directResponse = await env.ASSETS.fetch(request);

    if (
      directResponse.status !== 404 ||
      request.method !== "GET" ||
      !acceptsHtml
    ) {
      return directResponse;
    }

    const indexUrl = new URL("/index.html", request.url);
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};
`,
  "utf8",
);

console.log("Static SPA worker prepared in .open-next.");
