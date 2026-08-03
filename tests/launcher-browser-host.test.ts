import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHER_TABS_TIMEOUT_MS,
  LAUNCHER_TURN_END_TIMEOUT_MS,
  LAUNCHER_TURN_START_TIMEOUT_MS,
  LAUNCHER_BROWSER_HOST_KIND,
  closeLauncherBrowserTab,
  inspectLauncherBrowserHost,
  listLauncherBrowserTabs,
  notifyLauncherTurn,
  pruneLauncherBrowserTabs,
  readLauncherBrowserHostDescriptor,
  selectLauncherPage,
} from "../src/launcher-browser-host";
import type { Browser, BrowserContext, Page } from "playwright-core";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptorFile(controlEndpoint = "http://127.0.0.1:39111"): string {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-descriptor-"));
  roots.push(root);
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    control: {
      endpoint: controlEndpoint,
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: {
      executable: process.execPath,
      script: import.meta.path,
    },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

test("launcher descriptor is owner-only, loopback-only, and process-bound", () => {
  const path = descriptorFile();
  expect(readLauncherBrowserHostDescriptor(path)).toMatchObject({
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    surfaceId: "launcher_surface_id_0123456789AB",
  });
  if (process.platform !== "win32") {
    chmodSync(path, 0o644);
    expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("unsafe permissions");
  }
});

test("launcher turn control sends authenticated lifecycle events", async () => {
  expect(LAUNCHER_TURN_START_TIMEOUT_MS).toBe(5_000);
  expect(LAUNCHER_TURN_END_TIMEOUT_MS).toBe(15_000);
  let received: { authorization?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/v1/turn/start"
      ? '{"ok":true,"surfaceId":"launcher_surface_id_0123456789AB"}\n'
      : '{"ok":true}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(notifyLauncherTurn(path, {
      phase: "start",
      traceId: "abc123def456",
      helperPid: process.pid,
    })).resolves.toEqual({ surfaceId: "launcher_surface_id_0123456789AB" });
    expect(received.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(received.body).toEqual({ phase: "start", traceId: "abc123def456", helperPid: process.pid });
    await notifyLauncherTurn(path, {
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
    });
    expect(received.body).toEqual({
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher session verification uses the authenticated control channel instead of Bun CDP", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(request.url).toBe("/v1/session/inspect");
    expect(request.headers.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ detectPro: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authenticated: true,
      temporary: true,
      proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    expect(await inspectLauncherBrowserHost(path, { detectPro: true })).toEqual({
      proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher tab control lists, closes, and prunes over the authenticated channel", async () => {
  expect(LAUNCHER_TABS_TIMEOUT_MS).toBe(5_000);
  const received: { url?: string; authorization?: string; body?: unknown }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/v1/tabs/list") {
      response.end(JSON.stringify({
        maxTabs: 5,
        activeTabId: "tab-2",
        tabs: [
          { id: "tab-1", ordinal: 1, label: "Task 1", status: "running", traceId: "trace_one", active: false },
          { id: "tab-2", ordinal: 2, label: "Task 2", status: "ready", traceId: null, active: true },
        ],
      }));
      return;
    }
    if (request.url === "/v1/tabs/close") {
      response.end(JSON.stringify({
        closed: { id: "tab-1", ordinal: 1, label: "Task 1", status: "running", traceId: "trace_one" },
      }));
      return;
    }
    response.end(JSON.stringify({
      maxTabs: 5,
      closed: [{ id: "tab-2", ordinal: 2, label: "Task 2", status: "ready", traceId: null }],
      skipped: [{ id: "tab-1", ordinal: 1, label: "Task 1", status: "running", traceId: "trace_one" }],
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);

    expect(await listLauncherBrowserTabs(path)).toEqual({
      maxTabs: 5,
      activeTabId: "tab-2",
      tabs: [
        { id: "tab-1", ordinal: 1, label: "Task 1", status: "running", traceId: "trace_one", active: false },
        { id: "tab-2", ordinal: 2, label: "Task 2", status: "ready", traceId: null, active: true },
      ],
    });
    expect(await closeLauncherBrowserTab(path, "1", true)).toEqual({
      closed: { id: "tab-1", ordinal: 1, label: "Task 1", status: "running", traceId: "trace_one" },
    });
    expect(await pruneLauncherBrowserTabs(path, false)).toEqual({
      maxTabs: 5,
      closed: [{ id: "tab-2", ordinal: 2, label: "Task 2", status: "ready", traceId: null }],
      skipped: [{ id: "tab-1", ordinal: 1, label: "Task 1", status: "running", traceId: "trace_one" }],
    });

    expect(received.map(entry => entry.url)).toEqual(["/v1/tabs/list", "/v1/tabs/close", "/v1/tabs/prune"]);
    for (const entry of received) {
      expect(entry.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    }
    expect(received.map(entry => entry.body)).toEqual([{}, { ref: "1", force: true }, { force: false }]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher tab control surfaces the launcher refusal to close a running turn", async () => {
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: "ChatGPT Web browser tab 2 is still running turn abc123def456; pass --force to close it and abort that turn",
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(closeLauncherBrowserTab(path, "2", false)).rejects.toThrow(
      "Launcher browser control channel failed: ChatGPT Web browser tab 2 is still running turn abc123def456; pass --force to close it and abort that turn",
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher tab control rejects malformed tab payloads", async () => {
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/v1/tabs/list"
      ? JSON.stringify({ maxTabs: 5, activeTabId: "tab-1", tabs: "tab-1" })
      : JSON.stringify({ closed: { id: "tab-1", ordinal: 1, label: "Task 1" } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(listLauncherBrowserTabs(path)).rejects.toThrow(
      "Launcher browser control channel failed: Launcher returned an invalid browser tab list",
    );
    await expect(closeLauncherBrowserTab(path, "1", false)).rejects.toThrow(
      "Launcher browser control channel failed: Launcher returned an invalid browser tab entry",
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher descriptor rejects non-loopback browser ownership", () => {
  const path = descriptorFile();
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.endpoint = "https://example.com:443";
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("http://127.0.0.1");
});

test("launcher page selection uses the owned surface marker instead of URL order", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const hiddenPage = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    evaluate: async () => "another_surface_id_0123456789ABC",
  } as unknown as Page;
  const ownedPage = {
    url: () => "about:blank#codex-web-gpt-browser-host",
    evaluate: async () => descriptor.surfaceId,
  } as unknown as Page;
  const context = {
    pages: () => [hiddenPage, ownedPage],
  } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
  } as unknown as Browser;

  expect(await selectLauncherPage(browser, descriptor, 20)).toEqual({
    context,
    page: ownedPage,
  });
});

test("launcher page selection rejects duplicated ownership markers", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const page = () => ({
    evaluate: async () => descriptor.surfaceId,
  }) as unknown as Page;
  const context = {
    pages: () => [page(), page()],
  } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
  } as unknown as Browser;

  expect(selectLauncherPage(browser, descriptor, 20)).rejects.toThrow(
    "2 surfaces with the same ownership id",
  );
});

test("launcher page selection stops immediately when acquisition is aborted", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const browser = {
    contexts: () => [],
  } as unknown as Browser;
  const controller = new AbortController();
  controller.abort();

  expect(selectLauncherPage(
    browser,
    descriptor,
    60_000,
    descriptor.surfaceId,
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
});
