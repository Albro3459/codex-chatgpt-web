function browserViewVisible(requestedVisible, surfaceActive, boundsReady = true) {
  return requestedVisible === true && surfaceActive === true && boundsReady === true;
}

function constrainBrowserBounds(bounds, contentSize) {
  const contentWidth = Math.max(1, Math.round(contentSize?.width || 0));
  const contentHeight = Math.max(1, Math.round(contentSize?.height || 0));
  const x = Math.min(contentWidth - 1, Math.max(0, Math.round(bounds.x)));
  const y = Math.min(contentHeight - 1, Math.max(0, Math.round(bounds.y)));
  return {
    x,
    y,
    width: Math.min(contentWidth - x, Math.max(1, Math.round(bounds.width))),
    height: Math.min(contentHeight - y, Math.max(1, Math.round(bounds.height))),
  };
}

function readBrowserNavigationState(contents, fallback) {
  if (!contents || contents.isDestroyed()) return { ...fallback };
  const history = contents.navigationHistory;
  return {
    ...fallback,
    url: contents.getURL() || fallback.url,
    title: contents.getTitle() || fallback.title || "ChatGPT",
    loading: contents.isLoading(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  };
}

function navigateBrowser(contents, action) {
  const history = contents.navigationHistory;
  if (action === "back") {
    if (history.canGoBack()) history.goBack();
  } else if (action === "forward") {
    if (history.canGoForward()) history.goForward();
  } else if (action === "reload") {
    contents.reload();
  } else {
    throw new Error(`Unknown browser navigation action: ${action}`);
  }
}

function evictableTurnTabId(turnTabs) {
  for (const [id, tab] of turnTabs) {
    if (tab.ended === true) return id;
  }
  return null;
}

function resolveTurnTabId(turnTabs, ref) {
  if (typeof ref !== "string" && typeof ref !== "number") return null;
  const text = String(ref);
  if (/^[1-9][0-9]*$/.test(text)) {
    const ordinal = Number(text);
    for (const [id, tab] of turnTabs) {
      if (tab.ordinal === ordinal) return id;
    }
    return null;
  }
  return turnTabs.has(text) ? text : null;
}

module.exports = {
  browserViewVisible,
  constrainBrowserBounds,
  evictableTurnTabId,
  navigateBrowser,
  readBrowserNavigationState,
  resolveTurnTabId,
};
