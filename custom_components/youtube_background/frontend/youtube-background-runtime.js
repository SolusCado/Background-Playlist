// Refactored from background.js
(function () {
  // Singleton guard — prevent re-execution on SPA navigation re-loads
  if (window.__ytbgRuntimeLoaded) return;
  window.__ytbgRuntimeLoaded = true;

  const LOG_PREFIX = "YouTube Background";
  const RUNTIME_LOG_VERSION = "2026.04.13";
  window.IDEAS = window.IDEAS || {};
  window.IDEAS.yt = window.IDEAS.yt || {
    currentPlaylistId: null,
    player: null,
    pendingShufflePlaylistId: null
  };

  function toBoolean(value, defaultValue) {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off", ""].includes(normalized)) return false;
    }
    return Boolean(value);
  }

  function getBehavior(config = currentConfig) {
    return {
      mute: toBoolean(config?.mute, true),
      autoplay: toBoolean(config?.autoplay, true),
      randomize: toBoolean(config?.randomize, true),
      transition: config?.transition === "none" ? "none" : "fade",
      debug: toBoolean(config?.debug, false),
    };
  }

  function getHass() {
    const ha = document.querySelector("home-assistant");
    if (ha?.hass) {
      return ha.hass;
    }

    const main = ha?.shadowRoot?.querySelector("home-assistant-main");
    if (main?.hass) {
      return main.hass;
    }

    return null;
  }

  function log(...args) {
    if (!getBehavior().debug) return;
    console.log(`%c[${LOG_PREFIX}]`, "color: #c4302b; font-weight: bold;", ...args);
  }

  function applyMuteSetting(player, config = currentConfig) {
    if (!player?.mute || !player?.unMute) return;
    const behavior = getBehavior(config);

    if (isStrictAutoplayBrowser() && behavior.autoplay && !safariGestureUnlocked) {
      player.mute();
      return;
    }

    if (behavior.mute) {
      player.mute();
    } else {
      player.unMute();
    }
  }

  function applyTransitionSetting(config = currentConfig) {
    const playerEl = document.getElementById("background-player");
    if (!playerEl) return;
    playerEl.classList.toggle("no-transition", getBehavior(config).transition === "none");
  }

  function normalizeHexColor(value) {
    const raw = String(value || "#000000").trim();
    const valid = /^#([0-9a-fA-F]{6})$/;
    return valid.test(raw) ? raw.toLowerCase() : "#000000";
  }

  function hexToRgb(hexColor) {
    const hex = normalizeHexColor(hexColor).slice(1);
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  function normalizeOpacity(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0.5;
    if (numeric <= 1) return Math.max(0, Math.min(1, numeric));
    return Math.max(0, Math.min(1, numeric / 100));
  }

  function buildCornerGradients(config = currentConfig) {
    const corners = Array.isArray(config?.fade_corners) ? config.fade_corners : [];
    if (!corners.length) {
      return "none";
    }

    const rgb = hexToRgb(config?.fade_color);
    const alpha = normalizeOpacity(config?.fade_opacity);
    const solid = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
    const clear = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`;
    const selected = new Set(corners);
    const gradients = [];

    const hasLeft = selected.has("top_left") || selected.has("bottom_left");
    const hasRight = selected.has("top_right") || selected.has("bottom_right");
    const hasTop = selected.has("top_left") || selected.has("top_right");
    const hasBottom = selected.has("bottom_left") || selected.has("bottom_right");

    if (hasRight) {
      gradients.push(`linear-gradient(to left, ${solid} 0%, ${clear} 50%)`);
    }
    if (hasBottom) {
      gradients.push(`linear-gradient(to top, ${solid} 0%, ${clear} 50%)`);
    }
    if (hasLeft) {
      gradients.push(`linear-gradient(to right, ${solid} 0%, ${clear} 50%)`);
    }
    if (hasTop) {
      gradients.push(`linear-gradient(to bottom, ${solid} 0%, ${clear} 50%)`);
    }

    return gradients.join(", ") || "none";
  }

  function applyOverlaySetting(config = currentConfig) {
    const playerEl = document.getElementById("background-player");
    if (!playerEl) return;
    const gradient = isSafariBrowser() ? "none" : buildCornerGradients(config);
    playerEl.style.setProperty("--yt-overlay-gradient", gradient);
    log(`Applied overlay gradient: ${gradient.substring(0, 50)}...`);
  }

  let lastViewId = null;
  let lastTemplateName = null;
  let currentConfig = null;
  let lastResolvedState = null;
  let currentConfigSignature = "null";
  let gestureHandlersInstalled = false;
  let lastActivationAt = 0;
  let safariGestureUnlocked = false;
  let pendingGesturePlayback = false;
  let safariPlaylistRetryCount = 0;
  let safariSingleVideoFallbackAttemptedPlaylistId = null;
  let safariDeferredPlaylistId = null;
  let safariDeferredFallbackVideoId = null;
  let safariPlaylistLoaded = false;
  let haPlayEventSubscriptionReady = false;
  let haPauseEventSubscriptionReady = false;

  function isSafariBrowser() {
    const ua = navigator.userAgent || "";
    const isSafari = /Safari/i.test(ua);
    const isChromiumFamily = /Chrome|Chromium|CriOS|Edg|OPR|SamsungBrowser|Firefox|FxiOS/i.test(ua);
    return isSafari && !isChromiumFamily;
  }

  function isTizenBrowser() {
    const ua = navigator.userAgent || "";
    return /Tizen|SMART-TV|SmartTV|Maple/i.test(ua);
  }

  function isStrictAutoplayBrowser() {
    return isSafariBrowser() || isTizenBrowser();
  }

  function ensureInlineIframeAttributes() {
    const iframe = document.querySelector("#background-player iframe");
    if (!iframe) return;

    iframe.setAttribute("playsinline", "1");
    iframe.setAttribute("webkit-playsinline", "true");
    iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  }

  function getPlaylistStartIndex(playlistId, behavior = getBehavior(), config = currentConfig) {
    if (!behavior.randomize) {
      return 0;
    }

    const normalizedPlaylistId = String(playlistId || "").trim();
    const normalizedDefaultPlaylistId = String(config?.default_playlist_id || "").trim();
    const shouldUseKnownCount = Boolean(
      normalizedPlaylistId &&
      normalizedDefaultPlaylistId &&
      normalizedPlaylistId === normalizedDefaultPlaylistId
    );

    const parsedItemCount = Number(config?.default_playlist_item_count);
    const maxItems = shouldUseKnownCount && Number.isFinite(parsedItemCount) && parsedItemCount > 0
      ? Math.floor(parsedItemCount)
      : 50;

    return Math.floor(Math.random() * maxItems);
  }

  function loadPlaylistForPlayer(player, playlistId, behavior = getBehavior(), options = {}) {
    if (!player || typeof player.loadPlaylist !== "function" || typeof player.cuePlaylist !== "function") {
      return;
    }

    const useCue = Boolean(options.forceCue) || !behavior.autoplay;
    const loader = useCue ? "cuePlaylist" : "loadPlaylist";
    const index = Number.isInteger(options.index) ? options.index : getPlaylistStartIndex(playlistId, behavior);

    player[loader]({
      list: playlistId,
      listType: "playlist",
      index,
      suggestedQuality: "highres"
    });
  }

  function deferSafariPlaylistUntilGesture(playlistId) {
    if (!isStrictAutoplayBrowser()) return;
    safariDeferredPlaylistId = playlistId || null;
    safariPlaylistLoaded = false;
    pendingGesturePlayback = false;
    console.info("[YouTube Background] Strict autoplay defer playlist load until gesture", {
      playlistId: safariDeferredPlaylistId,
    });
  }

  function loadSafariDeferredPlaylist(player, source = "gesture") {
    if (!isStrictAutoplayBrowser() || !player) return false;

    // Handle deferred single-video fallback first (set when 153 fires before gesture)
    if (safariDeferredFallbackVideoId) {
      const videoId = safariDeferredFallbackVideoId;
      safariDeferredFallbackVideoId = null;
      safariPlaylistLoaded = true;
      pendingGesturePlayback = false;
      const behavior = getBehavior();
      console.info("[YouTube Background] Strict autoplay playing deferred fallback video from gesture", {
        source,
        videoId,
      });
      playSingleVideoFallback(player, videoId, behavior);
      return true;
    }

    const playlistId = safariDeferredPlaylistId || window.IDEAS?.yt?.currentPlaylistId;
    if (!playlistId) return false;

    const behavior = getBehavior();
    const index = getPlaylistStartIndex(playlistId, behavior);

    try {
      loadPlaylistForPlayer(player, playlistId, behavior, {
        index,
        forceCue: false,
      });
      applyMuteSetting(player, behavior);
      if (behavior.autoplay && typeof player.playVideo === "function") {
        player.playVideo();
      }

      safariDeferredPlaylistId = null;
      safariPlaylistLoaded = true;
      pendingGesturePlayback = false;
      console.info("[YouTube Background] Strict autoplay playlist loaded from gesture", {
        source,
        playlistId,
        index,
      });
      return true;
    } catch (error) {
      console.warn("[YouTube Background] Strict autoplay deferred load failed", {
        source,
        playlistId,
        error,
      });
      return false;
    }
  }

  async function resolveFallbackVideoId(playlistId) {
    const hass = getHass();
    if (!hass || typeof hass.callWS !== "function" || !playlistId) {
      return null;
    }

    try {
      const response = await hass.callWS({
        type: "youtube_background/get_playlist_fallback_video",
        playlist_id: playlistId,
      });
      const videoId = String(response?.video_id || "").trim();
      return videoId || null;
    } catch (error) {
      log("Fallback video lookup failed", error);
      return null;
    }
  }

  function playSingleVideoFallback(player, videoId, behavior) {
    if (!player || !videoId) return false;

    try {
      const fallbackPayload = { videoId, suggestedQuality: "highres" };
      if (behavior.autoplay && typeof player.loadVideoById === "function") {
        player.loadVideoById(fallbackPayload);
      } else if (typeof player.cueVideoById === "function") {
        player.cueVideoById(fallbackPayload);
      } else {
        return false;
      }

      applyMuteSetting(player, behavior);
      if (behavior.autoplay && typeof player.playVideo === "function") {
        player.playVideo();
      }

      return true;
    } catch (error) {
      log("Single-video fallback playback failed", error);
      return false;
    }
  }

  function getPlayerVarsForInit(behavior, strictAutoplay, origin, widgetReferrer) {
    const base = {
      controls: 0,
      modestbranding: 1,
      rel: 0,
      fs: 1,
      playsinline: 1,
      enablejsapi: 1,
      origin,
      widget_referrer: widgetReferrer,
    };

    if (strictAutoplay) {
      return {
        ...base,
        autoplay: 0,
        mute: 1,
      };
    }

    return {
      ...base,
      autoplay: behavior.autoplay ? 1 : 0,
      mute: behavior.mute ? 1 : 0,
    };
  }

  function stableSerialize(value) {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
    }

    if (value && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
        .join(",")}}`;
    }

    return JSON.stringify(value);
  }

  function getConfigSignature(config) {
    if (!config) {
      return "null";
    }

    return stableSerialize({
      entity_id: config.entity_id ?? null,
      default_playlist_id: config.default_playlist_id ?? null,
      default_playlist_item_count: config.default_playlist_item_count ?? null,
      state_map: config.state_map ?? {},
      mute: config.mute ?? null,
      autoplay: config.autoplay ?? null,
      randomize: config.randomize ?? null,
      transition: config.transition ?? null,
      debug: config.debug ?? null,
      fade_color: config.fade_color ?? null,
      fade_opacity: config.fade_opacity ?? null,
      fade_corners: Array.isArray(config.fade_corners) ? [...config.fade_corners].sort() : [],
    });
  }

  function installLifecycleDiagnostics() {
    if (window.__ytbgLifecycleDiagnosticsInstalled) {
      return;
    }
    window.__ytbgLifecycleDiagnosticsInstalled = true;

    const logLifecycle = (eventName, extra = {}) => {
      console.warn("[YouTube Background] Page lifecycle", {
        event: eventName,
        href: window.location.href,
        visibilityState: document.visibilityState,
        playlistId: window.IDEAS?.yt?.currentPlaylistId,
        pendingGesturePlayback,
        safari: isSafariBrowser(),
        ...extra,
      });
    };

    window.addEventListener("beforeunload", () => logLifecycle("beforeunload"), true);
    window.addEventListener("pagehide", (event) => logLifecycle("pagehide", { persisted: event.persisted }), true);
    document.addEventListener("visibilitychange", () => logLifecycle("visibilitychange"), true);
    document.addEventListener("freeze", () => logLifecycle("freeze"), true);
  }

  function getLovelaceRoot() {
    const ha = document.querySelector("home-assistant");
    const candidates = [
      ha?.shadowRoot,
      ha?.shadowRoot?.querySelector("home-assistant-main")?.shadowRoot,
      ha?.shadowRoot?.querySelector("home-assistant-main")?.shadowRoot?.querySelector("ha-drawer")?.shadowRoot,
      ha?.shadowRoot?.querySelector("home-assistant-main")?.shadowRoot?.querySelector("partial-panel-resolver")?.shadowRoot,
    ].filter(Boolean);

    for (const root of candidates) {
      const lovelacePanel = root.querySelector("ha-panel-lovelace");
      const huiRoot = lovelacePanel?.shadowRoot?.querySelector("hui-root");
      if (huiRoot) {
        return huiRoot;
      }
    }

    return null;
  }

  function getCurrentViewIdFromUrl() {
    const segments = window.location.pathname.split("/").filter(Boolean);
    const [, view = "0"] = segments;
    return view;
  }

  // HA non-dashboard routes — everything else is treated as a potential dashboard
  const NON_DASHBOARD_ROUTES = new Set([
    "lovelace-unused", // never a real route but kept for safety
    "config",
    "developer-tools",
    "profile",
    "history",
    "logbook",
    "energy",
    "map",
    "shopping-list",
    "todo",
    "media-browser",
    "hassio",
    "ingress",
    "youtube_background", // our own panel
  ]);

  function isDashboardRoute(pathname = window.location.pathname) {
    const [firstSegment = ""] = pathname.split("/").filter(Boolean);
    if (!firstSegment) return false;
    return !NON_DASHBOARD_ROUTES.has(firstSegment);
  }

  function normalizeDashboardPath(path = "") {
    // Strip leading/trailing slashes only — preserve the dashboard- prefix
    // so it matches what HA stores and what lovelace/config expects.
    const normalized = String(path || "").trim().replace(/^\/+|\/+$/g, "");
    return normalized || "lovelace";
  }

  function getCurrentViewConfig(viewId) {
    const root = getLovelaceRoot();
    const views = root?.lovelace?.config?.views ?? [];

    if (/^\d+$/.test(viewId)) {
      return views[parseInt(viewId, 10)];
    }

    return views.find(v => v.path === viewId);
  }

  async function getConfigForCurrentView() {
    if (!isDashboardRoute()) {
      return null;
    }

    const locationParts = window.location.pathname.split("/").filter(Boolean);
    const dashboardPath = normalizeDashboardPath(locationParts[0] || "lovelace");
    const viewPath = locationParts[1] || "";

    // Call websocket to get config
    const hass = getHass();
    if (!hass) return null;

    try {
      const response = await hass.callWS({
        type: "youtube_background/get_config",
        dashboard_path: dashboardPath,
        view_path: viewPath
      });
      return response.config;
    } catch (e) {
      log("Failed to get config", e);
      return null;
    }
  }

  function handleConfigChange(config) {
    if (!config) {
      hidePlayer();
      return;
    }

    const root = getLovelaceRoot();
    const hass = getHass();
    const result = resolvePlaylistId(config, hass);

    if (!result?.playlistId) {
      log("No valid playlist resolved.");
      window.IDEAS.yt.isActive = false;
      hidePlayer();
      return;
    }

    window.IDEAS.yt.isActive = true;
    lastResolvedState = result?.key || null;
    applyTransitionSetting(config);
    applyOverlaySetting(config);
    createPlayer(result.playlistId);
  }

  function showPlayer() {
    const playerEl = document.getElementById("background-player");
    if (playerEl && !playerEl.classList.contains("visible")) {
      playerEl.classList.add("visible");
    }
  }

  function setPlayerVisibility(visible) {
    const playerEl = document.getElementById("background-player");
    if (!playerEl) return;
    playerEl.classList.toggle("visible", Boolean(visible));
  }

  function attemptPlaybackFromGesture(source = "unknown") {
    pendingGesturePlayback = true;
    safariGestureUnlocked = true;

    const player = window.IDEAS?.yt?.player;
    if (!player || typeof player.getPlayerState !== "function") {
      console.info("[YouTube Background] Gesture playback: player unavailable", { source });
      log("No player detected");
      return;
    }

    const gestureBehavior = getBehavior();

    try {
      if (
        isStrictAutoplayBrowser() &&
        !safariPlaylistLoaded &&
        (window.IDEAS?.yt?.currentPlaylistId || safariDeferredFallbackVideoId)
      ) {
        const started = loadSafariDeferredPlaylist(player, source);
        if (started) {
          return;
        }
      }

      if (player.getPlayerState() === YT.PlayerState.ENDED) {
        setPlayerVisibility(false);
        if (gestureBehavior.randomize) {
          if (typeof player.nextVideo === "function") {
            player.nextVideo();
          } else {
            player.playVideo();
          }
        } else if (typeof player.playVideoAt === "function") {
          player.playVideoAt(0);
        }
      }

      if (player.getPlayerState() !== YT.PlayerState.PLAYING) {
        console.info("[YouTube Background] Gesture playback: playVideo()", { source });
        log("Start playback from user gesture");
        applyMuteSetting(player, gestureBehavior);
        player.playVideo();
        pendingGesturePlayback = false;
      } else if (typeof player.setPlaybackQuality === "function") {
        console.info("[YouTube Background] Gesture playback: already playing", { source });
        player.setPlaybackQuality("highres");
        log("Request high-resolution playback");
        pendingGesturePlayback = false;
      }
    } catch (error) {
      console.warn("[YouTube Background] Gesture playback failed", { source, error });
      log("Gesture playback failed", error);
    }
  }

  function dashboardPathsMatch(stored, requested) {
    const bare = (path) => {
      const normalized = String(path || "").trim().replace(/^\/+|\/+$/g, "");
      return normalized.startsWith("dashboard-") ? normalized.slice("dashboard-".length) : normalized;
    };

    const left = String(stored || "").trim().replace(/^\/+|\/+$/g, "");
    const right = String(requested || "").trim().replace(/^\/+|\/+$/g, "");
    return left === right || bare(left) === bare(right);
  }

  function shouldHandlePlayEvent(data = {}) {
    const dashboardTarget = String(data?.dashboard_path || "").trim().replace(/^\/+|\/+$/g, "");
    const viewTarget = String(data?.view_path || "").trim().replace(/^\/+|\/+$/g, "");

    if (!dashboardTarget && !viewTarget) {
      return true;
    }

    const routeParts = window.location.pathname.split("/").filter(Boolean);
    const currentDashboard = normalizeDashboardPath(routeParts[0] || "lovelace");
    const currentView = String(routeParts[1] || "").trim().replace(/^\/+|\/+$/g, "");

    if (dashboardTarget && !dashboardPathsMatch(dashboardTarget, currentDashboard)) {
      return false;
    }

    if (viewTarget && viewTarget !== currentView) {
      return false;
    }

    return true;
  }

  function installHomeAssistantPlayActionListener() {
    if (haPlayEventSubscriptionReady) {
      return;
    }

    const hass = getHass();
    const connection = hass?.connection;
    if (!connection || typeof connection.subscribeEvents !== "function") {
      setTimeout(installHomeAssistantPlayActionListener, 1000);
      return;
    }

    connection
      .subscribeEvents((eventMessage) => {
        const payload = eventMessage?.event?.data || eventMessage?.data || {};
        if (!shouldHandlePlayEvent(payload)) {
          return;
        }

        checkViewBackgroundConfig().finally(() => {
          window.setTimeout(() => {
            attemptPlaybackFromGesture(`ha_action:${payload?.source || "service"}`);
          }, 0);
        });
      }, "youtube_background_play")
      .then(() => {
        haPlayEventSubscriptionReady = true;
      })
      .catch((error) => {
        console.warn("[YouTube Background] Failed to subscribe to HA play action event", error);
        setTimeout(installHomeAssistantPlayActionListener, 2000);
      });
  }

  function pausePlaybackFromEvent(source = "service") {
    const player = window.IDEAS?.yt?.player;
    if (!player || typeof player.pauseVideo !== "function") {
      return;
    }

    try {
      pendingGesturePlayback = false;
      player.pauseVideo();
      setPlayerVisibility(false);
      console.info("[YouTube Background] Pause requested", { source });
    } catch (error) {
      console.warn("[YouTube Background] Pause request failed", { source, error });
    }
  }

  function installHomeAssistantPauseActionListener() {
    if (haPauseEventSubscriptionReady) {
      return;
    }

    const hass = getHass();
    const connection = hass?.connection;
    if (!connection || typeof connection.subscribeEvents !== "function") {
      setTimeout(installHomeAssistantPauseActionListener, 1000);
      return;
    }

    connection
      .subscribeEvents((eventMessage) => {
        const payload = eventMessage?.event?.data || eventMessage?.data || {};
        if (!shouldHandlePlayEvent(payload)) {
          return;
        }

        pausePlaybackFromEvent(`ha_action:${payload?.source || "service"}`);
      }, "youtube_background_pause")
      .then(() => {
        haPauseEventSubscriptionReady = true;
      })
      .catch((error) => {
        console.warn("[YouTube Background] Failed to subscribe to HA pause action event", error);
        setTimeout(installHomeAssistantPauseActionListener, 2000);
      });
  }

  function toggleMuteFromGesture() {
    const player = window.IDEAS?.yt?.player;
    if (!player?.isMuted || !player?.mute || !player?.unMute) return;

    try {
      player.isMuted() ? player.unMute() : player.mute();
      log("Toggle Background Audio");
    } catch (error) {
      log("Gesture mute toggle failed", error);
    }
  }

  function installGestureHandlers() {
    if (gestureHandlersInstalled) return;
    gestureHandlersInstalled = true;

    const handlePlaybackFromDoubleClick = () => {
      attemptPlaybackFromGesture("dblclick");
      toggleMuteFromGesture();
    };

    const handlePlaybackFromGesture = (source = "gesture") => {
      attemptPlaybackFromGesture(source);
    };

    // Use native dblclick for desktop; it's reliable and intentional
    if (window.PointerEvent) {
      window.addEventListener("pointerdown", () => handlePlaybackFromGesture("pointerdown"), true);
    } else {
      window.addEventListener("mousedown", () => handlePlaybackFromGesture("mousedown"), true);
    }

    // Native dblclick event: fires reliably on desktop and tablet for intentional double-clicks
    window.addEventListener("dblclick", handlePlaybackFromDoubleClick, true);

    // Touch events: only use for playback attempt, never for mute toggle
    window.addEventListener("touchstart", () => {
      handlePlaybackFromGesture("touchstart");
    }, { capture: true, passive: true });

    // Keyboard: allow Enter/Space for playback, 'm' key for mute
    window.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        handlePlaybackFromGesture("keydown");
      }
      if (event.key.toLowerCase() === "m") {
        toggleMuteFromGesture();
      }
    }, true);

    const body = document.body;
    if (body) {
      const bodyPlaybackFallback = (source) => () => handlePlaybackFromGesture(source);

      if (window.PointerEvent) {
        body.addEventListener("pointerdown", bodyPlaybackFallback("body.pointerdown"), { capture: true });
      } else {
        body.addEventListener("touchstart", bodyPlaybackFallback("body.touchstart"), { capture: true, passive: true });
      }
    }
  }

  function hidePlayer() {
    const player = window.IDEAS?.yt?.player;
    if (player && typeof player.pauseVideo === "function") {
      player.pauseVideo();
    }
    window.IDEAS.yt.isActive = false;
    setPlayerVisibility(false);
  }

  function scheduleInitialShuffle(player, playlistId, behavior) {
    if (!player || !behavior?.randomize) {
      window.IDEAS.yt.pendingShufflePlaylistId = null;
      return;
    }

    window.IDEAS.yt.pendingShufflePlaylistId = playlistId;
    let attemptsRemaining = 10;

    const tryRandomStart = () => {
      if (
        window.IDEAS?.yt?.pendingShufflePlaylistId !== playlistId ||
        window.IDEAS?.yt?.currentPlaylistId !== playlistId
      ) {
        return;
      }

      try {
        if (typeof player.setShuffle === "function") {
          player.setShuffle(true);
        }

        const playlistEntries = typeof player.getPlaylist === "function" ? player.getPlaylist() : null;
        const playlistLength = Array.isArray(playlistEntries) ? playlistEntries.length : 0;

        if (playlistLength > 1 && typeof player.playVideoAt === "function") {
          const randomIndex = Math.floor(Math.random() * playlistLength);
          player.playVideoAt(randomIndex);
        } else if (playlistLength === 1 && typeof player.playVideoAt === "function") {
          player.playVideoAt(0);
        } else if (attemptsRemaining > 0) {
          attemptsRemaining -= 1;
          window.setTimeout(tryRandomStart, 200);
          return;
        } else if (typeof player.nextVideo === "function") {
          player.nextVideo();
        } else {
          player.playVideo();
        }

        if (behavior.autoplay) {
          player.playVideo();
        }
      } catch (error) {
        log("Initial shuffle start failed", error);
      } finally {
        if (window.IDEAS?.yt?.pendingShufflePlaylistId === playlistId) {
          window.IDEAS.yt.pendingShufflePlaylistId = null;
        }
      }
    };

    window.setTimeout(tryRandomStart, 700);
  }

  function ensurePlayerContainer() {
    const applySafariNoOpacity = (element) => {
      if (!element || !isSafariBrowser()) return;
      element.classList.add("safari-no-opacity");
      element.style.setProperty("opacity", "1", "important");
      element.style.setProperty("pointer-events", "auto", "important");
    };

    let ytPlayer = document.getElementById("background-player");
    if (ytPlayer) {
      applySafariNoOpacity(ytPlayer);
      return ytPlayer;
    }

    ytPlayer = Object.assign(document.createElement("div"), {
      id: "background-player",
      innerHTML: "<div id='yt-Iframe'></div>"
    });
    applySafariNoOpacity(ytPlayer);
    document.body.appendChild(ytPlayer);

    if (!document.getElementById("youtube-background-player-style")) {
      document.head.appendChild(Object.assign(document.createElement("style"), {
        id: "youtube-background-player-style",
        textContent: `
          div#background-player {
            transition: opacity 0.6s ease-in-out;
            opacity: 0;
            position: fixed;
            inset: 0;
            width: 100vw;
            height: 100vh;
            margin: auto;
            pointer-events: none;
            overflow: hidden;
            z-index: 0;
          }
          #background-player.visible {
            opacity: 1;
          }
          #background-player.safari-no-opacity {
            opacity: 1;
            visibility: visible !important;
            pointer-events: auto !important;
          }
          #background-player.safari-no-opacity > #yt-Iframe,
          #background-player.safari-no-opacity iframe {
            pointer-events: auto !important;
          }
          #background-player.no-transition {
            transition: none;
          }
          div#background-player::after {
            content: '';
            background: var(--yt-overlay-gradient, none);
            pointer-events: none;
            position: fixed;
            inset: 0;
          }
          div#background-player > #yt-Iframe,
          div#background-player iframe {
            width: max(100vw, calc(100vh * 16 / 9));
            height: max(100vh, calc(100vw * 9 / 16));
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
          }
          body {
            background-color: transparent;
            --view-background: none;
          }
          html:not(.bubble-html-scroll-locked) body > home-assistant {
            position: absolute;
            z-index: 1;
            width: 100%;
          }
      `}));
    }

    installGestureHandlers();
    return ytPlayer;
  }

  function initializeYouTubePlayer() {
    if (typeof YT === "undefined" || !YT || typeof YT.Player !== "function") {
      console.warn("[YouTube Background] YouTube Iframe API is not ready yet.");
      return;
    }

    ensurePlayerContainer();

    const existingPlayer = window.IDEAS?.yt?.player;
    if (existingPlayer && typeof existingPlayer.destroy === "function") {
      try {
        existingPlayer.destroy();
      } catch (error) {
        console.warn("[YouTube Background] Failed to destroy previous player", error);
      }
    }

    const onInitBehavior = getBehavior();
    const origin = window.location.origin || undefined;
    const widgetReferrer = window.location.href || undefined;
    const isSafari = isSafariBrowser();
    const strictAutoplay = isStrictAutoplayBrowser();
    window.IDEAS.yt.player = new YT.Player("yt-Iframe", {
      height: "100%",
      width: "100%",
      host: "https://www.youtube-nocookie.com",
      playerVars: getPlayerVarsForInit(onInitBehavior, strictAutoplay, origin, widgetReferrer),
      events: {
        onReady: function (event) {
          const currentId = window.IDEAS.yt.currentPlaylistId;
          const readyBehavior = getBehavior();
          const startIndex = getPlaylistStartIndex(currentId, readyBehavior);
          safariPlaylistRetryCount = 0;
          log(`Starting playlist ${currentId}`);
          ensureInlineIframeAttributes();
          setTimeout(ensureInlineIframeAttributes, 250);
          setTimeout(ensureInlineIframeAttributes, 1200);

          if (strictAutoplay) {
            console.info("[YouTube Background] Strict autoplay onReady path", {
              playlistId: currentId,
              startIndex,
              isSafari,
              isTizen: isTizenBrowser(),
            });
            deferSafariPlaylistUntilGesture(currentId);
          } else {
            loadPlaylistForPlayer(event.target, currentId, readyBehavior, {
              index: startIndex,
              forceCue: false,
            });
          }
          if (!strictAutoplay && typeof event.target.setShuffle === "function") {
            event.target.setShuffle(readyBehavior.randomize);
          }
          if (!strictAutoplay) {
            event.target.setPlaybackQuality("highres");
          }
          if (strictAutoplay) {
            if (typeof event.target.mute === "function") {
              event.target.mute();
            }
          } else {
            applyMuteSetting(event.target, readyBehavior);
          }
          if (readyBehavior.autoplay) {
            if (strictAutoplay) {
              console.info("[YouTube Background] Strict autoplay deferred until gesture", {
                playlistId: currentId,
                isSafari,
                isTizen: isTizenBrowser(),
              });
            } else if (readyBehavior.randomize) {
              scheduleInitialShuffle(event.target, currentId, readyBehavior);
            } else {
              event.target.playVideo();
            }

            if (pendingGesturePlayback && (!strictAutoplay || safariGestureUnlocked)) {
              setTimeout(() => {
                try {
                  applyMuteSetting(event.target, readyBehavior);
                  event.target.playVideo();
                  pendingGesturePlayback = false;
                } catch (error) {
                  console.warn("[YouTube Background] Gesture replay failed", error);
                }
              }, 0);
            }
          } else {
            hidePlayer();
          }
        },
        onStateChange: function (event) {
          const stateBehavior = getBehavior();
          const strictAutoplay = isStrictAutoplayBrowser();
          if (stateBehavior.debug) {
            console.log(Object.keys(YT.PlayerState).find(key => YT.PlayerState[key] === event.data));
          }

          if (event.data === YT.PlayerState.PLAYING) {
            if (strictAutoplay) {
              safariPlaylistLoaded = true;
              safariDeferredPlaylistId = null;
            }
            applyMuteSetting(event.target, stateBehavior);
            showPlayer();
          } else if (event.data === YT.PlayerState.ENDED) {
            if (stateBehavior.autoplay && window.IDEAS.yt.isActive) {
              setPlayerVisibility(false);
              if (stateBehavior.randomize) {
                if (typeof event.target.nextVideo === "function") {
                  event.target.nextVideo();
                } else {
                  event.target.playVideo();
                }
              } else {
                event.target.playVideoAt(0);
              }
            } else {
              hidePlayer();
            }
          } else if (event.data === YT.PlayerState.PAUSED) {
            if (!strictAutoplay && stateBehavior.autoplay && window.IDEAS.yt.isActive) {
              log("Resuming from unexpected pause");
              event.target.playVideo();
            }
          } else if (
            !strictAutoplay &&
            stateBehavior.autoplay &&
            window.IDEAS.yt.isActive &&
            event.data !== YT.PlayerState.BUFFERING &&
            event.data !== YT.PlayerState.CUED
          ) {
            setPlayerVisibility(false);
            event.target.setPlaybackQuality("highres");
            applyMuteSetting(event.target, stateBehavior);
            event.target.playVideo();
          } else if (!stateBehavior.autoplay) {
            hidePlayer();
          }
        },
        onError: function (event) {
          const errorCode = Number(event?.data);
          const behavior = getBehavior();
          const safari = isSafariBrowser();
          const strictAutoplay = isStrictAutoplayBrowser();
          const playlistId = window.IDEAS?.yt?.currentPlaylistId;

          if (strictAutoplay && !safariGestureUnlocked && !safariPlaylistLoaded) {
            console.info("[YouTube Background] Strict autoplay pre-gesture player error ignored", {
              playlistId,
              errorCode,
              isSafari: safari,
              isTizen: isTizenBrowser(),
            });
            return;
          }

          // Error 101/150/153: video owner has blocked embedded playback.
          // 153 is treated as a hard block for playlist playback.
          // 101/150 can occasionally be transient (e.g. playlist index lands on a
          // blocked video), so we skip forward to a new random index instead.
          const isEmbedBlock = [101, 150, 153].includes(errorCode);
          const isHardBlock = errorCode === 153;

          console.warn("[YouTube Background] Player error", errorCode, {
            playlistId,
            isEmbedBlock,
            isHardBlock,
            retryCount: safariPlaylistRetryCount,
            href: window.location.href,
            safari,
            strictAutoplay,
          });

          if (isHardBlock) {
            // On Safari, optionally fallback to one embeddable video from the same
            // playlist when a Data API key is configured.
            if (
              safari &&
              playlistId &&
              safariSingleVideoFallbackAttemptedPlaylistId !== playlistId
            ) {
              safariSingleVideoFallbackAttemptedPlaylistId = playlistId;
              console.warn("[YouTube Background] Attempting single-video fallback", {
                playlistId,
                errorCode,
              });

              resolveFallbackVideoId(playlistId).then((videoId) => {
                if (!videoId) {
                  console.warn(
                    "[YouTube Background] No embeddable fallback video found for playlist",
                    { playlistId }
                  );
                  hidePlayer();
                  return;
                }

                // Defer playback until user gesture — same as playlist deferral
                safariDeferredFallbackVideoId = videoId;
                safariDeferredPlaylistId = null;
                safariPlaylistLoaded = false;
                pendingGesturePlayback = true;
                console.info("[YouTube Background] Safari fallback video deferred until gesture", {
                  playlistId,
                  videoId,
                });
              });
              return;
            }

            console.warn(
              "[YouTube Background] Error 153: embedding blocked by content owner. " +
              "Choose a playlist whose videos allow embedding."
            );
            hidePlayer();
            return;
          }

          if (
            isEmbedBlock &&
            safariPlaylistRetryCount < 2 &&
            playlistId
          ) {
            // 101/150: try skipping to a different index. Works on both Safari
            // and non-Safari since embedded-block errors can hit any browser.
            safariPlaylistRetryCount += 1;
            const retryIndex = getPlaylistStartIndex(playlistId, behavior);
            console.warn("[YouTube Background] Embed-block retry (skip to new index)", {
              attempt: safariPlaylistRetryCount,
              retryIndex,
              playlistId,
              safari,
            });

            setTimeout(() => {
              try {
                loadPlaylistForPlayer(event.target, playlistId, behavior, {
                  index: retryIndex,
                  forceCue: strictAutoplay,
                });
                applyMuteSetting(event.target, behavior);
                if (behavior.autoplay) {
                  event.target.playVideo();
                }
              } catch (error) {
                console.warn("[YouTube Background] Embed-block retry failed", error);
              }
            }, 500);
          }
        }
      }
    });

    applyTransitionSetting();
    applyOverlaySetting();
  }

  function createPlayer(playlistId) {
    const behavior = getBehavior();

    if (
      window.IDEAS.yt.player &&
      typeof window.IDEAS.yt.player.getPlayerState === "function" &&
      window.IDEAS.yt.currentPlaylistId === playlistId
    ) {
      const strictAutoplay = isStrictAutoplayBrowser();
      applyTransitionSetting();
      applyOverlaySetting();
      if (!strictAutoplay && typeof window.IDEAS.yt.player.setShuffle === "function") {
        window.IDEAS.yt.player.setShuffle(behavior.randomize);
      }
      applyMuteSetting(window.IDEAS.yt.player);
      if (behavior.autoplay) {
        if (strictAutoplay) {
          deferSafariPlaylistUntilGesture(playlistId);
        } else if (behavior.randomize) {
          scheduleInitialShuffle(window.IDEAS.yt.player, playlistId, behavior);
        } else if (typeof window.IDEAS.yt.player.playVideoAt === "function") {
          window.IDEAS.yt.player.playVideoAt(0);
        } else {
          window.IDEAS.yt.player.playVideo();
        }
      } else {
        hidePlayer();
      }
      return;
    }

    if (
      window.IDEAS.yt.player &&
      typeof window.IDEAS.yt.player.loadPlaylist === "function" &&
      window.IDEAS.yt.currentPlaylistId !== playlistId
    ) {
      const strictAutoplay = isStrictAutoplayBrowser();
      log(`Switching to playlist ${playlistId}`);
      if (strictAutoplay) {
        window.IDEAS.yt.currentPlaylistId = playlistId;
        deferSafariPlaylistUntilGesture(playlistId);
      } else {
        loadPlaylistForPlayer(window.IDEAS.yt.player, playlistId, behavior, {
          index: getPlaylistStartIndex(playlistId, behavior),
          forceCue: false,
        });
      }
      if (!strictAutoplay && typeof window.IDEAS.yt.player.setShuffle === "function") {
        window.IDEAS.yt.player.setShuffle(behavior.randomize);
      }
      applyMuteSetting(window.IDEAS.yt.player);
      applyOverlaySetting();
      if (behavior.autoplay) {
        if (strictAutoplay) {
          console.info("[YouTube Background] Strict autoplay switched playlist, waiting for gesture", {
            playlistId,
            isSafari: isSafariBrowser(),
            isTizen: isTizenBrowser(),
          });
        } else if (behavior.randomize) {
          scheduleInitialShuffle(window.IDEAS.yt.player, playlistId, behavior);
        } else {
          window.IDEAS.yt.player.playVideo();
        }
      } else {
        hidePlayer();
      }
      return;
    }

    window.IDEAS.yt.currentPlaylistId = playlistId;
    window.onYouTubeIframeAPIReady = initializeYouTubePlayer;
    ensurePlayerContainer();

    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      document.head.appendChild(Object.assign(document.createElement("script"), { src: "https://www.youtube.com/iframe_api" }));
    } else if (typeof YT !== "undefined" && YT && YT.Player) {
      initializeYouTubePlayer();
    }

    if (!window.IDEAS?.yt?.keepaliveInterval) {
      window.IDEAS.yt.keepaliveInterval = setInterval(() => {
        if (!getBehavior().debug) {
          return;
        }
        if (IDEAS?.yt?.player && typeof IDEAS.yt.player.getPlayerState === 'function') {
          try {
            const state = IDEAS.yt.player.getPlayerState();
            console.debug('[YouTube Keepalive] Player state:', state);
          } catch (err) {
            console.warn('[YouTube Keepalive] Player check failed:', err);
          }
        } else {
          console.warn('[YouTube Keepalive] Player not ready or broken');
        }
      }, 10 * 60 * 1000);
    }
  }

  function resolvePlaylistId(config, hass) {
    if (!config || !hass) return null;

    const stateMap = config.state_map ?? {};
    const entityId = String(config.entity_id || "").trim();
    let key;

    if (!entityId) {
      return {
        key: null,
        matched: false,
        playlistId: config.default_playlist_id,
        config
      };
    }

    if (typeof config.entity_id === "string") {
      key = hass.states[entityId]?.state?.toLowerCase();
    }

    const playlist = stateMap[key] ?? config.default_playlist_id;
    return {
      key,
      matched: key in stateMap,
      playlistId: playlist,
      config
    };
  }

  async function checkViewBackgroundConfig() {
    if (!isDashboardRoute()) {
      lastViewId = null;
      lastTemplateName = null;
      currentConfig = null;
      currentConfigSignature = "null";
      lastResolvedState = null;
      hidePlayer();
      return;
    }

    const viewId = getCurrentViewIdFromUrl();
    if (!viewId) return;

    if (viewId !== lastViewId) {
      lastViewId = viewId;
      lastTemplateName = null;
    }

    const config = await getConfigForCurrentView();
    const nextConfigSignature = getConfigSignature(config);
    const configChanged = nextConfigSignature !== currentConfigSignature;
    currentConfig = config;
    currentConfigSignature = nextConfigSignature;

    const hass = getHass();
    const resolved = resolvePlaylistId(config, hass);
    const stateChanged = (resolved?.key || null) !== lastResolvedState;

    if (configChanged || stateChanged) {
      console.info("[YouTube Background] Config refresh", {
        configChanged,
        stateChanged,
        playlistId: resolved?.playlistId ?? null,
        stateKey: resolved?.key ?? null,
      });
      handleConfigChange(config);
    }
  }

  function watchNavigation() {
    window.addEventListener("location-changed", () => {
      requestAnimationFrame(() => checkViewBackgroundConfig());
    });

    const pollIntervalMs = isStrictAutoplayBrowser() ? 15000 : 3000;
    setInterval(() => {
      checkViewBackgroundConfig();
    }, pollIntervalMs);
  }

  function waitForLovelace(timeout = 30000) {
    console.info(
      `%c YouTube Playlist Background %c v${RUNTIME_LOG_VERSION} `,
      'background: #555; color: white; border-radius: 999px 0 0 999px; padding: 2px 10px; font-weight: 500;',
      'background: #d9534f; color: white; border-radius: 0 999px 999px 0; padding: 2px 10px; font-weight: 500; margin-left: -4px;'
    );

    // Start navigation watcher immediately — the 3s poll will activate once hass is ready
  installLifecycleDiagnostics();
    watchNavigation();
    installHomeAssistantPlayActionListener();
    installHomeAssistantPauseActionListener();

    const start = performance.now();

    function tryInit() {
      if (getHass()) {
        checkViewBackgroundConfig();
      } else if (performance.now() - start < timeout) {
        setTimeout(tryInit, 500);
      } else {
        log("Timed out waiting for hass to become available.");
      }
    }

    tryInit();
  }

  waitForLovelace();
})();