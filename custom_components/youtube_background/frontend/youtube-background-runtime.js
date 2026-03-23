// Refactored from background.js
(function () {
  const LOG_PREFIX = "YouTube Background";
  window.IDEAS = window.IDEAS || {};
  window.IDEAS.yt = window.IDEAS.yt || {
    currentPlaylistId: null,
    player: null
  };

  function getBehavior(config = currentConfig) {
    return {
      mute: config?.mute !== false,
      autoplay: config?.autoplay !== false,
      randomize: config?.randomize !== false,
      transition: config?.transition === "none" ? "none" : "fade",
      debug: config?.debug === true,
    };
  }

  function log(...args) {
    if (!getBehavior().debug) return;
    console.log(`%c[${LOG_PREFIX}]`, "color: #c4302b; font-weight: bold;", ...args);
  }

  function applyMuteSetting(player, config = currentConfig) {
    if (!player?.mute || !player?.unMute) return;
    if (getBehavior(config).mute) {
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
      gradients.push(`linear-gradient(270deg, ${clear} 50%, ${solid} 100%)`);
    }
    if (hasBottom) {
      gradients.push(`linear-gradient(0deg, ${clear} 50%, ${solid} 100%)`);
    }
    if (hasLeft) {
      gradients.push(`linear-gradient(90deg, ${clear} 50%, ${solid} 100%)`);
    }
    if (hasTop) {
      gradients.push(`linear-gradient(180deg, ${clear} 50%, ${solid} 100%)`);
    }

    return gradients.join(", ") || "none";
  }

  function applyOverlaySetting(config = currentConfig) {
    const playerEl = document.getElementById("background-player");
    if (!playerEl) return;
    playerEl.style.setProperty("--yt-overlay-gradient", buildCornerGradients(config));
  }

  let lastViewId = null;
  let lastTemplateName = null;
  let currentConfig = null;
  let lastResolvedState = null;

  function getLovelaceRoot() {
    return document
      .querySelector("home-assistant")?.shadowRoot
      ?.querySelector("home-assistant-main")?.shadowRoot
      ?.querySelector("ha-panel-lovelace")?.shadowRoot
      ?.querySelector("hui-root");
  }

  function getCurrentViewIdFromUrl() {
    const segments = window.location.pathname.split("/").filter(Boolean);
    const [, view = "0"] = segments;
    return view;
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
    const locationParts = window.location.pathname.split("/").filter(Boolean);
    const dashboardPath = locationParts[0] || "lovelace";
    const viewId = getCurrentViewIdFromUrl();
    const viewConfig = getCurrentViewConfig(viewId);
    const viewPath = viewConfig?.path || locationParts[1] || "";

    // Call websocket to get config
    const hass = getLovelaceRoot()?.hass;
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
    const hass = root?.hass;
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

  function hidePlayer() {
    const player = window.IDEAS?.yt?.player;
    if (player && typeof player.pauseVideo === "function") {
      player.pauseVideo();
    }
    window.IDEAS.yt.isActive = false;

    const playerEl = document.getElementById("background-player");
    if (playerEl && playerEl.classList.contains("visible")) {
      playerEl.classList.remove("visible");
    }
  }

  function createPlayer(playlistId) {
    const behavior = getBehavior();
    const playlistIndex = behavior.randomize ? Math.floor(Math.random() * 50) : 0;

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
        window.IDEAS.yt.player.playVideo();
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
      const loader = behavior.autoplay ? "loadPlaylist" : "cuePlaylist";
      window.IDEAS.yt.player[loader]({
        list: playlistId,
        listType: 'playlist',
        index: playlistIndex,
        suggestedQuality: 'highres'
      });
      if (typeof window.IDEAS.yt.player.setShuffle === "function") {
        window.IDEAS.yt.player.setShuffle(behavior.randomize);
      }
      applyMuteSetting(window.IDEAS.yt.player);
      applyOverlaySetting();
      if (behavior.autoplay) {
        window.IDEAS.yt.player.playVideo();
      } else {
        hidePlayer();
      }
      return;
    }

    window.IDEAS.yt.currentPlaylistId = playlistId;
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      document.head.appendChild(Object.assign(document.createElement("script"), { src: "https://www.youtube.com/iframe_api" }));
    } else if (typeof YT !== "undefined" && YT && YT.Player) {
      window.onYouTubeIframeAPIReady();
    }

    var ytPlayer = document.getElementById("background-player");
    if (!ytPlayer) {
      ytPlayer = Object.assign(document.createElement("div"), {
        id: "background-player",
        innerHTML: "<div id='yt-Iframe'></div>"
      });
      document.body.appendChild(ytPlayer);

      document.head.appendChild(Object.assign(document.createElement("style"),{
        textContent: `
          div#background-player {
            transition: opacity 0.6s ease-in-out;
            opacity: 0;
            position: fixed;
            inset: 0;
            margin: auto;
            pointer-events: none;
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
          div#background-player > iframe {
            aspect-ratio: 16 / 9;
            height: 100vh;
            width: initial;
            position: absolute;
            left: 50%;
            transform: translateX(-50%);
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

      document.body.addEventListener('pointerdown', () => {
        if (!window.IDEAS?.yt?.isActive) return;

        var player = window.IDEAS.yt.player;
        const pointerBehavior = getBehavior();
        if (player && player.getPlayerState) {
          if (player.getPlayerState() === YT.PlayerState.ENDED) {
            hidePlayer();
            const pointerBehavior = getBehavior();
            if (pointerBehavior.randomize && typeof player.nextVideo === "function") {
              player.nextVideo();
            } else {
              player.playVideoAt(0);
            }
          }

          if (player.getPlayerState() != YT.PlayerState.PLAYING)
          {
            log("Start playback");
            applyMuteSetting(player, pointerBehavior);
            player.playVideo();
          }
          else { player.setPlaybackQuality('highres'); log("Request high-resolution playback"); }
        }
        else {
          log("No player detected");
        }
      });

      document.body.addEventListener('pointerdown', () => {
        const now = Date.now();
        const player = window.IDEAS.yt.player;

        if (!player?.isMuted || !player?.mute || !player?.unMute)  return;

        if (now - (window._lastTapTime || 0) < 400) {
          player.isMuted() ? player.unMute() : player.mute();
          log("Toggle Background Audio");
        }

        window._lastTapTime = now;
      });

      window.onYouTubeIframeAPIReady = function () {
        const onInitBehavior = getBehavior();
        const origin = window.location.origin || undefined;
        const widgetReferrer = window.location.href || undefined;
        window.IDEAS.yt.player = new YT.Player('yt-Iframe', {
          height: '100%',
          width: '100%',
          host: 'https://www.youtube.com',
          playerVars: {
            autoplay: onInitBehavior.autoplay ? 1 : 0,
            controls: 0,
            modestbranding: 1,
            rel: 0,
            fs: 1,
            mute: onInitBehavior.mute ? 1 : 0,
            playsinline: 1,
            enablejsapi: 1,
            origin,
            widget_referrer: widgetReferrer
          },
          events: {
            onReady: function (event) {
              const currentId = window.IDEAS.yt.currentPlaylistId;
              const readyBehavior = getBehavior();
              const readyIndex = readyBehavior.randomize ? Math.floor(Math.random() * 50) : 0;
              log(`Starting playlist ${currentId}`);

              event.target.setShuffle(readyBehavior.randomize);
              event.target.cuePlaylist({
                list: currentId,
                listType: 'playlist',
                index: readyIndex,
                suggestedQuality: 'highres'
              });
              event.target.setPlaybackQuality('highres');
              applyMuteSetting(event.target, readyBehavior);
              if (readyBehavior.autoplay) {
                event.target.playVideo();
              } else {
                hidePlayer();
              }
            },
            onStateChange: function (event) {
              const stateBehavior = getBehavior();
              if (stateBehavior.debug) {
                console.log(Object.keys(YT.PlayerState).find(key => YT.PlayerState[key] === event.data));
              }
              if (event.data === YT.PlayerState.PLAYING) {
                applyMuteSetting(event.target, stateBehavior);
                showPlayer();
              }
              else if (stateBehavior.autoplay && event.data !== YT.PlayerState.BUFFERING && event.data !== YT.PlayerState.CUED) {
                hidePlayer();
                event.target.setPlaybackQuality('highres');
                applyMuteSetting(event.target, stateBehavior);
                event.target.playVideo();
              } else if (!stateBehavior.autoplay) {
                hidePlayer();
              }

              if (event.data === YT.PlayerState.ENDED) {
                if (stateBehavior.autoplay) {
                  if (stateBehavior.randomize && typeof event.target.nextVideo === "function") {
                    event.target.nextVideo();
                  } else {
                    event.target.playVideoAt(0);
                  }
                } else {
                  hidePlayer();
                }
              }
            }
          }
        });

        applyTransitionSetting();
        applyOverlaySetting();

        setInterval(() => {
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
      };
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
    const viewId = getCurrentViewIdFromUrl();
    if (!viewId) return;

    if (viewId !== lastViewId) {
      lastViewId = viewId;
      lastTemplateName = null;
    }

    const config = await getConfigForCurrentView();
    const configChanged = JSON.stringify(config) !== JSON.stringify(currentConfig);
    currentConfig = config;

    const root = getLovelaceRoot();
    const hass = root?.hass;
    const resolved = resolvePlaylistId(config, hass);
    const stateChanged = (resolved?.key || null) !== lastResolvedState;

    if (configChanged || stateChanged) {
      handleConfigChange(config);
    }
  }

  function watchNavigation() {
    window.addEventListener("location-changed", () => {
      requestAnimationFrame(() => checkViewBackgroundConfig());
    });

    setInterval(() => {
      checkViewBackgroundConfig();
    }, 3000);
  }

  function waitForLovelace(timeout = 10000) {
    console.info(
      `%c YouTube Playlist Background %c v1.0.0 `,
      'background: #555; color: white; border-radius: 999px 0 0 999px; padding: 2px 10px; font-weight: 500;',
      'background: #d9534f; color: white; border-radius: 0 999px 999px 0; padding: 2px 10px; font-weight: 500; margin-left: -4px;'
    );

    const start = performance.now();

    function tryInit() {
      if (getLovelaceRoot()?.lovelace) {
        checkViewBackgroundConfig();
        watchNavigation();
      } else if (performance.now() - start < timeout) {
        requestAnimationFrame(tryInit);
      } else {
        log("Timed out waiting for Lovelace root.");
      }
    }

    tryInit();
  }

  waitForLovelace();
})();