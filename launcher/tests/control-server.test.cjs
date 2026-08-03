const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("browser control server authenticates and owns turn visibility", async () => {
  const calls = [];
  const logs = [];
  const host = {
    beginTurn: (...args) => {
      calls.push(["start", ...args]);
      return { surfaceId: "launcher_surface_id_0123456789AB", tabId: "tab-1" };
    },
    endTurn: (...args) => calls.push(["end", ...args]),
  };
  const server = await new BrowserControlServer({
    logger: {
      info: (event, detail) => logs.push(["info", event, detail]),
      warn: (event, detail) => logs.push(["warn", event, detail]),
    },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: true }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const unauthenticated = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456" }),
    });
    assert.equal(unauthenticated.status, 401);

    const invalidOwner = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456", helperPid: 0 }),
    });
    assert.equal(invalidOwner.status, 400);

    const start = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456", helperPid: process.pid }),
    });
    assert.equal(start.status, 200);

    const ownerlessEnd = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "end", traceId: "abcdef123456", status: "failed" }),
    });
    assert.equal(ownerlessEnd.status, 400);

    const end = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "end",
        traceId: "abcdef123456",
        helperPid: process.pid,
        status: "completed",
      }),
    });
    assert.equal(end.status, 200);
    assert.deepEqual(calls, [
      ["start", "abcdef123456", true, process.pid],
      ["end", "abcdef123456", process.pid, "completed", true, undefined],
    ]);
    assert.equal(logs.some(([, event]) => event === "browser.turn_started"), true);
    assert.equal(logs.some(([, event]) => event === "browser.turn_ended"), true);
  } finally {
    await server.close();
  }
});

test("browser control server authenticates and validates tab management requests", async () => {
  const calls = [];
  const host = {
    describeTurnTabs: () => {
      calls.push(["list"]);
      return { maxTabs: 5, activeTabId: "tab-1", tabs: [] };
    },
    closeTurnTabByRef: (...args) => {
      calls.push(["close", ...args]);
      if (args[0] === "tab-running") {
        throw new Error("ChatGPT Web browser tab 2 is still running turn abcdef123456; pass --force to close it and abort that turn");
      }
      return { closed: { id: "tab-1", ordinal: 1, label: "Task 1", status: "ready", traceId: "abcdef123456", turnAborted: false } };
    },
    pruneTurnTabs: (...args) => {
      calls.push(["prune", ...args]);
      return { maxTabs: 5, closed: [], skipped: [] };
    },
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: true }),
  }).start();
  const descriptor = server.descriptor();
  const post = (route, body, headers = { authorization: `Bearer ${descriptor.token}` }) => fetch(
    `${descriptor.endpoint}${route}`,
    { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  try {
    const unauthenticated = await post("/v1/tabs/list", {}, {});
    assert.equal(unauthenticated.status, 401);

    const wrongMethod = await fetch(`${descriptor.endpoint}/v1/tabs/list`, {
      method: "GET",
      headers: { authorization: `Bearer ${descriptor.token}` },
    });
    assert.equal(wrongMethod.status, 404);

    const list = await post("/v1/tabs/list", {});
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { maxTabs: 5, activeTabId: "tab-1", tabs: [] });

    const invalidRef = await post("/v1/tabs/close", { ref: "tab one" });
    assert.equal(invalidRef.status, 400);
    assert.deepEqual(await invalidRef.json(), { error: "tab reference is invalid" });
    assert.equal((await post("/v1/tabs/close", { ref: 0 })).status, 400);
    assert.equal((await post("/v1/tabs/close", { ref: 1, force: "yes" })).status, 400);
    assert.equal((await post("/v1/tabs/prune", { force: 1 })).status, 400);

    const close = await post("/v1/tabs/close", { ref: 1, force: true });
    assert.equal(close.status, 200);
    assert.deepEqual((await close.json()).closed, {
      id: "tab-1",
      ordinal: 1,
      label: "Task 1",
      status: "ready",
      traceId: "abcdef123456",
      turnAborted: false,
    });

    const refused = await post("/v1/tabs/close", { ref: "tab-running" });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /still running turn abcdef123456; pass --force/);

    const prune = await post("/v1/tabs/prune", {});
    assert.equal(prune.status, 200);
    assert.deepEqual(await prune.json(), { maxTabs: 5, closed: [], skipped: [] });

    assert.deepEqual(calls, [
      ["list"],
      ["close", 1, true],
      ["close", "tab-running", false],
      ["prune", false],
    ]);
  } finally {
    await server.close();
  }
});
