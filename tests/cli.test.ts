import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { LAUNCHER_BROWSER_HOST_KIND } from "../src/launcher-browser-host";

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "../src/cli.ts"),
    ...args,
  ], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function launcherHome(root: string, controlEndpoint: string): string {
  const appHome = join(root, "app");
  const descriptorPath = join(appHome, "runtime", "launcher-browser.json");
  mkdirSync(join(appHome, "runtime"), { recursive: true });
  writeFileSync(descriptorPath, `${JSON.stringify({
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
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "launcher-browser-tabs-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
  })}\n`);
  return appHome;
}

async function startControlServer(
  respond: (url: string) => unknown,
  received: { url?: string; body?: unknown }[],
): Promise<{ endpoint: string; server: Server }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(respond(request.url ?? "")));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  return { endpoint: `http://127.0.0.1:${address.port}`, server };
}

test("setup validates the port before performing runtime work", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-"));
  try {
    const result = await runCli([
      "setup",
      "--browser-only",
      "--port",
      "0",
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    });
    const { stderr } = result;
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("--port must be an integer from 1 to 65535");
    expect(stderr).not.toContain("Unknown arguments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser tabs lists launcher task tabs in launcher order by number, id, and active state", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-tabs-"));
  const received: { url?: string; body?: unknown }[] = [];
  const { endpoint, server } = await startControlServer(() => ({
    maxTabs: 5,
    activeTabId: "tab-2",
    tabs: [
      { id: "tab-1", ordinal: 1, label: "Task 1", status: "running", traceId: "trace_one", active: false },
      { id: "tab-3", ordinal: 3, label: "Task 3", status: "error", traceId: null, active: false },
      { id: "tab-2", ordinal: 2, label: "Task 2", status: "ready", traceId: "trace_two", active: true },
    ],
  }), received);
  try {
    const appHome = launcherHome(root, endpoint);
    const result = await runCli(["browser", "tabs"], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(received).toEqual([{ url: "/v1/tabs/list", body: {} }]);

    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("ChatGPT Web browser tabs (3/5), in launcher tab order:");
    expect(lines[1]).toMatch(/^\s+#1\s+running\s+id=tab-1\s+trace=trace_one$/);
    expect(lines[2]).toMatch(/^\s+#3\s+error\s+id=tab-3\s+trace=-$/);
    expect(lines[3]).toMatch(/^\s+#2\s+ready\s+id=tab-2\s+trace=trace_two\s+\(active\)$/);
    expect(lines.filter(line => line.includes("(active)"))).toHaveLength(1);
    expect(lines.at(-1)).toBe(
      "Pass the # number or the id to: codex-chatgpt-web browser close <tab-number|tab-id>",
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser prune reports kept running tabs and how to force them closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-prune-"));
  const received: { url?: string; body?: unknown }[] = [];
  const { endpoint, server } = await startControlServer(() => ({
    maxTabs: 5,
    closed: [
      { id: "tab-1", ordinal: 1, label: "Task 1", status: "ready", traceId: "trace_one", turnAborted: false },
      { id: "tab-3", ordinal: 3, label: "Task 3", status: "error", traceId: "trace_three", turnAborted: false },
    ],
    skipped: [{ id: "tab-2", ordinal: 2, label: "Task 2", status: "running", traceId: "trace_two" }],
  }), received);
  try {
    const appHome = launcherHome(root, endpoint);
    const result = await runCli(["browser", "prune"], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(received).toEqual([{ url: "/v1/tabs/prune", body: { force: false } }]);

    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("Closed ChatGPT Web browser tabs:");
    expect(lines[1]).toMatch(/^\s+#1\s+ready\s+id=tab-1\s+trace=trace_one$/);
    expect(lines[2]).toMatch(/^\s+#3\s+error\s+id=tab-3\s+trace=trace_three$/);
    expect(lines[3]).toBe("Kept running ChatGPT Web browser tabs:");
    expect(lines[4]).toMatch(/^\s+#2\s+running\s+id=tab-2\s+trace=trace_two$/);
    expect(lines.at(-1)).toBe(
      "Pass --force to prune every tab including running ones; that aborts those turns.",
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser close reports a forced abort independently of tab status", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-close-abort-"));
  const received: { url?: string; body?: unknown }[] = [];
  const { endpoint, server } = await startControlServer(() => ({
    closed: {
      id: "tab-error",
      ordinal: 2,
      label: "Task 2",
      status: "error",
      traceId: "trace_error",
      turnAborted: true,
    },
  }), received);
  try {
    const appHome = launcherHome(root, endpoint);
    const result = await runCli(["browser", "close", "tab-error", "--force"], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(received).toEqual([{ url: "/v1/tabs/close", body: { ref: "tab-error", force: true } }]);
    expect(result.stdout).toBe(
      "Closed ChatGPT Web browser tab #2 (error).\nIts ChatGPT turn trace_error was aborted.\n",
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser force prune reports live error and aborted tabs as turn aborts", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-prune-aborts-"));
  const received: { url?: string; body?: unknown }[] = [];
  const { endpoint, server } = await startControlServer(() => ({
    maxTabs: 5,
    closed: [
      { id: "tab-error", ordinal: 1, label: "Task 1", status: "error", traceId: "trace_error", turnAborted: true },
      { id: "tab-aborted", ordinal: 2, label: "Task 2", status: "aborted", traceId: "trace_aborted", turnAborted: true },
    ],
    skipped: [],
  }), received);
  try {
    const appHome = launcherHome(root, endpoint);
    const result = await runCli(["browser", "prune", "--force"], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(received).toEqual([{ url: "/v1/tabs/prune", body: { force: true } }]);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("Closed ChatGPT Web browser tabs:");
    expect(lines[1]).toMatch(/^\s+#1\s+error\s+id=tab-error\s+trace=trace_error\s+\(turn aborted\)$/);
    expect(lines[2]).toMatch(/^\s+#2\s+aborted\s+id=tab-aborted\s+trace=trace_aborted\s+\(turn aborted\)$/);
    expect(lines).toHaveLength(3);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser rejects an unknown action with the supported command list", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-browser-usage-"));
  try {
    const result = await runCli(["browser", "kill"], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Browser command must be one of: browser check, browser tabs, browser close <tab-number|tab-id>, browser prune",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser tab management refuses a browser host the launcher does not own", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-browser-host-"));
  const appHome = join(root, "app");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "managed-chrome",
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "managed-chrome-control-token-0123456789abcdefghij",
    runtimeCommand: [process.execPath],
  })}\n`);
  try {
    const result = await runCli(["browser", "tabs"], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("browser tabs needs a launcher-managed browser host");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal uninstall refuses to race a launcher-owned runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-uninstall-"));
  const appHome = join(root, "app");
  const configPath = join(appHome, "config.json");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: join(appHome, "runtime", "launcher-browser.json"),
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "launcher-uninstall-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
  })}\n`);
  try {
    const result = await runCli([
      "uninstall",
      "--yes",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be removed from Codex Web GPT Settings");
    expect(existsSync(configPath)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
