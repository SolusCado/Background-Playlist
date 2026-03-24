// Refactored from background.js
(function () {
  // Singleton guard — prevent re-execution on SPA navigation re-loads
  if (window.__ytbgRuntimeLoaded) return;
  window.__ytbgRuntimeLoaded = true;

  const LOG_PREFIX = "YouTube Background";
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

    if (isSafariBrowser() && behavior.autoplay && !safariGestureUnlocked) {
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
    const gradient = buildCornerGradients(config);
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

  function isSafariBrowser() {
    const ua = navigator.userAgent || "";
    const isSafari = /Safari/i.test(ua);
    const isChromiumFamily = /Chrome|Chromium|CriOS|Edg|OPR|SamsungBrowser|Firefox|FxiOS/i.test(ua);
    return isSafari && !isChromiumFamily;
  }

  function ensureInlineIframeAttributes() {
    const iframe = document.querySelector("#background-player iframe");
    if (!iframe) return;

    iframe.setAttribute("playsinline", "1");
    iframe.setAttribute("webkit-playsinline", "true");
    iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
  }

  function getPlaylistStartIndex(behavior = getBehavior()) {
    return behavior.randomize ? Math.floor(Math.random() * 50) : 0;
  }

  function loadPlaylistForPlayer(player, playlistId, behavior = getBehavior(), options = {}) {
    if (!player || typeof player.loadPlaylist !== "function" || typeof player.cuePlaylist !== "function") {
      return;
    }

    const useCue = Boolean(options.forceCue) || !behavior.autoplay;
    const loader = useCue ? "cuePlaylist" : "loadPlaylist";
    const index = Number.isInteger(options.index) ? options.index : getPlaylistStartIndex(behavior);

    player[loader]({
      list: playlistId,
      listType: "playlist",
      index,
      suggestedQuality: "highres"
    });
  }

  function getPlayerVarsForInit(behavior, isSafari, origin, widgetReferrer) {
    if (isSafari) {
      return {
        autoplay: 0,
        controls: 0,
        modestbranding: 1,
        rel: 0,
        fs: 1,
        mute: 1,
        playsinline: 1,
      };
    }

    return {
      autoplay: behavior.autoplay ? 1 : 0,
      controls: 0,
      modestbranding: 1,
      rel: 0,
      fs: 1,
      mute: behavior.mute ? 1 : 0,
      playsinline: 1,
      enablejsapi: 1,
      origin,
      widget_referrer: widgetReferrer,
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

  function logGestureEvent(eventName, details = {}) {
    console.info("[YouTube Background] Gesture event fired", {
      event: eventName,
      ts: Date.now(),
      ...details,
    });
  }

  function attemptPlaybackFromGesture(source = "unknown") {
    logGestureEvent("attemptPlaybackFromGesture", { source });
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

    const handleActivation = (supportsNativeDoubleClick = false, source = "activation") => {
      logGestureEvent(source, { supportsNativeDoubleClick });
      attemptPlaybackFromGesture(source);

      const now = Date.now();
      const isDoubleActivation = now - lastActivationAt < 400;
      lastActivationAt = now;

      if (isDoubleActivation && !supportsNativeDoubleClick) {
        toggleMuteFromGesture();
      }
    };

    const handleDoubleClick = () => {
      logGestureEvent("dblclick");
      attemptPlaybackFromGesture("dblclick");
      toggleMuteFromGesture();
    };

    if (window.PointerEvent) {
      window.addEventListener("pointerdown", () => handleActivation(true, "pointerdown"), true);
    } else {
      window.addEventListener("mousedown", () => handleActivation(true, "mousedown"), true);
      window.addEventListener("touchstart", () => handleActivation(false, "touchstart"), { capture: true, passive: true });
    }
    window.addEventListener("click", () => handleActivation(true, "click"), true);
    window.addEventListener("touchend", () => handleActivation(false, "touchend"), { capture: true, passive: true });
    window.addEventListener("dblclick", handleDoubleClick, true);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        logGestureEvent("keydown", { key: event.key });
        attemptPlaybackFromGesture("keydown");
      }
      if (event.key.toLowerCase() === "m") {
        logGestureEvent("keydown", { key: event.key });
        toggleMuteFromGesture();
      }
    }, true);

    const body = document.body;
    if (body) {
      const bodyPointerFallback = () => {
        logGestureEvent("body.pointerdown");
        attemptPlaybackFromGesture("body.pointerdown");
      };
      const bodyTouchFallback = () => {
        logGestureEvent("body.touchstart");
        attemptPlaybackFromGesture("body.touchstart");
      };

      if (window.PointerEvent) {
        body.addEventListener("pointerdown", bodyPointerFallback, { capture: true });
      } else {
        body.addEventListener("touchstart", bodyTouchFallback, { capture: true, passive: true });
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
    window.setTimeout(() => {
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
        if (typeof player.nextVideo === "function") {
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
    }, 700);
  }

  function ensurePlayerContainer() {
    let ytPlayer = document.getElementById("background-player");
    if (ytPlayer) {
      return ytPlayer;
    }

    ytPlayer = Object.assign(document.createElement("div"), {
      id: "background-player",
      innerHTML: "<div id='yt-Iframe'></div>"
    });
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
    window.IDEAS.yt.player = new YT.Player("yt-Iframe", {
      height: "100%",
      width: "100%",
      host: "https://www.youtube.com",
      playerVars: getPlayerVarsForInit(onInitBehavior, isSafari, origin, widgetReferrer),
      events: {
        onReady: function (event) {
          const currentId = window.IDEAS.yt.currentPlaylistId;
          const readyBehavior = getBehavior();
          const startIndex = getPlaylistStartIndex(readyBehavior);
          safariPlaylistRetryCount = 0;
          log(`Starting playlist ${currentId}`);
          ensureInlineIframeAttributes();
          setTimeout(ensureInlineIframeAttributes, 250);
          setTimeout(ensureInlineIframeAttributes, 1200);

          if (isSafari) {
            console.info("[YouTube Background] Safari legacy onReady path", {
              playlistId: currentId,
              startIndex,
            });
            event.target.cuePlaylist({
              list: currentId,
              listType: "playlist",
              index: startIndex,
              suggestedQuality: "highres"
            });
          } else {
            loadPlaylistForPlayer(event.target, currentId, readyBehavior, {
              index: startIndex,
              forceCue: false,
            });
          }
          if (typeof event.target.setShuffle === "function") {
            event.target.setShuffle(readyBehavior.randomize);
          }
          event.target.setPlaybackQuality("highres");
          if (isSafari) {
            if (typeof event.target.mute === "function") {
              event.target.mute();
            }
          } else {
            applyMuteSetting(event.target, readyBehavior);
          }
          if (readyBehavior.autoplay) {
            if (isSafari) {
              event.target.playVideo();
            } else if (readyBehavior.randomize) {
              scheduleInitialShuffle(event.target, currentId, readyBehavior);
            } else {
              event.target.playVideo();
            }

            if (pendingGesturePlayback) {
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
          const safari = isSafariBrowser();
          if (stateBehavior.debug) {
            console.log(Object.keys(YT.PlayerState).find(key => YT.PlayerState[key] === event.data));
          }

          if (event.data === YT.PlayerState.PLAYING) {
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
            if (!safari && stateBehavior.autoplay && window.IDEAS.yt.isActive) {
              log("Resuming from unexpected pause");
              event.target.playVideo();
            }
          } else if (
            !safari &&
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
          console.warn("[YouTube Background] Player error", event?.data, {
            playlistId: window.IDEAS?.yt?.currentPlaylistId,
            href: window.location.href,
            safari: isSafariBrowser()
          });

          if (
            isSafariBrowser() &&
            [101, 150, 153].includes(errorCode) &&
            safariPlaylistRetryCount < 2 &&
            window.IDEAS?.yt?.currentPlaylistId
          ) {
            safariPlaylistRetryCount += 1;
            const retryIndex = getPlaylistStartIndex(behavior);
            console.warn("[YouTube Background] Safari retry", {
              attempt: safariPlaylistRetryCount,
              retryIndex,
              playlistId: window.IDEAS.yt.currentPlaylistId,
            });

            setTimeout(() => {
              try {
                loadPlaylistForPlayer(event.target, window.IDEAS.yt.currentPlaylistId, behavior, {
                  index: retryIndex,
                  forceCue: true,
                });
                applyMuteSetting(event.target, behavior);
                if (behavior.autoplay) {
                  event.target.playVideo();
                }
              } catch (error) {
                console.warn("[YouTube Background] Safari retry failed", error);
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
      applyTransitionSetting();
      applyOverlaySetting();
      if (typeof window.IDEAS.yt.player.setShuffle === "function") {
        window.IDEAS.yt.player.setShuffle(behavior.randomize);
      }
      applyMuteSetting(window.IDEAS.yt.player);
      if (behavior.autoplay) {
        if (behavior.randomize) {
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
      log(`Switching to playlist ${playlistId}`);
      loadPlaylistForPlayer(window.IDEAS.yt.player, playlistId, behavior, {
        index: getPlaylistStartIndex(behavior),
        forceCue: isSafariBrowser(),
      });
      if (typeof window.IDEAS.yt.player.setShuffle === "function") {
        window.IDEAS.yt.player.setShuffle(behavior.randomize);
      }
      applyMuteSetting(window.IDEAS.yt.player);
      applyOverlaySetting();
      if (behavior.autoplay) {
        if (behavior.randomize) {
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

    const pollIntervalMs = isSafariBrowser() ? 15000 : 3000;
    setInterval(() => {
      checkViewBackgroundConfig();
    }, pollIntervalMs);
  }

  function waitForLovelace(timeout = 30000) {
    console.info(
      `%c YouTube Playlist Background %c v2.0.0 `,
      'background: #555; color: white; border-radius: 999px 0 0 999px; padding: 2px 10px; font-weight: 500;',
      'background: #d9534f; color: white; border-radius: 0 999px 999px 0; padding: 2px 10px; font-weight: 500; margin-left: -4px;'
    );

    // Start navigation watcher immediately — the 3s poll will activate once hass is ready
  installLifecycleDiagnostics();
    watchNavigation();

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