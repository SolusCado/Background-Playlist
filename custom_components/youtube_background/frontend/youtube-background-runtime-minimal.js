(function () {
  const LOG_PREFIX = "YouTube Background";
  window.IDEAS = window.IDEAS || {};
  window.IDEAS.yt = window.IDEAS.yt || {
    currentPlaylistId: null,
    player: null,
  };

  function log(...args) {
    console.log(`%c[${LOG_PREFIX}]`, "color: #c4302b; font-weight: bold;", ...args);
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

  function ensurePlayerContainer() {
    let ytPlayer = document.getElementById("background-player");
    if (ytPlayer) {
      return ytPlayer;
    }

    ytPlayer = Object.assign(document.createElement("div"), {
      id: "background-player",
      innerHTML: "<div id='yt-Iframe'></div><div id='play-button-overlay'>▶ Click to Play</div>"
    });
    document.body.insertBefore(ytPlayer, document.body.firstChild);

    if (!document.getElementById("youtube-background-player-style")) {
      document.head.appendChild(Object.assign(document.createElement("style"), {
        id: "youtube-background-player-style",
        textContent: `
          div#background-player {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            z-index: 1;
            background-color: black;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          div#background-player > #yt-Iframe,
          div#background-player iframe {
            width: 100%;
            height: 100%;
            border: none;
          }

          #play-button-overlay {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 4rem;
            color: white;
            cursor: pointer;
            z-index: 10;
            text-shadow: 0 0 10px rgba(0,0,0,0.8);
            background: rgba(0,0,0,0.5);
            padding: 20px 40px;
            border-radius: 10px;
            user-select: none;
          }

          #play-button-overlay:hover {
            background: rgba(0,0,0,0.7);
          }

          #play-button-overlay.hidden {
            display: none;
          }

          body {
            background-color: transparent;
            --view-background: none;
          }

          html:not(.bubble-html-scroll-locked) body > home-assistant {
            position: absolute;
            z-index: 2;
            width: 100%;
            pointer-events: none;
          }
      `}));
    }

    return ytPlayer;
  }

  function hidePlayButton() {
    const btn = document.getElementById("play-button-overlay");
    if (btn) {
      btn.classList.add("hidden");
    }
  }

  function showPlayButton() {
    const btn = document.getElementById("play-button-overlay");
    if (btn) {
      btn.classList.remove("hidden");
    }
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

    const playlistId = window.IDEAS?.yt?.currentPlaylistId;
    log(`Initializing player for playlist: ${playlistId}`);

    window.IDEAS.yt.player = new YT.Player("yt-Iframe", {
      height: "100%",
      width: "100%",
      host: "https://www.youtube.com",
      playerVars: {
        autoplay: 0,
        controls: 1,
        modestbranding: 1,
        rel: 0,
        fs: 1,
        mute: 1,
        playsinline: 1,
      },
      events: {
        onReady: function (event) {
          const currentId = window.IDEAS.yt.currentPlaylistId;
          log(`Player ready. Cueing playlist ${currentId}`);

          event.target.cuePlaylist({
            list: currentId,
            listType: "playlist",
            index: 0,
            suggestedQuality: "highres"
          });

          showPlayButton();
        },
        onStateChange: function (event) {
          log(`Player state changed: ${event.data}`);

          if (event.data === YT.PlayerState.PLAYING) {
            hidePlayButton();
          } else if (event.data === YT.PlayerState.ENDED) {
            showPlayButton();
          } else if (event.data === YT.PlayerState.UNSTARTED || event.data === YT.PlayerState.CUED) {
            showPlayButton();
          }
        },
        onError: function (event) {
          console.error("[YouTube Background] Player error", event?.data, {
            playlistId: window.IDEAS?.yt?.currentPlaylistId,
            userAgent: navigator.userAgent
          });
          showPlayButton();
        }
      }
    });
  }

  function createPlayer(playlistId) {
    log(`Creating player for playlist: ${playlistId}`);
    window.IDEAS.yt.currentPlaylistId = playlistId;
    window.onYouTubeIframeAPIReady = initializeYouTubePlayer;
    ensurePlayerContainer();

    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      document.head.appendChild(Object.assign(document.createElement("script"), { src: "https://www.youtube.com/iframe_api" }));
    } else if (typeof YT !== "undefined" && YT && YT.Player) {
      initializeYouTubePlayer();
    }
  }

  function setupPlayButton() {
    const btn = document.getElementById("play-button-overlay");
    if (!btn || btn.dataset.bound === "true") return;

    btn.dataset.bound = "true";

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      log("Play button clicked");
      const player = window.IDEAS?.yt?.player;
      if (player && typeof player.playVideo === "function") {
        player.playVideo();
      }
    });
  }

  const NON_DASHBOARD_ROUTES = new Set([
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
    "youtube_background",
  ]);

  function isDashboardRoute(pathname = window.location.pathname) {
    const [firstSegment = ""] = pathname.split("/").filter(Boolean);
    if (!firstSegment) return false;
    return !NON_DASHBOARD_ROUTES.has(firstSegment);
  }

  function normalizeDashboardPath(path = "") {
    const normalized = String(path || "").trim().replace(/^\/+|\/+$/g, "");
    return normalized || "lovelace";
  }

  async function getConfigForCurrentView() {
    if (!isDashboardRoute()) {
      return null;
    }

    const hass = getHass();
    if (!hass?.callWS) {
      return null;
    }

    const locationParts = window.location.pathname.split("/").filter(Boolean);
    const dashboardPath = normalizeDashboardPath(locationParts[0] || "lovelace");
    const viewPath = locationParts[1] || "";

    try {
      const response = await hass.callWS({
        type: "youtube_background/get_config",
        dashboard_path: dashboardPath,
        view_path: viewPath,
      });
      return response?.config ?? null;
    } catch (error) {
      log("Failed to get config via websocket", error);
      return null;
    }
  }

  function handleConfigChange(config) {
    if (!config) {
      log("No config found");
      return;
    }

    const playlistId = String(config.default_playlist_id || "").trim();
    if (!playlistId) {
      log("No playlist ID resolved");
      return;
    }

    log(`Config change: loading playlist ${playlistId}`);
    createPlayer(playlistId);
    setupPlayButton();
  }

  async function checkViewBackgroundConfig() {
    const hass = getHass();

    if (!hass) {
      log("hass not ready");
      return;
    }

    const config = await getConfigForCurrentView();
    if (!config) {
      log("No youtube_background config found");
      return;
    }

    log("Resolved config", {
      hasDefaultPlaylist: Boolean(config.default_playlist_id),
      configKeys: Object.keys(config),
    });

    handleConfigChange(config);
  }

  function waitForLovelace(timeout = 30000) {
    console.info(
      `%c YouTube Playlist Background %c v2026.03.24.1 (MINIMAL TEST) `,
      'background: #555; color: white; border-radius: 999px 0 0 999px; padding: 2px 10px; font-weight: 500;',
      'background: #d9534f; color: white; border-radius: 0 999px 999px 0; padding: 2px 10px; font-weight: 500; margin-left: -4px;'
    );

    const start = performance.now();

    function tryInit() {
      if (getHass()) {
        checkViewBackgroundConfig();
      } else if (performance.now() - start < timeout) {
        setTimeout(tryInit, 500);
      } else {
        log("Timed out waiting for lovelace/hass");
      }
    }

    tryInit();
  }

  waitForLovelace();
})();
