const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const {
  browserViewVisible,
  constrainBrowserBounds,
  evictableTurnTabId,
  navigateBrowser,
  readBrowserNavigationState,
  resolveTurnTabId,
} = require("../electron/browser-state.cjs");
const {
  allowedAuthUrl,
  BrowserHost,
  CHATGPT_VIEWPORT_CSS,
  isTemporaryChatUrl,
} = require("../electron/browser-host.cjs");

function createContents() {
  const calls = [];
  const history = {
    canGoBack: () => true,
    canGoForward: () => false,
    goBack: () => calls.push("back"),
    goForward: () => calls.push("forward"),
  };
  const webContents = {
    navigationHistory: history,
    getURL: () => "https://chatgpt.com/?temporary-chat=true",
    getTitle: () => "ChatGPT",
    isDestroyed: () => false,
    isLoading: () => false,
    focus: () => calls.push("focus"),
    reload: () => calls.push("reload"),
  };
  return { calls, webContents };
}

test("browser surface visibility requires both requested and active state", () => {
  assert.equal(browserViewVisible(false, false, false), false);
  assert.equal(browserViewVisible(true, false, true), false);
  assert.equal(browserViewVisible(false, true, true), false);
  assert.equal(browserViewVisible(true, true, false), false);
  assert.equal(browserViewVisible(true, true, true), true);
});

test("smoke preserves an already-hydrated Temporary Chat page", () => {
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/?temporary-chat=true"), true);
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/?temporary-chat=false"), false);
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/c/abc?temporary-chat=true"), false);
  assert.equal(isTemporaryChatUrl("not a url"), false);
});

test("session inspection navigates an authenticated ordinary chat surface to Temporary Chat", async () => {
  let currentUrl = "https://chatgpt.com/";
  const navigations = [];
  const fixture = {
    view: {
      webContents: {
        getURL: () => currentUrl,
        loadURL: async (url) => {
          navigations.push(url);
          currentUrl = url;
        },
      },
    },
    probeAuthentication: async () => ({ authenticated: true }),
  };

  const inspected = await BrowserHost.prototype.runSessionInspection.call(fixture, false);

  assert.deepEqual(navigations, ["https://chatgpt.com/?temporary-chat=true"]);
  assert.deepEqual(inspected, {
    authenticated: true,
    temporary: true,
    url: "https://chatgpt.com/?temporary-chat=true",
  });
});

test("browser surface reactivation preserves its last measured bounds", () => {
  const visibility = [];
  const fixture = {
    surfaceActive: true,
    boundsReady: true,
    syncViewVisibility() {
      visibility.push({ active: this.surfaceActive, boundsReady: this.boundsReady });
    },
    setState() {},
    snapshot() {
      return { surfaceActive: this.surfaceActive, boundsReady: this.boundsReady };
    },
  };

  BrowserHost.prototype.setSurfaceActive.call(fixture, false);
  BrowserHost.prototype.setSurfaceActive.call(fixture, true);

  assert.deepEqual(visibility, [
    { active: false, boundsReady: true },
    { active: true, boundsReady: true },
  ]);
  assert.equal(fixture.boundsReady, true);
});

test("manual browser operations wait for the first measured surface", async () => {
  let readinessReads = 0;
  const fixture = {
    surfaceActive: true,
    get boundsReady() {
      readinessReads += 1;
      return readinessReads >= 3;
    },
  };

  await BrowserHost.prototype.waitForSurfaceReady.call(fixture, 100, 1);

  assert.equal(readinessReads, 3);
});

test("manual browser operations fail closed without measured surface bounds", async () => {
  await assert.rejects(
    BrowserHost.prototype.waitForSurfaceReady.call(
      { surfaceActive: true, boundsReady: false },
      2,
      1,
    ),
    /did not receive measured bounds/,
  );
});

test("browser bounds are clipped to the launcher content area", () => {
  assert.deepEqual(
    constrainBrowserBounds({ x: 260, y: 78, width: 1000, height: 900 }, { width: 1200, height: 800 }),
    { x: 260, y: 78, width: 940, height: 722 },
  );
  assert.deepEqual(
    constrainBrowserBounds({ x: -20, y: -10, width: 0, height: 0 }, { width: 1200, height: 800 }),
    { x: 0, y: 0, width: 1, height: 1 },
  );
});

test("authentication windows stay in the owned browser surface", () => {
  assert.equal(allowedAuthUrl("https://accounts.google.com/o/oauth2/v2/auth"), true);
  assert.equal(allowedAuthUrl("https://chatgpt.com/auth/login"), true);
  assert.equal(allowedAuthUrl("https://example.com/login"), false);
  const source = require("node:fs").readFileSync(require.resolve("../electron/browser-host.cjs"), "utf8");
  assert.match(source, /createWindow:\s*\(options\)\s*=>\s*this\.createAuthView\(options\)/);
  assert.doesNotMatch(source, /overrideBrowserWindowOptions/);
});

test("concurrent login requests share one authentication operation", async () => {
  let resolveLogin;
  let waits = 0;
  const fixture = {
    state: { authenticated: false },
    loginOperation: null,
    show() {},
    snapshot() { return { authenticated: false }; },
    logger: { info() {} },
    view: { webContents: { getURL: () => "https://chatgpt.com/", loadURL: async () => {} } },
    probeAuthentication: async () => {},
    waitForAuthenticated: async () => {
      waits += 1;
      return await new Promise((resolve) => { resolveLogin = resolve; });
    },
    activateHomeSurface() {},
    withManualOperation: async (_name, action) => await action(),
  };
  const first = BrowserHost.prototype.openLogin.call(fixture);
  const second = BrowserHost.prototype.openLogin.call(fixture);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(waits, 1);
  resolveLogin({ authenticated: true });
  assert.deepEqual(await first, { authenticated: true });
});

test("OAuth completion is confirmed on the primary Temporary Chat surface before login succeeds", async () => {
  let primaryReady = false;
  const stateUpdates = [];
  const completedAuthView = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async () => ({ composer: true, readyState: "complete" }),
    },
  };
  const fixture = {
    activeTraceId: null,
    manualOperation: "ChatGPT login",
    authView: completedAuthView,
    state: { authenticated: false },
    logger: { info() {} },
    view: {
      webContents: {
        getURL: () => primaryReady
          ? "https://chatgpt.com/?temporary-chat=true"
          : "https://chatgpt.com/auth/login",
        isDestroyed: () => false,
        executeJavaScript: async () => ({
          composer: primaryReady,
          readyState: "complete",
        }),
        loadURL: async (url) => {
          assert.equal(url, "https://chatgpt.com/?temporary-chat=true");
          primaryReady = true;
        },
      },
    },
    closeAuthView(view, closeContents, refreshMain) {
      assert.equal(view, completedAuthView);
      assert.equal(closeContents, true);
      assert.equal(refreshMain, false);
      this.authView = null;
    },
    setState(patch) {
      this.state = { ...this.state, ...patch };
      stateUpdates.push(patch);
    },
    snapshot() {
      return this.state;
    },
  };

  const result = await BrowserHost.prototype.probeAuthentication.call(fixture);

  assert.equal(result.authenticated, true);
  assert.equal(fixture.authView, null);
  assert.equal(stateUpdates.at(-1).url, "https://chatgpt.com/?temporary-chat=true");
});

test("browser chrome navigation delegates to WebContents navigation history", () => {
  const { calls, webContents } = createContents();
  navigateBrowser(webContents, "back");
  navigateBrowser(webContents, "forward");
  navigateBrowser(webContents, "reload");

  assert.deepEqual(calls, ["back", "reload"]);
  assert.throws(() => navigateBrowser(webContents, "unknown"), /Unknown browser navigation action/);
});

test("browser chrome state is read from the owned WebContents", () => {
  const { webContents } = createContents();
  const state = readBrowserNavigationState(webContents, {
    title: "Fallback",
    url: "about:blank",
    loading: true,
    canGoBack: false,
    canGoForward: true,
  });
  assert.deepEqual(state, {
    title: "ChatGPT",
    url: "https://chatgpt.com/?temporary-chat=true",
    loading: false,
    canGoBack: true,
    canGoForward: false,
  });
});

test("embedded ChatGPT is constrained to the owned horizontal viewport", () => {
  assert.match(CHATGPT_VIEWPORT_CSS, /max-width:\s*100% !important/);
  assert.match(CHATGPT_VIEWPORT_CSS, /overflow-x:\s*hidden !important/);
  assert.match(CHATGPT_VIEWPORT_CSS, /overscroll-behavior-x:\s*none !important/);
});

test("smoke effort selection uses trusted input and semantic checked state", async () => {
  const source = require("node:fs").readFileSync(require.resolve("../electron/browser-host.cjs"), "utf8");
  const cdpSource = require("node:fs").readFileSync(require.resolve("../electron/cdp-input.cjs"), "utf8");
  assert.match(source, /aria-controls/);
  assert.match(source, /\[role="menu"\]:has\(\[role="menuitemradio"\]\)/);
  assert.match(source, /\[role="group"\]:has\(\[role="menuitemradio"\]\)/);
  assert.match(source, /\[role="menuitemradio"\]/);
  assert.match(cdpSource, /Input\.dispatchKeyEvent/);
  assert.match(cdpSource, /debuggerClient/);
  assert.doesNotMatch(source, /:popover-open/);
  assert.doesNotMatch(source, /data-radix-collection-item/);

  let controlReads = 0;
  let menuReads = 0;
  const trustedKeys = [];
  const inputEvents = [];
  const fixture = {
    pressBrowserKey: BrowserHost.prototype.pressBrowserKey,
    pressTrustedBrowserKey: BrowserHost.prototype.pressTrustedBrowserKey,
    readEffortControl: BrowserHost.prototype.readEffortControl,
    focusEffortControl: BrowserHost.prototype.focusEffortControl,
    readEffortMenu: BrowserHost.prototype.readEffortMenu,
    focusEffortMenuItem: BrowserHost.prototype.focusEffortMenuItem,
    waitForEffortControl: BrowserHost.prototype.waitForEffortControl,
    waitForEffortMenu: BrowserHost.prototype.waitForEffortMenu,
    openEffortMenu: BrowserHost.prototype.openEffortMenu,
    chooseEffortMenuItem: BrowserHost.prototype.chooseEffortMenuItem,
    dispatchTrustedKey: async (input) => trustedKeys.push(input),
    evaluatePage: async ({ expression }) => {
      if (expression.includes("effort-control-read")) {
        controlReads += 1;
        if (controlReads === 1) {
          return {
            found: false,
            composer: true,
            readyState: "complete",
            url: "https://chatgpt.com/?temporary-chat=true",
          };
        }
        return {
          found: true,
          label: "Instant",
          point: { x: 120, y: 80 },
          composer: true,
          readyState: "complete",
          url: "https://chatgpt.com/?temporary-chat=true",
        };
      }
      if (expression.includes("effort-control-focus")) return true;
      if (expression.includes("effort-menu-read")) {
        menuReads += 1;
        if ([1, 3].includes(menuReads)) {
          return { open: false, count: 0, target: null };
        }
        return {
          open: true,
          count: 5,
          target: {
            label: "Instant 5.5",
            checked: menuReads >= 4 ? "true" : "false",
            point: { x: 160, y: 140 },
          },
        };
      }
      if (expression.includes("effort-menu-focus")) return true;
      throw new Error("Unexpected browser script");
    },
    evaluateBrowserPage: BrowserHost.prototype.evaluateBrowserPage,
    view: {
      webContents: {
        debugger: {},
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        sendInputEvent: (event) => inputEvents.push(event),
      },
    },
  };

  const result = await BrowserHost.prototype.selectHighEffort.call(fixture, {
    readyTimeoutMs: 100,
    optionTimeoutMs: 100,
    confirmTimeoutMs: 100,
    pollMs: 1,
  });

  assert.deepEqual(result, { effort: "High", changed: true });
  assert.equal(controlReads, 3);
  assert.equal(menuReads, 4);
  assert.deepEqual(trustedKeys, [
    { debuggerClient: {}, key: "Enter" },
    { debuggerClient: {}, key: "Enter" },
    { debuggerClient: {}, key: "Enter" },
  ]);
  assert.deepEqual(inputEvents, [
    { type: "keyDown", keyCode: "Escape" },
    { type: "keyUp", keyCode: "Escape" },
  ]);
});

test("effort selection waits for an already-open menu to hydrate instead of closing it", async () => {
  let activations = 0;
  let menuReads = 0;
  const inputEvents = [];
  const fixture = {
    pressBrowserKey: BrowserHost.prototype.pressBrowserKey,
    waitForEffortControl: async () => ({ found: true, expanded: "true" }),
    readEffortMenu: async () => {
      menuReads += 1;
      return menuReads === 1
        ? { open: false, count: 0, target: null }
        : {
            open: true,
            count: 5,
            target: { label: "Высокий", checked: "true" },
          };
    },
    waitForEffortMenu: BrowserHost.prototype.waitForEffortMenu,
    openEffortMenu: async () => {
      activations += 1;
      throw new Error("must not toggle an already-open menu");
    },
    view: {
      webContents: {
        sendInputEvent: event => inputEvents.push(event),
      },
    },
  };

  const result = await BrowserHost.prototype.selectHighEffort.call(fixture, {
    readyTimeoutMs: 100,
    optionTimeoutMs: 100,
    confirmTimeoutMs: 100,
    pollMs: 1,
  });

  assert.deepEqual(result, { effort: "High", changed: false });
  assert.equal(activations, 0);
  assert.equal(menuReads, 2);
  assert.deepEqual(inputEvents, [
    { type: "keyDown", keyCode: "Escape" },
    { type: "keyUp", keyCode: "Escape" },
  ]);
});

test("smoke submission focuses the send button before trusted Enter and waits for an accepted user turn", async () => {
  const keys = [];
  let sendReads = 0;
  let submissionReads = 0;
  const fixture = {
    readSmokeSendButton: BrowserHost.prototype.readSmokeSendButton,
    readSmokeSubmissionState: BrowserHost.prototype.readSmokeSubmissionState,
    evaluateBrowserPage: BrowserHost.prototype.evaluateBrowserPage,
    evaluatePage: async ({ expression }) => {
      if (expression.includes("smoke-send-button-read")) {
        sendReads += 1;
        return sendReads < 3
          ? { ready: false, reason: "disabled" }
          : { ready: true, point: { x: 300, y: 220 } };
      }
      if (expression.includes("smoke-send-button-focus")) return true;
      assert.match(expression, /smoke-submission-read/);
      submissionReads += 1;
      return {
        accepted: submissionReads >= 2,
        userTurnCount: submissionReads >= 2 ? 1 : 0,
        stopVisible: false,
      };
    },
    view: { webContents: { debugger: {} } },
  };

  await BrowserHost.prototype.waitForSmokeSendButton.call(fixture, 100, 1);
  assert.equal(await BrowserHost.prototype.focusSmokeSendButton.call(fixture), true);
  await BrowserHost.prototype.pressTrustedBrowserKey.call({
    view: fixture.view,
    dispatchTrustedKey: async input => keys.push(input),
  }, "Enter");
  const submitted = await BrowserHost.prototype.waitForSmokeSubmissionAccepted.call(
    fixture,
    0,
    100,
    1,
  );

  assert.equal(sendReads, 3);
  assert.equal(submissionReads, 2);
  assert.deepEqual(keys, [{
    debuggerClient: {},
    key: "Enter",
  }]);
  assert.deepEqual(submitted, {
    accepted: true,
    userTurnCount: 1,
    stopVisible: false,
  });
});

test("smoke observes current ChatGPT turn metadata without assuming an HTML section", () => {
  const source = require("node:fs").readFileSync(require.resolve("../electron/browser-host.cjs"), "utf8");
  assert.match(source, /\[data-testid\^="conversation-turn-"\]\[data-turn="assistant"\]/);
  assert.match(source, /\[data-testid\^="conversation-turn-"\]\[data-message-author-role="assistant"\]/);
  assert.match(source, /\[data-testid\^="conversation-turn-"\]\[data-turn="user"\]/);
  assert.doesNotMatch(source, /section\[data-testid\^="conversation-turn-"/);
});

test("smoke submission fails quickly when ChatGPT never creates a user turn", async () => {
  const fixture = {
    readSmokeSubmissionState: async () => ({
      accepted: false,
      userTurnCount: 0,
      stopVisible: false,
    }),
  };
  await assert.rejects(
    BrowserHost.prototype.waitForSmokeSubmissionAccepted.call(fixture, 0, 2, 1),
    /did not accept .*userTurnsBefore=0; userTurnsNow=0/,
  );
});

test("launcher clears the ChatGPT composer through trusted editing input", async () => {
  const inputEvents = [];
  const waited = [];
  const fixture = {
    pressBrowserKey: BrowserHost.prototype.pressBrowserKey,
    pressBrowserShortcut: BrowserHost.prototype.pressBrowserShortcut,
    waitForComposerText: async expected => { waited.push(expected); },
    view: {
      webContents: {
        focus() {},
        sendInputEvent: event => inputEvents.push(event),
      },
    },
  };

  await BrowserHost.prototype.clearFocusedComposer.call(fixture);

  const modifier = process.platform === "darwin" ? "meta" : "control";
  assert.deepEqual(inputEvents, [
    { type: "keyDown", keyCode: "A", modifiers: [modifier] },
    { type: "keyUp", keyCode: "A", modifiers: [modifier] },
    { type: "keyDown", keyCode: "Backspace" },
    { type: "keyUp", keyCode: "Backspace" },
  ]);
  assert.deepEqual(waited, [""]);
});

test("smoke effort selection is idempotent without comparing localized labels", async () => {
  const inputEvents = [];
  const fixture = {
    pressBrowserKey: BrowserHost.prototype.pressBrowserKey,
    readEffortMenu: async () => ({
      open: true,
      count: 5,
      target: { label: "Instant 5.5", checked: "true", point: { x: 140, y: 130 } },
    }),
    waitForEffortControl: async () => ({
      found: true,
      label: "高",
      point: { x: 90, y: 70 },
    }),
    waitForEffortMenu: async () => ({
      open: true,
      count: 5,
      target: { label: "Instant 5.5", checked: "true", point: { x: 140, y: 130 } },
    }),
    view: {
      webContents: {
        sendInputEvent: (event) => inputEvents.push(event),
      },
    },
  };

  const result = await BrowserHost.prototype.selectHighEffort.call(fixture);

  assert.deepEqual(result, { effort: "High", changed: false });
  assert.deepEqual(inputEvents, [
    { type: "keyDown", keyCode: "Escape" },
    { type: "keyUp", keyCode: "Escape" },
  ]);
});

test("smoke effort selection fails closed with rendering diagnostics", async () => {
  const fixture = {
    pressBrowserKey: BrowserHost.prototype.pressBrowserKey,
    readEffortControl: BrowserHost.prototype.readEffortControl,
    readEffortMenu: BrowserHost.prototype.readEffortMenu,
    waitForEffortControl: BrowserHost.prototype.waitForEffortControl,
    waitForEffortMenu: BrowserHost.prototype.waitForEffortMenu,
    evaluateBrowserPage: BrowserHost.prototype.evaluateBrowserPage,
    evaluatePage: async () => ({
      found: false,
      composer: true,
      readyState: "complete",
      url: "https://chatgpt.com/?temporary-chat=true",
    }),
    view: {
      webContents: {
        debugger: {},
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        sendInputEvent() {},
      },
    },
  };

  await assert.rejects(
    BrowserHost.prototype.selectHighEffort.call(fixture, {
      readyTimeoutMs: 2,
      optionTimeoutMs: 2,
      confirmTimeoutMs: 2,
      pollMs: 1,
    }),
    /effort control did not become ready .*composer=ready/,
  );
});

test("connector verification is effort-independent and works while the browser surface is hidden", async () => {
  const calls = [];
  const fixture = {
    helper: { executable: "/runtime/electron", script: "/runtime/browser-helper.cjs" },
    descriptorPath: "/runtime/launcher-browser.json",
    logger: { info: (event, detail) => calls.push(["log", event, detail]) },
    setState: (patch) => calls.push(["state", patch]),
    show: () => calls.push(["show"]),
    waitForAuthenticated: async () => calls.push(["authenticated"]),
    selectHighEffort: async () => {
      throw new Error("connector verification must not select an effort");
    },
    verifyConnectorWithBrowserHelper: async (options) => {
      calls.push(["helper", options]);
      return { ok: true, appName: options.appName };
    },
    view: {
      webContents: {
        getURL: () => "about:blank",
        loadURL: async (url) => calls.push(["load", url]),
      },
    },
  };

  const result = await BrowserHost.prototype.runConnectorVerification.call(fixture, "Codex Native");

  assert.deepEqual(result, { ok: true, appName: "Codex Native" });
  assert.equal(calls.some(([type]) => type === "show"), false);
  assert.deepEqual(
    calls.filter(([type]) => ["load", "helper"].includes(type)),
    [
      ["load", "https://chatgpt.com/?temporary-chat=true"],
      ["helper", {
        helper: fixture.helper,
        descriptorPath: fixture.descriptorPath,
        appName: "Codex Native",
        logger: fixture.logger,
      }],
    ],
  );
});

test("connector verification has no independent CDP typing or coordinate-click path", () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/browser-host.cjs"), "utf8");
  assert.match(source, /verifyConnectorWithBrowserHelper/);
  assert.doesNotMatch(source, /typeTrustedBrowserText|clickTrustedBrowserPoint|connectorMenuOpen|waitForConnectorSuggestion/);
});

test("connector verification preserves an already hydrated Temporary Chat page", async () => {
  let loaded = false;
  const fixture = {
    logger: { info() {} },
    setState() {},
    waitForAuthenticated: async () => {},
    helper: { executable: "/runtime/electron", script: "/runtime/browser-helper.cjs" },
    descriptorPath: "/runtime/launcher-browser.json",
    verifyConnectorWithBrowserHelper: async ({ appName }) => ({ ok: true, appName }),
    view: {
      webContents: {
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        loadURL: async () => { loaded = true; },
      },
    },
  };

  await BrowserHost.prototype.runConnectorVerification.call(fixture, "Codex Native");

  assert.equal(loaded, false);
});

test("launcher session refresh resolves persisted authentication before setup actions", async () => {
  const calls = [];
  const fixture = {
    state: { authenticated: false },
    snapshot: () => ({ authenticated: true }),
    setState: (patch) => calls.push(["state", patch]),
    probeAuthentication: async () => {
      calls.push(["probe"]);
      return { authenticated: true };
    },
    withManualOperation: async (name, action) => {
      calls.push(["operation", name]);
      return await action();
    },
    view: {
      webContents: {
        getURL: () => "about:blank#codex-web-gpt-browser-host",
        loadURL: async (url) => calls.push(["load", url]),
      },
    },
  };

  const state = await BrowserHost.prototype.refreshAuthentication.call(fixture);

  assert.deepEqual(state, { authenticated: true });
  assert.deepEqual(calls, [
    ["operation", "session refresh"],
    ["state", { status: "loading", message: "Checking saved ChatGPT session" }],
    ["load", "https://chatgpt.com/?temporary-chat=true"],
    ["probe"],
  ]);
});

test("manual browser operations disable background throttling until completion", async () => {
  const throttling = [];
  const surfaces = [];
  const fixture = {
    activeTraceId: null,
    manualOperation: null,
    activateHomeSurface: () => surfaces.push("home"),
    setState() {},
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: (enabled) => throttling.push(enabled),
      },
    },
  };

  const result = await BrowserHost.prototype.withManualOperation.call(fixture, "hidden check", async () => "ok");

  assert.equal(result, "ok");
  assert.deepEqual(surfaces, ["home"]);
  assert.deepEqual(throttling, [false, true]);
  assert.equal(fixture.manualOperation, null);
});

test("manual operations show the home surface without discarding retained task tabs", () => {
  const events = [];
  const taskTab = { id: "tab-ready", status: "ready" };
  const fixture = {
    selectedTabId: taskTab.id,
    turnTabs: new Map([[taskTab.id, taskTab]]),
    visible: true,
    surfaceActive: true,
    activeView: () => ({ webContents: { focus: () => events.push("focus") } }),
    syncViewVisibility: () => events.push("visibility"),
    snapshot: () => ({ activeTabId: "home" }),
    publishState: () => events.push("publish"),
    writeDescriptor: () => events.push("descriptor"),
  };

  BrowserHost.prototype.activateHomeSurface.call(fixture);

  assert.equal(fixture.selectedTabId, "home");
  assert.equal(fixture.turnTabs.size, 1);
  assert.deepEqual(events, ["visibility", "focus", "publish", "descriptor"]);
});

test("selected home surface remains represented while task tabs are retained", () => {
  const { webContents } = createContents();
  const taskTab = { id: "tab-ready", traceId: "trace_ready" };
  const fixture = {
    selectedTabId: "home",
    turnTabs: new Map([[taskTab.id, taskTab]]),
    state: {
      title: "ChatGPT",
      status: "signed-out",
      loading: false,
      visible: true,
      surfaceActive: true,
    },
    visible: true,
    surfaceActive: true,
    activeView: () => ({ webContents }),
    selectedTurnTab: () => null,
    tabSnapshot: (tab) => ({ id: tab.id, traceId: tab.traceId, active: false }),
  };

  const snapshot = BrowserHost.prototype.snapshot.call(fixture);

  assert.equal(snapshot.activeTabId, "home");
  assert.deepEqual(snapshot.tabs.map((tab) => tab.id), ["home", "tab-ready"]);
  assert.equal(snapshot.tabs[0].active, true);
});

test("a stale helper cannot end a replacement turn with the same trace id", async () => {
  const turnTabs = new Map([["tab-1", {
    id: "tab-1",
    traceId: "trace_same_retry",
    helperPid: 222,
  }]]);
  await assert.rejects(
    BrowserHost.prototype.endTurn.call(
      { turnTabs, closedTurnOwners: new Map() },
      "trace_same_retry",
      111,
      "failed",
      false,
      "stale helper exited",
    ),
    /Browser helper ownership mismatch: expected 222, received 111/,
  );
});

test("closing a running browser tab preserves ownership until its helper reports termination", () => {
  const closed = [];
  const tab = {
    id: "tab-running",
    traceId: "trace_running",
    helperPid: 333,
    status: "running",
    view: {
      webContents: { isDestroyed: () => false, close: () => closed.push("contents") },
    },
  };
  const fixture = {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView: () => closed.push("view") } },
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    logger: { info() {} },
  };

  BrowserHost.prototype.closeTab.call(fixture, tab.id);

  assert.deepEqual(closed, ["view", "contents"]);
  assert.equal(fixture.closedTurnOwners.get("trace_running"), 333);
  assert.equal(fixture.selectedTabId, "home");
});

test("closing an unended errored browser tab preserves ownership until its helper ends", async () => {
  const tab = {
    id: "tab-error",
    traceId: "trace_error_before_end",
    helperPid: 444,
    status: "error",
    ended: false,
    view: {
      webContents: { isDestroyed: () => false, close() {} },
    },
  };
  const fixture = {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView() {} } },
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    logger: { info() {} },
  };

  BrowserHost.prototype.closeTab.call(fixture, tab.id);

  assert.equal(tab.status, "aborted");
  assert.equal(fixture.closedTurnOwners.get(tab.traceId), tab.helperPid);
  await BrowserHost.prototype.endTurn.call(
    fixture,
    tab.traceId,
    tab.helperPid,
    "failed",
    false,
    "helper failed after tab closed",
  );
  assert.equal(fixture.closedTurnOwners.has(tab.traceId), false);
});

test("closing an ended errored browser tab does not claim a live turn owner", () => {
  const tab = {
    id: "tab-ended-error",
    traceId: "trace_ended_error",
    helperPid: 555,
    status: "error",
    ended: true,
    view: {
      webContents: { isDestroyed: () => false, close() {} },
    },
  };
  const fixture = {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView() {} } },
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    logger: { info() {} },
  };

  BrowserHost.prototype.closeTab.call(fixture, tab.id);

  assert.equal(tab.status, "error");
  assert.equal(fixture.closedTurnOwners.has(tab.traceId), false);
});

test("a later provider round reuses its task tab and restores active ownership", () => {
  const throttling = [];
  const tab = {
    id: "tab-reused",
    surfaceId: "surface-reused",
    traceId: "trace_reused",
    helperPid: 111,
    status: "ready",
    loading: false,
    message: "Task completed",
    ended: true,
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: (enabled) => throttling.push(enabled),
      },
    },
  };
  const events = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[tab.id, tab]]),
    selectedTabId: "home",
    syncViewVisibility: () => events.push("visible"),
    snapshot: () => ({ tabs: [] }),
    publishState: () => events.push("published"),
    writeDescriptor: () => events.push("descriptor"),
    logger: { info: (event) => events.push(event) },
  });

  const lease = BrowserHost.prototype.beginTurn.call(fixture, "trace_reused", false, 222);

  assert.deepEqual(lease, { surfaceId: "surface-reused", tabId: "tab-reused" });
  assert.equal(tab.helperPid, 222);
  assert.equal(tab.status, "running");
  assert.equal(tab.loading, true);
  assert.equal(tab.message, "ChatGPT is working");
  assert.equal(tab.ended, false);
  assert.equal(fixture.selectedTabId, tab.id);
  assert.deepEqual(throttling, [false]);
  assert.deepEqual(events, ["visible", "published", "descriptor", "browser.tab_reused"]);
});

test("an unended error tab remains active ownership and blocks manual operations", async () => {
  const tab = {
    id: "tab-error-live",
    traceId: "trace_error_live",
    status: "error",
    ended: false,
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    manualOperation: null,
    activateHomeSurface() { assert.fail("manual operation must not activate home"); },
  });

  assert.equal(fixture.activeTraceId, tab.traceId);
  await assert.rejects(
    BrowserHost.prototype.withManualOperation.call(fixture, "session inspection", async () => {}),
    /ChatGPT browser is running Codex turn trace_error_live/,
  );
  assert.equal(fixture.manualOperation, null);
});

test("a different helper cannot reuse an unended error tab", () => {
  const tab = {
    id: "tab-error-live",
    surfaceId: "surface-error-live",
    traceId: "trace_error_live",
    helperPid: 111,
    status: "error",
    ended: false,
    view: { webContents: { isDestroyed: () => false } },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    manualOperation: null,
  });

  assert.throws(
    () => BrowserHost.prototype.beginTurn.call(fixture, tab.traceId, false, 222),
    /ChatGPT browser turn trace_error_live is owned by another helper process/,
  );
  assert.equal(tab.helperPid, 111);
  assert.equal(tab.status, "error");
  assert.equal(tab.ended, false);
});

test("unended error tabs are not evictable", () => {
  const turnTabs = new Map([
    ["tab-error", { status: "error", ended: false }],
    ["tab-aborted", { status: "aborted" }],
  ]);

  assert.equal(evictableTurnTabId(turnTabs), null);
});

test("five unended browser tabs reject a sixth regardless of status", () => {
  const statuses = ["error", "aborted", "ready", "error", "aborted"];
  const turnTabs = new Map(statuses.map((status, index) => [
    `tab-${index + 1}`,
    { ordinal: index + 1, status, ended: false },
  ]));
  const before = [...turnTabs.entries()];

  assert.throws(
    () => BrowserHost.prototype.createTurnTab.call({ turnTabs }, "trace_six", 444),
    /already has 5 browser tabs running a turn\. Close one or wait for one to finish.*avoid excessive parallel traffic/,
  );
  assert.deepEqual([...turnTabs.entries()], before);
});

test("view allocation failure preserves the existing ended tab set", () => {
  const statuses = ["running", "ready", "running", "error", "running"];
  const turnTabs = new Map(statuses.map((status, index) => [
    `tab-${index + 1}`,
    { ordinal: index + 1, status, ended: status !== "running" },
  ]));
  const closed = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs,
    closeTab: (tabId) => {
      closed.push(tabId);
      turnTabs.delete(tabId);
    },
  });
  const before = [...turnTabs.entries()];

  // WebContentsView is unavailable outside Electron, so allocation fails before eviction.
  assert.throws(
    () => BrowserHost.prototype.createTurnTab.call(fixture, "trace_six", 444),
    TypeError,
  );
  assert.deepEqual(closed, []);
  assert.deepEqual([...turnTabs.entries()], before);
});

function loadBrowserHostWithViewConstructor(ViewConstructor) {
  const browserHostPath = require.resolve("../electron/browser-host.cjs");
  const previousModule = require.cache[browserHostPath];
  const originalLoad = Module._load;
  delete require.cache[browserHostPath];
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") {
      return { WebContentsView: ViewConstructor, shell: { openExternal() {} } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(browserHostPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[browserHostPath];
    if (previousModule) require.cache[browserHostPath] = previousModule;
  }
}

function createFakeBrowserView() {
  const webContents = {
    setWindowOpenHandler() {},
    on() {},
    isDestroyed: () => false,
    close() {},
    setBackgroundThrottling() {},
    loadURL: () => Promise.resolve(),
  };
  return {
    webContents,
    setBounds() {},
    setVisible() {},
  };
}

test("successful creation evicts the oldest ended tab and reuses its ordinal", () => {
  const allocated = [];
  class FakeWebContentsView {
    constructor() {
      const view = createFakeBrowserView();
      allocated.push(view);
      return view;
    }
  }
  const { BrowserHost: FakeBrowserHost } = loadBrowserHostWithViewConstructor(FakeWebContentsView);
  const removed = [];
  const evictedView = createFakeBrowserView();
  const turnTabs = new Map(["running", "error", "aborted", "ready", "running"].map((status, index) => {
    const tab = {
      id: `tab-${index + 1}`,
      ordinal: index + 1,
      status,
      ended: status === "error" || status === "ready",
      view: index === 1 ? evictedView : createFakeBrowserView(),
    };
    return [tab.id, tab];
  }));
  const fixture = Object.assign(Object.create(FakeBrowserHost.prototype), {
    turnTabs,
    selectedTabId: "home",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    window: {
      contentView: {
        addChildView() {},
        removeChildView: (view) => removed.push(view),
      },
    },
    closedTurnOwners: new Map(),
    syncViewVisibility() {},
    snapshot() { return { tabs: [] }; },
    publishState() {},
    writeDescriptor() {},
    logger: { info() {} },
  });

  const created = FakeBrowserHost.prototype.createTurnTab.call(fixture, "trace_six", 444);

  assert.equal(allocated.length, 1);
  assert.equal(created.ordinal, 2);
  assert.equal(created.label, "ChatGPT 2");
  assert.deepEqual(removed, [evictedView]);
  assert.equal(turnTabs.has("tab-2"), false);
  assert.equal([...turnTabs.values()].at(-1), created);
});

test("synchronous replacement setup failure preserves the ended eviction candidate", () => {
  const closedContents = [];
  const replacement = createFakeBrowserView();
  replacement.setBounds = () => { throw new Error("replacement bounds failed"); };
  replacement.webContents.close = () => closedContents.push("replacement");
  class FakeWebContentsView {
    constructor() {
      return replacement;
    }
  }
  const { BrowserHost: FakeBrowserHost } = loadBrowserHostWithViewConstructor(FakeWebContentsView);
  const candidate = {
    id: "tab-2",
    ordinal: 2,
    status: "error",
    ended: true,
    view: createFakeBrowserView(),
  };
  const turnTabs = new Map([
    ["tab-1", { id: "tab-1", ordinal: 1, status: "running", ended: false, view: createFakeBrowserView() }],
    [candidate.id, candidate],
    ["tab-3", { id: "tab-3", ordinal: 3, status: "running", ended: false, view: createFakeBrowserView() }],
    ["tab-4", { id: "tab-4", ordinal: 4, status: "running", ended: false, view: createFakeBrowserView() }],
    ["tab-5", { id: "tab-5", ordinal: 5, status: "running", ended: false, view: createFakeBrowserView() }],
  ]);
  const closed = [];
  const fixture = Object.assign(Object.create(FakeBrowserHost.prototype), {
    turnTabs,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    window: { contentView: { addChildView() {}, removeChildView() {} } },
    closedTurnOwners: new Map(),
    closeTab: (tabId) => {
      closed.push(tabId);
      turnTabs.delete(tabId);
    },
  });

  assert.throws(
    () => FakeBrowserHost.prototype.createTurnTab.call(fixture, "trace_six", 444),
    /replacement bounds failed/,
  );
  assert.deepEqual(closed, []);
  assert.equal(turnTabs.get(candidate.id), candidate);
  assert.deepEqual(closedContents, ["replacement"]);
});

test("the oldest ended browser tab is the evictable one", () => {
  const tabs = (entries) => new Map(entries.map(([status, ended], index) => [
    `tab-${index + 1}`,
    { status, ended },
  ]));

  assert.equal(evictableTurnTabId(new Map()), null);
  assert.equal(evictableTurnTabId(tabs([["running", false], ["running", false], ["running", false]])), null);
  assert.equal(
    evictableTurnTabId(tabs([["running", false], ["ready", true], ["error", true], ["running", false]])),
    "tab-2",
  );
  assert.equal(
    evictableTurnTabId(tabs([["ready", true], ["aborted", true], ["error", true]])),
    "tab-1",
  );
});

function createTurnTabHost(tabs, selectedTabId) {
  const turnTabs = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const closed = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs,
    selectedTabId: selectedTabId ?? "home",
    closeTab: (tabId) => {
      const tab = turnTabs.get(tabId);
      if (!tab) throw new Error("Browser tab does not exist");
      closed.push(tabId);
      turnTabs.delete(tabId);
      // closeTab rewrites a running tab before returning; reported entries must predate that.
      if (tab.status === "running") tab.status = "aborted";
    },
  });
  return { closed, fixture, turnTabs };
}

test("browser tab references resolve by 1-based ordinal or exact tab id", () => {
  const turnTabs = new Map([
    ["tab-alpha", { ordinal: 1 }],
    ["tab-beta", { ordinal: 3 }],
  ]);

  assert.equal(resolveTurnTabId(turnTabs, 3), "tab-beta");
  assert.equal(resolveTurnTabId(turnTabs, "3"), "tab-beta");
  assert.equal(resolveTurnTabId(turnTabs, "tab-alpha"), "tab-alpha");
  assert.equal(resolveTurnTabId(turnTabs, 2), null);
  assert.equal(resolveTurnTabId(turnTabs, "0"), null);
  assert.equal(resolveTurnTabId(turnTabs, "01"), null);
  assert.equal(resolveTurnTabId(turnTabs, "tab-missing"), null);
  assert.equal(resolveTurnTabId(turnTabs, null), null);
  assert.equal(resolveTurnTabId(turnTabs, { ordinal: 1 }), null);
});

test("browser tab listing reports every tab in creation order with its ordinal and active flag", () => {
  const { fixture } = createTurnTabHost([
    { id: "tab-1", ordinal: 1, label: "Task 1", status: "running", traceId: "trace_one" },
    { id: "tab-2", ordinal: 2, label: "Task 2", status: "ready", traceId: "trace_two" },
  ], "tab-2");

  const described = BrowserHost.prototype.describeTurnTabs.call(fixture);

  assert.equal(described.maxTabs, 5);
  assert.equal(described.activeTabId, "tab-2");
  assert.deepEqual(described.tabs, [
    { id: "tab-1", ordinal: 1, label: "Task 1", status: "running", traceId: "trace_one", active: false },
    { id: "tab-2", ordinal: 2, label: "Task 2", status: "ready", traceId: "trace_two", active: true },
  ]);
});

test("closing a browser tab by reference reports the status it had before the close", () => {
  const tabs = [
    { id: "tab-1", ordinal: 1, label: "Task 1", status: "running", ended: false, traceId: "trace_one" },
    { id: "tab-2", ordinal: 2, label: "Task 2", status: "ready", ended: true, traceId: "trace_two" },
  ];

  const finished = createTurnTabHost(tabs);
  assert.deepEqual(
    BrowserHost.prototype.closeTurnTabByRef.call(finished.fixture, "2", false),
    { closed: { id: "tab-2", ordinal: 2, label: "Task 2", status: "ready", traceId: "trace_two", turnAborted: false } },
  );
  assert.deepEqual(finished.closed, ["tab-2"]);

  const forced = createTurnTabHost(tabs);
  assert.deepEqual(
    BrowserHost.prototype.closeTurnTabByRef.call(forced.fixture, "tab-1", true),
    { closed: { id: "tab-1", ordinal: 1, label: "Task 1", status: "running", traceId: "trace_one", turnAborted: true } },
  );
  assert.deepEqual(forced.closed, ["tab-1"]);
});

test("closing a browser tab fails closed on an unknown reference or an unforced running turn", () => {
  const { closed, fixture } = createTurnTabHost([
    { id: "tab-1", ordinal: 1, label: "Task 1", status: "running", ended: false, traceId: "trace_one" },
  ]);

  assert.throws(
    () => BrowserHost.prototype.closeTurnTabByRef.call(fixture, "9", false),
    /No ChatGPT Web browser tab matches '9'.*browser tabs/,
  );
  assert.throws(
    () => BrowserHost.prototype.closeTurnTabByRef.call(fixture, 1, false),
    /tab 1 is still running turn trace_one; pass --force/,
  );
  assert.deepEqual(closed, []);
});

test("unforced close preserves unended error and aborted tabs while force closes them", () => {
  const tabs = [
    { id: "tab-error", ordinal: 1, label: "Error", status: "error", ended: false, traceId: "trace_error" },
    { id: "tab-aborted", ordinal: 2, label: "Aborted", status: "aborted", ended: false, traceId: "trace_aborted" },
  ];
  const kept = createTurnTabHost(tabs);

  assert.throws(
    () => BrowserHost.prototype.closeTurnTabByRef.call(kept.fixture, "tab-error", false),
    /tab 1 is still running turn trace_error; pass --force/,
  );
  assert.throws(
    () => BrowserHost.prototype.closeTurnTabByRef.call(kept.fixture, "tab-aborted", false),
    /tab 2 is still running turn trace_aborted; pass --force/,
  );
  assert.deepEqual(kept.closed, []);
  assert.deepEqual([...kept.turnTabs.keys()], ["tab-error", "tab-aborted"]);

  const forced = createTurnTabHost(tabs);
  assert.deepEqual(
    BrowserHost.prototype.closeTurnTabByRef.call(forced.fixture, "tab-error", true),
    { closed: { id: "tab-error", ordinal: 1, label: "Error", status: "error", traceId: "trace_error", turnAborted: true } },
  );
  assert.deepEqual(
    BrowserHost.prototype.closeTurnTabByRef.call(forced.fixture, "tab-aborted", true),
    { closed: { id: "tab-aborted", ordinal: 2, label: "Aborted", status: "aborted", traceId: "trace_aborted", turnAborted: true } },
  );
  assert.deepEqual(forced.closed, ["tab-error", "tab-aborted"]);
  assert.equal(forced.turnTabs.size, 0);
});

test("pruning browser tabs keeps unended turns unless they are forced", () => {
  const tabs = [
    { id: "tab-1", ordinal: 1, label: "Task 1", status: "ready", ended: true, traceId: "trace_one" },
    { id: "tab-2", ordinal: 2, label: "Task 2", status: "running", ended: false, traceId: "trace_two" },
    { id: "tab-3", ordinal: 3, label: "Task 3", status: "error", ended: false, traceId: "trace_three" },
    { id: "tab-4", ordinal: 4, label: "Task 4", status: "aborted", ended: false, traceId: "trace_four" },
    { id: "tab-5", ordinal: 5, label: "Task 5", status: "error", ended: true, traceId: "trace_five" },
  ];

  const kept = createTurnTabHost(tabs);
  const pruned = BrowserHost.prototype.pruneTurnTabs.call(kept.fixture, false);
  assert.equal(pruned.maxTabs, 5);
  assert.deepEqual(pruned.closed, [
    { id: "tab-1", ordinal: 1, label: "Task 1", status: "ready", traceId: "trace_one", turnAborted: false },
    { id: "tab-5", ordinal: 5, label: "Task 5", status: "error", traceId: "trace_five", turnAborted: false },
  ]);
  assert.deepEqual(pruned.skipped, [
    { id: "tab-2", ordinal: 2, label: "Task 2", status: "running", traceId: "trace_two" },
    { id: "tab-3", ordinal: 3, label: "Task 3", status: "error", traceId: "trace_three" },
    { id: "tab-4", ordinal: 4, label: "Task 4", status: "aborted", traceId: "trace_four" },
  ]);
  assert.deepEqual(kept.closed, ["tab-1", "tab-5"]);
  assert.deepEqual([...kept.turnTabs.keys()], ["tab-2", "tab-3", "tab-4"]);

  const forced = createTurnTabHost(tabs);
  const all = BrowserHost.prototype.pruneTurnTabs.call(forced.fixture, true);
  assert.deepEqual(all.skipped, []);
  assert.deepEqual(all.closed.map((tab) => [tab.ordinal, tab.status, tab.turnAborted]), [
    [1, "ready", false],
    [2, "running", true],
    [3, "error", true],
    [4, "aborted", true],
    [5, "error", false],
  ]);
  assert.deepEqual(forced.closed, ["tab-1", "tab-2", "tab-3", "tab-4", "tab-5"]);
  assert.equal(forced.turnTabs.size, 0);
});

test("ending one browser turn does not stop another running tab", async () => {
  const ended = {
    id: "tab-ended",
    traceId: "trace_ended",
    helperPid: 555,
    status: "running",
    loading: true,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } },
  };
  const active = {
    id: "tab-active",
    traceId: "trace_active",
    helperPid: 666,
    status: "running",
    loading: true,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[ended.id, ended], [active.id, active]]),
    closedTurnOwners: new Map(),
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    hide: () => assert.fail("a second running tab must keep the browser host active"),
    logger: { info() {} },
  });

  await BrowserHost.prototype.endTurn.call(
    fixture,
    ended.traceId,
    ended.helperPid,
    "completed",
    true,
  );

  assert.equal(ended.status, "ready");
  assert.equal(ended.ended, true);
  assert.equal(active.status, "running");
  assert.equal(fixture.activeTraceId, active.traceId);
});
