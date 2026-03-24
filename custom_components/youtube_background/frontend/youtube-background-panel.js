const PANEL_TAG = "youtube-background-panel";

class YouTubeBackgroundPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._mappings = [];
    this._dashboards = [];
    this._viewsByDashboard = {};
    this._stateSuggestions = {};
    this._entityOptions = [];
    this._youtubeApiConfigured = false;
    this._error = "";
    this._preview = {
      open: false,
      embedUrl: "",
      overlayGradient: "none",
      transition: "fade",
    };
  }

  set hass(value) {
    this._hass = value;
    if (!this._initialized && value) {
      this._initialized = true;
      this._loadInitialData();
    }
  }

  get hass() {
    return this._hass;
  }

  _toBoolean(value, defaultValue) {
    if (value === undefined || value === null) {
      return defaultValue;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) {
        return true;
      }
      if (["false", "0", "no", "off", ""].includes(normalized)) {
        return false;
      }
    }
    return Boolean(value);
  }

  async _loadInitialData() {
    await Promise.all([this._loadMappings(), this._loadDashboards(), this._loadYouTubeApiStatus()]);
    this._entityOptions = Object.keys(this._hass?.states || {}).sort();
    await this._hydrateMissingPlaylistTitles();
    this._render();
  }

  async _hydrateMissingPlaylistTitles() {
    if (!this._youtubeApiConfigured) {
      return;
    }

    for (const mapping of this._mappings) {
      if (!mapping?.id || !mapping?.default_playlist_id || mapping?.default_playlist_title) {
        continue;
      }

      try {
        const response = await this._hass.callWS({
          type: "youtube_background/resolve_playlist",
          value: mapping.default_playlist_id,
        });
        const title = String(response?.playlist?.title || "").trim();
        if (!title) {
          continue;
        }

        mapping.default_playlist_title = title;
        await this._hass.callWS({
          type: "youtube_background/update_mapping",
          mapping_id: mapping.id,
          updates: { default_playlist_title: title },
        });
      } catch (error) {
        console.warn("Could not hydrate playlist title", mapping?.default_playlist_id, error);
      }
    }
  }

  async _loadYouTubeApiStatus() {
    try {
      const response = await this._hass.callWS({ type: "youtube_background/get_youtube_api_status" });
      this._youtubeApiConfigured = !!response?.configured;
    } catch (error) {
      console.warn("Could not load YouTube API status", error);
      this._youtubeApiConfigured = false;
    }
  }

  async _loadMappings() {
    try {
      const response = await this._hass.callWS({ type: "youtube_background/get_mappings" });
      this._mappings = (response.mappings || []).map((mapping) => ({
        ...mapping,
        mute: this._toBoolean(mapping.mute, true),
        autoplay: this._toBoolean(mapping.autoplay, true),
        randomize: this._toBoolean(mapping.randomize, true),
        transition: mapping.transition || "fade",
        debug: this._toBoolean(mapping.debug, false),
        fade_corners: Array.isArray(mapping.fade_corners) ? mapping.fade_corners : [],
        fade_color: mapping.fade_color || "#000000",
        fade_opacity: Number.isFinite(Number(mapping.fade_opacity)) ? Number(mapping.fade_opacity) : 50,
        _isEditing: false,
        _newStateKey: "",
        _newStatePlaylist: "",
        _playlistSearchQuery: "",
        _playlistSearchResults: [],
        _playlistSearchError: "",
        _playlistSearchBusy: false,
        _playlistResolveBusy: false,
        _playlistResolvedTitle: "",
        _playlistResolvedDetails: "",
        default_playlist_title: mapping.default_playlist_title || "",
      }));
    } catch (error) {
      console.error(error);
      this._error = "Failed to load existing mappings.";
    }
  }

  async _loadDashboards() {
    try {
      let response = null;
      try {
        response = await this._hass.callWS({ type: "lovelace/dashboards" });
      } catch (_error) {
        response = await this._hass.callWS({ type: "lovelace/dashboards/list" });
      }

      const dashboardsRaw = Array.isArray(response)
        ? response
        : (response?.dashboards || []);

      const uniqueDashboards = new Map();
      dashboardsRaw.forEach((dashboard) => {
        const rawPath = dashboard?.url_path || dashboard?.path || "";
        const path = rawPath || "lovelace";
        if (uniqueDashboards.has(path)) {
          return;
        }
        const title = dashboard?.title || (path === "lovelace" ? "Overview" : path);
        uniqueDashboards.set(path, { title, path });
      });

      this._dashboards = Array.from(uniqueDashboards.values()).sort((a, b) => {
        if (a.path === "lovelace") return -1;
        if (b.path === "lovelace") return 1;
        return a.title.localeCompare(b.title);
      });
    } catch (error) {
      console.warn("Could not list dashboards, fallback to manual input", error);
      this._dashboards = [];
    }
  }

  async _loadViewsForDashboard(dashboardPath) {
    if (!dashboardPath || this._viewsByDashboard[dashboardPath]) {
      return;
    }

    try {
      const response = await this._hass.callWS({
        type: "lovelace/config",
        url_path: dashboardPath === "lovelace" ? null : dashboardPath,
      });
      const views = response?.views || [];
      this._viewsByDashboard[dashboardPath] = views.map((view, index) => ({
        title: view.title || view.path || "Untitled",
        path: view.path || String(index),
      }));
    } catch (error) {
      console.warn("Could not load views for dashboard", dashboardPath, error);
      this._viewsByDashboard[dashboardPath] = [];
    }

    this._render();
  }

  async _extractStateSuggestions(entityId) {
    if (!entityId || !this._hass?.states?.[entityId]) {
      return [];
    }

    const stateObj = this._hass.states[entityId];
    const suggestions = new Set();

    const currentState = String(stateObj.state || "").trim();
    if (currentState) {
      suggestions.add(currentState);
    }

    try {
      const now = new Date();
      const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

      const historyPath = `history/period/${oneYearAgo.toISOString()}?filter_entity_id=${encodeURIComponent(entityId)}&end_time=${encodeURIComponent(now.toISOString())}&minimal_response`;
      const historyResponse = await this._hass.callApi("GET", historyPath);

      const rows = Array.isArray(historyResponse) && Array.isArray(historyResponse[0])
        ? historyResponse[0]
        : [];

      rows.forEach((item) => {
        const state = String(item?.state || "").trim();
        if (state) {
          suggestions.add(state);
        }
      });
    } catch (error) {
      console.warn("Could not fetch entity history", error);
    }

    return Array.from(suggestions).sort((a, b) => a.localeCompare(b));
  }

  _addMapping() {
    this._mappings.unshift({
      id: `new_${Date.now()}`,
      enabled: true,
      dashboard_path: "",
      view_path: "",
      entity_id: "",
      default_playlist_id: "",
      default_playlist_title: "",
      state_map: {},
      mute: true,
      autoplay: true,
      randomize: true,
      transition: "fade",
      debug: false,
      fade_corners: [],
      fade_color: "#000000",
      fade_opacity: 50,
      _isEditing: true,
      _isNew: true,
      _newStateKey: "",
      _newStatePlaylist: "",
      _playlistSearchQuery: "",
      _playlistSearchResults: [],
      _playlistSearchError: "",
      _playlistSearchBusy: false,
      _playlistResolveBusy: false,
      _playlistResolvedTitle: "",
      _playlistResolvedDetails: "",
    });
    this._render();
  }

  async _editMapping(mappingId) {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }
    mapping._isEditing = true;
    mapping._playlistSearchQuery = mapping._playlistSearchQuery || "";
    mapping._playlistSearchResults = mapping._playlistSearchResults || [];
    mapping._playlistSearchError = mapping._playlistSearchError || "";
    mapping._playlistSearchBusy = false;
    mapping._playlistResolveBusy = false;
    mapping._playlistResolvedTitle = mapping._playlistResolvedTitle || "";
    mapping._playlistResolvedDetails = mapping._playlistResolvedDetails || "";
    this._stateSuggestions[mapping.id] = await this._extractStateSuggestions(mapping.entity_id);
    this._loadViewsForDashboard(mapping.dashboard_path);

    if (
      this._youtubeApiConfigured &&
      mapping.default_playlist_id &&
      !mapping.default_playlist_title &&
      !mapping._playlistResolvedTitle &&
      !mapping._playlistResolvedDetails
    ) {
      await this._resolvePlaylistField(mapping.id);
    }

    this._render();
  }

  _cancelEdit(mappingId) {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }
    if (mapping._isNew) {
      this._mappings = this._mappings.filter((item) => item.id !== mappingId);
    } else {
      mapping._isEditing = false;
    }
    this._render();
  }

  async _updateField(mappingId, field, value) {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }

    if (field === "_playlistSearchQuery") {
      mapping[field] = value;
      return;
    }

    if (field === "fade_opacity") {
      const opacityValue = Number(String(value).replace(/[^0-9.]/g, ""));
      mapping[field] = Number.isFinite(opacityValue) ? Math.max(0, Math.min(100, opacityValue)) : 50;
    } else {
      mapping[field] = value;
    }

    if (field === "dashboard_path") {
      mapping.view_path = "";
      this._loadViewsForDashboard(value);
    }

    if (field === "entity_id") {
      this._stateSuggestions[mapping.id] = await this._extractStateSuggestions(value);
    }

    if (field === "default_playlist_id") {
      mapping.default_playlist_title = "";
      mapping._playlistResolvedTitle = "";
      mapping._playlistResolvedDetails = "";
      mapping._playlistResolveBusy = false;
    }

    this._render();
  }

  _setFadeCorner(mappingId, corner, enabled) {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }

    const validCorners = ["top_left", "top_right", "bottom_left", "bottom_right"];
    if (!validCorners.includes(corner)) {
      return;
    }

    const nextCorners = new Set(Array.isArray(mapping.fade_corners) ? mapping.fade_corners : []);
    if (enabled) {
      nextCorners.add(corner);
    } else {
      nextCorners.delete(corner);
    }
    mapping.fade_corners = Array.from(nextCorners);
    this._render();
  }

  _addStateMapping(mappingId) {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }

    const stateKey = (mapping._newStateKey || "").trim().toLowerCase();
    const playlistId = (mapping._newStatePlaylist || "").trim();
    if (!stateKey || !playlistId) {
      return;
    }

    mapping.state_map = {
      ...(mapping.state_map || {}),
      [stateKey]: playlistId,
    };

    mapping._newStateKey = "";
    mapping._newStatePlaylist = "";
    this._render();
  }

  async _searchPlaylists(mappingId) {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }

    const query = (mapping._playlistSearchQuery || "").trim();
    if (!query) {
      mapping._playlistSearchError = "Enter search text first.";
      this._render();
      return;
    }

    mapping._playlistSearchBusy = true;
    mapping._playlistSearchError = "";
    this._render();

    try {
      const response = await this._hass.callWS({
        type: "youtube_background/search_playlists",
        query,
        max_results: 8,
      });
      mapping._playlistSearchResults = response?.items || [];
      mapping._playlistSearchError = mapping._playlistSearchResults.length ? "" : "No playlists found.";
    } catch (error) {
      console.error(error);
      mapping._playlistSearchResults = [];
      mapping._playlistSearchError = error?.message || "Playlist search failed.";
    } finally {
      mapping._playlistSearchBusy = false;
      this._render();
    }
  }

  async _resolvePlaylistField(mappingId, fieldName = "default_playlist_id") {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }

    const rawValue = (mapping[fieldName] || "").trim();
    if (!rawValue) {
      mapping._playlistSearchError = "Enter a playlist URL or ID first.";
      this._render();
      return;
    }

    mapping._playlistResolveBusy = true;
    mapping._playlistResolvedTitle = "";
    mapping._playlistResolvedDetails = "";
    mapping._playlistSearchError = "";
    this._render();

    try {
      const response = await this._hass.callWS({
        type: "youtube_background/resolve_playlist",
        value: rawValue,
      });
      const playlist = response?.playlist || {};
      const resolvedId = playlist.id || rawValue;
      mapping[fieldName] = resolvedId;
      mapping.default_playlist_title = playlist.title || "";
      mapping._playlistResolvedTitle = playlist.title || "";
      const detailParts = [];
      if (playlist.item_count != null) {
        detailParts.push(`${playlist.item_count} video${playlist.item_count !== 1 ? "s" : ""}`);
      }
      if (playlist.estimated_duration_text) {
        detailParts.push(`~${playlist.estimated_duration_text} total`);
      }
      mapping._playlistResolvedDetails = detailParts.join(" • ");
      // If no API key, show the resolved ID as confirmation
      if (!mapping._playlistResolvedTitle && !mapping._playlistResolvedDetails) {
        mapping._playlistResolvedTitle = resolvedId;
        mapping._playlistResolvedDetails = "Add a YouTube Data API key to see playlist title and duration.";
      }
      mapping._playlistSearchError = "";
    } catch (error) {
      console.error(error);
      mapping._playlistSearchError = error?.message || "Could not validate playlist.";
    }

    mapping._playlistResolveBusy = false;
    this._render();
  }

  async _applyPlaylistSearchResult(mappingId, playlistId) {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }

    const playlist = (mapping._playlistSearchResults || []).find((item) => item.id === playlistId);
    mapping.default_playlist_id = playlistId;
    mapping.default_playlist_title = playlist?.title || "";
    mapping._playlistResolvedTitle = playlist?.title || "";
    const detailParts = [];
    if (playlist?.item_count != null) {
      detailParts.push(`${playlist.item_count} items`);
    }
    if (playlist?.estimated_duration_text) {
      detailParts.push(`~${playlist.estimated_duration_text}`);
    }
    mapping._playlistResolvedDetails = detailParts.join(" • ");
    mapping._playlistSearchError = "";

    if (this._youtubeApiConfigured) {
      await this._resolvePlaylistField(mappingId);
      return;
    }

    this._render();
  }

  _escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  _normalizeOpacity(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return 0.5;
    }
    if (numeric <= 1) {
      return Math.max(0, Math.min(1, numeric));
    }
    return Math.max(0, Math.min(1, numeric / 100));
  }

  _hexToRgb(hexColor) {
    const raw = String(hexColor || "#000000").trim();
    const validHex = /^#([0-9a-fA-F]{6})$/;
    const normalized = validHex.test(raw) ? raw : "#000000";
    return {
      red: parseInt(normalized.slice(1, 3), 16),
      green: parseInt(normalized.slice(3, 5), 16),
      blue: parseInt(normalized.slice(5, 7), 16),
    };
  }

  _buildOverlayGradient(mapping) {
    const corners = Array.isArray(mapping.fade_corners) ? mapping.fade_corners : [];
    if (!corners.length) {
      return "none";
    }

    const rgb = this._hexToRgb(mapping.fade_color || "#000000");
    const alpha = this._normalizeOpacity(mapping.fade_opacity);
    const solid = `rgba(${rgb.red}, ${rgb.green}, ${rgb.blue}, ${alpha})`;
    const clear = `rgba(${rgb.red}, ${rgb.green}, ${rgb.blue}, 0)`;
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

  _extractPlaylistIdForPreview(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) {
      return "";
    }
    if (/^[A-Za-z0-9_-]{10,}$/.test(value)) {
      return value;
    }

    try {
      const url = new URL(value);
      const fromList = url.searchParams.get("list");
      if (fromList) {
        return fromList;
      }
    } catch (_error) {
      return "";
    }
    return "";
  }

  _clearEntity(mappingId) {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }
    mapping.entity_id = "";
    this._stateSuggestions[mapping.id] = [];
    this._render();
  }

  _openPreview(mappingId) {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }

    const playlistId = this._extractPlaylistIdForPreview(mapping.default_playlist_id);
    if (!playlistId) {
      this._error = "Enter a valid playlist ID or URL before previewing.";
      this._render();
      return;
    }

    // Destroy any existing preview player first
    this._destroyPreviewPlayer();

    this._preview = {
      open: true,
      playlistId,
      autoplay: this._toBoolean(mapping.autoplay, true),
      mute: this._toBoolean(mapping.mute, true),
      randomize: this._toBoolean(mapping.randomize, true),
      overlayGradient: this._buildOverlayGradient(mapping),
      transition: mapping.transition === "none" ? "none" : "fade",
    };
    this._error = "";
    this._render();
    // Mount the IFrame API player after the DOM node exists
    this._mountPreviewPlayer();
  }

  _openPlaylistPreview(playlistId, playlistTitle) {
    // Destroy any existing preview player first
    this._destroyPreviewPlayer();

    this._preview = {
      open: true,
      playlistId,
      playlistTitle,
      autoplay: true,
      mute: false,
      randomize: false,
      overlayGradient: "",
      transition: "fade",
    };
    this._error = "";
    this._render();
    // Mount the IFrame API player after the DOM node exists
    this._mountPreviewPlayer();
  }

  _destroyPreviewPlayer() {
    if (this._previewPlayer) {
      try { this._previewPlayer.destroy(); } catch (_) {}
      this._previewPlayer = null;
    }
  }

  _scheduleInitialShuffle(player, playlistId, autoplay, randomize) {
    // Match the runtime's shuffle scheduling: setShuffle() + nextVideo() after delay
    if (!randomize || !autoplay) return;
    
    setTimeout(() => {
      // Only apply if player still exists and playlist hasn't changed
      if (
        this._previewPlayer === player &&
        this._preview.open &&
        this._preview.playlistId === playlistId &&
        typeof player.nextVideo === "function"
      ) {
        player.nextVideo();
      }
    }, 700);
  }

  _installPreviewGestureHandlers(target) {
    // Match the runtime's gesture handlers: single-click for playback, double-click for mute
    let lastActivationAt = 0;

    const attemptPlaybackFromGesture = () => {
      const player = this._previewPlayer;
      if (!player || typeof player.getPlayerState !== "function") {
        return;
      }

      try {
        if (player.getPlayerState() === YT.PlayerState.ENDED) {
          if (this._preview.randomize) {
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
          player.playVideo();
        }
      } catch (error) {
        // Silently handle errors during gesture
      }
    };

    const toggleMuteFromGesture = () => {
      const player = this._previewPlayer;
      if (!player?.isMuted || !player?.mute || !player?.unMute) return;

      try {
        player.isMuted() ? player.unMute() : player.mute();
      } catch (error) {
        // Silently handle errors during mute toggle
      }
    };

    const handleActivation = (supportsNativeDoubleClick = false) => {
      attemptPlaybackFromGesture();

      const now = Date.now();
      const isDoubleActivation = now - lastActivationAt < 400;
      lastActivationAt = now;

      if (isDoubleActivation && !supportsNativeDoubleClick) {
        toggleMuteFromGesture();
      }
    };

    const handleDoubleClick = () => {
      attemptPlaybackFromGesture();
      toggleMuteFromGesture();
    };

    // Install handlers: single-click/tap for playback, double-click for mute
    if (window.PointerEvent) {
      target.addEventListener("pointerdown", () => handleActivation(true), true);
    } else {
      target.addEventListener("mousedown", () => handleActivation(true), true);
      target.addEventListener("touchstart", () => handleActivation(false), { capture: true, passive: true });
    }
    target.addEventListener("dblclick", handleDoubleClick, true);
    target.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        attemptPlaybackFromGesture();
      }
      if (event.key.toLowerCase() === "m") {
        toggleMuteFromGesture();
      }
    }, true);

    // Auto-trigger playback after a short delay to work around browser autoplay restrictions
    // This is especially helpful for preview mode where autoplay may be blocked
    setTimeout(() => {
      if (this._previewPlayer && this._preview.open) {
        attemptPlaybackFromGesture();
      }
    }, 500);
  }

  _mountPreviewPlayer() {
    const target = this.shadowRoot.querySelector("#yt-preview-target");
    if (!target) return;

    const { playlistId, autoplay, mute, randomize } = this._preview;
    const origin = window.location.origin || undefined;

    const createPlayer = () => {
      this._previewPlayer = new YT.Player(target, {
        height: "100%",
        width: "100%",
        host: "https://www.youtube.com",
        playerVars: {
          autoplay: autoplay ? 1 : 0,
          controls: 1,
          mute: mute ? 1 : 0,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          enablejsapi: 1,
          origin,
        },
        events: {
          onReady: (event) => {
            event.target.setShuffle(randomize);
            event.target.cuePlaylist({
              list: playlistId,
              listType: "playlist",
              index: 0,
              suggestedQuality: "highres",
            });
            if (autoplay) {
              // Match runtime: schedule shuffle+nextVideo() instead of immediate playVideo()
              if (randomize) {
                this._scheduleInitialShuffle(event.target, playlistId, autoplay, randomize);
              } else {
                event.target.playVideo();
              }
            }
            // Install gesture handlers after player is ready
            this._installPreviewGestureHandlers(target);
          },
        },
      });
    };

    if (typeof YT !== "undefined" && YT?.Player) {
      createPlayer();
    } else {
      // Load the API script if not already present
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(script);
      }
      // Chain onto whatever callback is already registered (runtime may have set one)
      const existingCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof existingCallback === "function") existingCallback();
        // Only create if this preview is still open
        if (this._preview.open && this._preview.playlistId === playlistId) {
          createPlayer();
        }
      };
    }
  }

  _closePreview() {
    this._destroyPreviewPlayer();
    this._preview = {
      open: false,
      playlistId: "",
      autoplay: true,
      mute: true,
      randomize: true,
      overlayGradient: "none",
      transition: "fade",
    };
    this._render();
  }

  _removeStateMapping(mappingId, stateKey) {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }

    const nextStateMap = { ...(mapping.state_map || {}) };
    delete nextStateMap[stateKey];
    mapping.state_map = nextStateMap;
    this._render();
  }

  async _saveMapping(mappingId) {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }

    const payload = {
      id: mapping._isNew ? undefined : mapping.id,
      enabled: this._toBoolean(mapping.enabled, true),
      dashboard_path: (mapping.dashboard_path || "").trim(),
      view_path: (mapping.view_path || "").trim(),
      entity_id: (mapping.entity_id || "").trim(),
      default_playlist_id: (mapping.default_playlist_id || "").trim(),
      default_playlist_title: (mapping.default_playlist_title || "").trim(),
      state_map: mapping.state_map || {},
      mute: this._toBoolean(mapping.mute, true),
      autoplay: this._toBoolean(mapping.autoplay, true),
      randomize: this._toBoolean(mapping.randomize, true),
      transition: mapping.transition || "fade",
      debug: this._toBoolean(mapping.debug, false),
      fade_corners: Array.isArray(mapping.fade_corners) ? mapping.fade_corners : [],
      fade_color: mapping.fade_color || "#000000",
      fade_opacity: Number.isFinite(Number(mapping.fade_opacity)) ? Number(mapping.fade_opacity) : 50,
    };

    if (!payload.dashboard_path || !payload.default_playlist_id) {
      this._error = "Dashboard and Default Playlist are required.";
      this._render();
      return;
    }

    try {
      if (mapping._isNew) {
        const response = await this._hass.callWS({
          type: "youtube_background/create_mapping",
          mapping: payload,
        });
        Object.assign(mapping, response.mapping || {});
        mapping._isNew = false;
      } else {
        await this._hass.callWS({
          type: "youtube_background/update_mapping",
          mapping_id: mapping.id,
          updates: payload,
        });
      }
      mapping._isEditing = false;
      this._error = "";
      this._render();
    } catch (error) {
      console.error(error);
      this._error = "Failed to save mapping.";
      this._render();
    }
  }

  async _deleteMapping(mappingId) {
    if (!window.confirm("Delete this mapping?")) {
      return;
    }

    try {
      await this._hass.callWS({
        type: "youtube_background/delete_mapping",
        mapping_id: mappingId,
      });
      this._mappings = this._mappings.filter((item) => item.id !== mappingId);
      this._render();
    } catch (error) {
      console.error(error);
      this._error = "Failed to delete mapping.";
      this._render();
    }
  }

  _bindEvents() {
    this.shadowRoot.querySelector("#add-mapping")?.addEventListener("click", () => this._addMapping());

    this.shadowRoot.querySelectorAll("button[data-toggle-field]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const mappingId = event.currentTarget.dataset.mappingId;
        const field = event.currentTarget.dataset.toggleField;
        const mapping = this._mappings.find((item) => item.id === mappingId);
        if (!mapping || !field) {
          return;
        }
        const defaultValue = field === "debug" ? false : true;
        mapping[field] = !this._toBoolean(mapping[field], defaultValue);
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("input[data-fade-corner]").forEach((input) => {
      input.addEventListener("change", (event) => {
        const mappingId = event.currentTarget.dataset.mappingId;
        const corner = event.currentTarget.dataset.fadeCorner;
        this._setFadeCorner(mappingId, corner, event.currentTarget.checked);
      });
    });

    this.shadowRoot.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        const action = event.currentTarget.dataset.action;
        const mappingId = event.currentTarget.dataset.mappingId;
        const stateKey = event.currentTarget.dataset.stateKey;
        const playlistId = event.currentTarget.dataset.playlistId;

        if (action === "edit") await this._editMapping(mappingId);
        if (action === "cancel") this._cancelEdit(mappingId);
        if (action === "save") await this._saveMapping(mappingId);
        if (action === "delete") await this._deleteMapping(mappingId);
        if (action === "add-state") this._addStateMapping(mappingId);
        if (action === "remove-state") this._removeStateMapping(mappingId, stateKey);
        if (action === "search-playlists") await this._searchPlaylists(mappingId);
        if (action === "resolve-playlist") await this._resolvePlaylistField(mappingId);
        if (action === "use-playlist") await this._applyPlaylistSearchResult(mappingId, playlistId);
        if (action === "preview-playlist") this._openPlaylistPreview(playlistId, event.currentTarget.dataset.playlistTitle);
        if (action === "toggle-transition") {
          const mapping = this._mappings.find((item) => item.id === mappingId);
          if (mapping) {
            mapping.transition = mapping.transition === "none" ? "fade" : "none";
            this._render();
          }
        }
        if (action === "clear-entity") this._clearEntity(mappingId);
        if (action === "preview") this._openPreview(mappingId);
        if (action === "close-preview") this._closePreview();
      });
    });

    this.shadowRoot.querySelector(".preview-dialog")?.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    this.shadowRoot.querySelectorAll("input[data-field], select[data-field], textarea[data-field]").forEach((input) => {
      input.addEventListener("change", async (event) => {
        const mappingId = event.currentTarget.dataset.mappingId;
        const field = event.currentTarget.dataset.field;
        const value = event.currentTarget.type === "checkbox"
          ? event.currentTarget.checked
          : event.currentTarget.value;
        await this._updateField(mappingId, field, value);
      });
      input.addEventListener("input", async (event) => {
        if (event.currentTarget.tagName === "SELECT") {
          return;
        }
        const mappingId = event.currentTarget.dataset.mappingId;
        const field = event.currentTarget.dataset.field;
        if (field === "_playlistSearchQuery") {
          const mapping = this._mappings.find((item) => item.id === mappingId);
          if (mapping) {
            mapping._playlistSearchQuery = event.currentTarget.value;
          }
          return;
        }
        if (field === "fade_opacity") {
            // Only update in-memory, don't re-render
            const mapping = this._mappings.find((item) => item.id === mappingId);
            if (mapping) {
              mapping.fade_opacity = event.currentTarget.value;
            }
            return;
        }
          // For all other fields, just update in-memory without re-rendering
          const mapping = this._mappings.find((item) => item.id === mappingId);
          if (mapping) {
            const value = event.currentTarget.type === "checkbox"
              ? event.currentTarget.checked
              : event.currentTarget.value;
            // Deep assignment for nested fields like "state_map.someState"
            if (field.includes(".")) {
              const [parent, child] = field.split(".");
              if (!mapping[parent]) mapping[parent] = {};
              mapping[parent][child] = value;
            } else {
              mapping[field] = value;
            }
          }
      });

      if (input.dataset.field === "_playlistSearchQuery") {
        input.addEventListener("keydown", async (event) => {
          if (event.key !== "Enter") {
            return;
          }
          event.preventDefault();
          await this._searchPlaylists(event.currentTarget.dataset.mappingId);
        });
      }
    });

    this._initializeEntitySelectors();
  }

  _initializeEntitySelectors() {
    this.shadowRoot.querySelectorAll(".entity-selector-host").forEach((host) => {
      const mappingId = host.dataset.mappingId;
      const mapping = this._mappings.find((item) => item.id === mappingId);
      if (!mapping) {
        return;
      }

      host.innerHTML = "";

      if (customElements.get("ha-selector")) {
        const selector = document.createElement("ha-selector");
        selector.hass = this._hass;
        selector.selector = { entity: {} };
        selector.value = mapping.entity_id || "";
        selector.addEventListener("value-changed", (event) => {
          this._updateField(mappingId, "entity_id", event.detail?.value || "");
        });
        host.appendChild(selector);
        return;
      }

      if (customElements.get("ha-entity-picker")) {
        const picker = document.createElement("ha-entity-picker");
        picker.hass = this._hass;
        picker.value = mapping.entity_id || "";
        picker.setAttribute("allow-custom-entity", "");
        picker.addEventListener("value-changed", (event) => {
          this._updateField(mappingId, "entity_id", event.detail?.value || "");
        });
        host.appendChild(picker);
        return;
      }

      const input = document.createElement("input");
      input.type = "text";
      input.value = mapping.entity_id || "";
      input.placeholder = "Enter entity_id manually";
      input.addEventListener("input", (event) => {
        this._updateField(mappingId, "entity_id", event.currentTarget.value || "");
      });
      host.appendChild(input);
    });
  }

  _renderMappingCard(mapping) {
    const views = this._viewsByDashboard[mapping.dashboard_path] || [];
    const knownStates = Array.isArray(this._stateSuggestions[mapping.id]) ? this._stateSuggestions[mapping.id] : [];
    const stateRows = Object.entries(mapping.state_map || {});
    const hasDashboard = Boolean(mapping.dashboard_path);
    const hasEntity = Boolean(String(mapping.entity_id || "").trim());
    const searchResults = mapping._playlistSearchResults || [];
    const matchedDashboard = this._dashboards.find((dashboard) => dashboard.path === mapping.dashboard_path);
    const dashboardDisplayTitle = matchedDashboard?.title || mapping.dashboard_path || "(no dashboard)";
    const defaultPlaylistDisplay = mapping.default_playlist_title || mapping.default_playlist_id || "-";
    const entityId = (mapping.entity_id || "").trim();
    const currentEntityState = hasEntity ? String(this._hass?.states?.[entityId]?.state ?? "").trim() : "";
    const escapedCurrentEntityState = currentEntityState ? this._escapeHtml(currentEntityState) : "";
    const currentStateSuffix = escapedCurrentEntityState ? ` <span class="current-state-value">(${escapedCurrentEntityState})</span>` : "";
    const stateEntitySummary = hasEntity
      ? `<em>${stateRows.length}</em> State Mappings for <strong>${this._escapeHtml(entityId)}</strong>${currentStateSuffix}`
      : "";

    if (!mapping._isEditing) {
      return `
        <div class="card">
          <div class="header-row">
            <div class="header-left">
              <div class="enabled-toggle-section">
                <button class="toggle ${mapping.enabled !== false ? "on" : "off"}" data-toggle-field="enabled" data-mapping-id="${mapping.id}" type="button" role="switch" aria-checked="${mapping.enabled !== false}" aria-label="Enabled"></button>
              </div>
              <div>
                <h3>${dashboardDisplayTitle}${mapping.view_path ? ` / ${mapping.view_path}` : ""}</h3>
                <div class="meta">${this._escapeHtml(defaultPlaylistDisplay)}</div>
              </div>
            </div>
            <div class="actions">
              <div class="action-buttons">
                <button data-action="edit" data-mapping-id="${mapping.id}">Edit</button>
                <button class="danger" data-action="delete" data-mapping-id="${mapping.id}">Delete</button>
              </div>
            </div>
          </div>
          <div class="summary-grid">
            <div class="state-entity-summary">${stateEntitySummary}</div>
            <div class="status-icons-summary">
              <span class="status-icon ${mapping.autoplay !== false ? "active" : "inactive"}" title="Autoplay: ${mapping.autoplay !== false ? "On" : "Off"}">▶</span>
              <span class="status-icon ${mapping.transition === "none" ? "inactive" : "active"}" title="Transition: ${mapping.transition || "fade"}">◐</span>
              <span class="status-icon audio" title="Muted: ${mapping.mute !== false ? "Yes" : "No"}">${mapping.mute !== false ? "🔇" : "🔊"}</span>
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="card editing">
        <div class="header-row">
          <h3>${mapping._isNew ? "New Mapping" : "Edit Mapping"}</h3>
          <div class="toggle-wrapper">
            <label class="toggle-label">Enabled</label>
            <button class="toggle ${mapping.enabled ? "on" : "off"}" data-toggle-field="enabled" data-mapping-id="${mapping.id}" type="button" role="switch" aria-checked="${mapping.enabled}"></button>
          </div>
        </div>

        <div class="form-grid">
          <label>Dashboard</label>
          <div>
            <select data-field="dashboard_path" data-mapping-id="${mapping.id}">
              <option value="">-- Select dashboard --</option>
              ${this._dashboards
                .map(
                  (dashboard) =>
                    `<option value="${dashboard.path}" ${dashboard.path === mapping.dashboard_path ? "selected" : ""}>${dashboard.title} (${dashboard.path})</option>`
                )
                .join("")}
            </select>
            ${this._dashboards.length ? "" : `<div class="field-note">No dashboards discovered; enter path manually (e.g. lovelace).</div>`}
            <input type="text" placeholder="Or enter dashboard path manually" value="${mapping.dashboard_path || ""}" data-field="dashboard_path" data-mapping-id="${mapping.id}" />
          </div>
          ${hasDashboard ? `
            <label>View (optional)</label>
            <div>
              <select data-field="view_path" data-mapping-id="${mapping.id}">
                <option value="">All views in dashboard</option>
                ${views
                  .map(
                    (view) =>
                      `<option value="${view.path}" ${view.path === mapping.view_path ? "selected" : ""}>${view.title} (${view.path || "index"})</option>`
                  )
                  .join("")}
              </select>
              <input type="text" placeholder="Or enter view path manually" value="${mapping.view_path || ""}" data-field="view_path" data-mapping-id="${mapping.id}" />
            </div>

            <label>Default Playlist</label>
            <div>
              <div class="playlist-input-row">
                <a class="primary-button" href="https://www.youtube.com/@BaileyPoint/playlists" target="_blank" rel="noopener noreferrer">Browse Curated Playlists</a>
                <input type="text" value="${mapping.default_playlist_id || ""}" data-field="default_playlist_id" data-mapping-id="${mapping.id}" placeholder="Playlist URL or ID" />
                <button type="button" data-action="resolve-playlist" data-mapping-id="${mapping.id}" ${mapping._playlistResolveBusy ? "disabled" : ""}>${mapping._playlistResolveBusy ? "Validating…" : "Validate"}</button>
                <div class="playlist-inline-status">
                  ${(mapping._playlistResolvedTitle || mapping._playlistResolvedDetails) ? `
                    ${mapping._playlistResolvedTitle ? `<div class="field-note playlist-resolved-title">✓ ${this._escapeHtml(mapping._playlistResolvedTitle)}</div>` : ""}
                    ${mapping._playlistResolvedDetails ? `<div class="field-note playlist-resolved-details">${this._escapeHtml(mapping._playlistResolvedDetails)}</div>` : ""}
                  ` : `<div class="field-note playlist-status-placeholder">No playlist loaded</div>`}
                </div>
              </div>
              ${this._youtubeApiConfigured ? `
                <div class="playlist-search-row">
                  <input type="text" value="${mapping._playlistSearchQuery || ""}" data-field="_playlistSearchQuery" data-mapping-id="${mapping.id}" placeholder="Search all YouTube playlists" />
                  <button type="button" data-action="search-playlists" data-mapping-id="${mapping.id}" ${mapping._playlistSearchBusy ? "disabled" : ""}>${mapping._playlistSearchBusy ? "Searching..." : "Search"}</button>
                </div>
                ${searchResults.length ? `
                  <div class="playlist-results">
                    ${searchResults
                      .map(
                        (item) => `
                          <div class="playlist-result-item">
                            ${item.thumbnail_url ? `<img src="${item.thumbnail_url}" alt="${this._escapeHtml(item.title)}" class="playlist-result-thumbnail" />` : `<div class="playlist-result-thumbnail-placeholder"></div>`}
                            <div class="playlist-result-content">
                              <div class="playlist-result-title">${this._escapeHtml(item.title)}</div>
                              <div class="playlist-result-meta">${this._escapeHtml(item.channel_title || "")}${item.item_count != null ? ` • ${item.item_count} items` : ""}</div>
                            </div>
                            <div class="playlist-result-actions">
                              <button type="button" class="preview-button" data-action="preview-playlist" data-playlist-id="${item.id}" data-playlist-title="${this._escapeHtml(item.title)}" title="Preview playlist">▶</button>
                              <button type="button" data-action="use-playlist" data-mapping-id="${mapping.id}" data-playlist-id="${item.id}">Use</button>
                            </div>
                          </div>
                        `
                      )
                      .join("")}
                  </div>
                ` : ""}
              ` : `<div class="field-note">Add a YouTube Data API key in the integration options to search playlists by name.</div>`}
              ${mapping._playlistSearchError ? `<div class="error small-error">${this._escapeHtml(mapping._playlistSearchError)}</div>` : ""}
            </div>

            <label>Playback Options</label>
            <div class="playback-options-row">
              <div class="toggle-option">
                <button class="toggle ${mapping.autoplay !== false ? "on" : "off"}" data-toggle-field="autoplay" data-mapping-id="${mapping.id}" type="button" role="switch" aria-checked="${mapping.autoplay !== false}" aria-label="Autoplay"></button>
                <span>Autoplay</span>
              </div>
              <div class="toggle-option">
                <button class="toggle ${mapping.mute !== false ? "on" : "off"}" data-toggle-field="mute" data-mapping-id="${mapping.id}" type="button" role="switch" aria-checked="${mapping.mute !== false}" aria-label="Start Muted"></button>
                <span>Start Muted</span>
              </div>
              <div class="toggle-option">
                <button class="toggle ${mapping.randomize !== false ? "on" : "off"}" data-toggle-field="randomize" data-mapping-id="${mapping.id}" type="button" role="switch" aria-checked="${mapping.randomize !== false}" aria-label="Shuffle Playlist"></button>
                <span>Shuffle Playlist</span>
              </div>
              <div class="toggle-option">
                <button class="toggle ${mapping.transition !== "none" ? "on" : "off"}" data-action="toggle-transition" data-mapping-id="${mapping.id}" type="button" role="switch" aria-checked="${mapping.transition !== "none"}" aria-label="Fade Transition"></button>
                <span>Fade Transition</span>
              </div>
            </div>

            <label>Faded Corners</label>
            <div>
              <div class="fade-layout">
                <div class="corner-column">
                  <label><input type="checkbox" data-fade-corner="top_left" data-mapping-id="${mapping.id}" ${(mapping.fade_corners || []).includes("top_left") ? "checked" : ""} /> Top Left</label>
                  <label><input type="checkbox" data-fade-corner="bottom_left" data-mapping-id="${mapping.id}" ${(mapping.fade_corners || []).includes("bottom_left") ? "checked" : ""} /> Bottom Left</label>
                </div>
                <div class="corner-column">
                  <label><input type="checkbox" data-fade-corner="top_right" data-mapping-id="${mapping.id}" ${(mapping.fade_corners || []).includes("top_right") ? "checked" : ""} /> Top Right</label>
                  <label><input type="checkbox" data-fade-corner="bottom_right" data-mapping-id="${mapping.id}" ${(mapping.fade_corners || []).includes("bottom_right") ? "checked" : ""} /> Bottom Right</label>
                </div>
                <div class="fade-controls-column">
                  <label class="fade-control-label">Color <input type="color" value="${mapping.fade_color || "#000000"}" data-field="fade_color" data-mapping-id="${mapping.id}" /></label>
                </div>
                <div class="fade-controls-column">
                  <label class="fade-control-label">Opacity
                    <div class="opacity-input-row">
                      <input type="text" inputmode="decimal" value="${Number.isFinite(Number(mapping.fade_opacity)) ? Number(mapping.fade_opacity) : 50}" data-field="fade_opacity" data-mapping-id="${mapping.id}" />
                      <span class="fade-opacity-suffix">%</span>
                    </div>
                  </label>
                </div>
              </div>
            </div>

            <label>Entity</label>
            <div>
              <div class="entity-selector-host" data-mapping-id="${mapping.id}"></div>
              <button type="button" class="secondary-action" data-action="clear-entity" data-mapping-id="${mapping.id}">Clear Entity</button>
            </div>
          ` : `
            <label></label>
            <div class="field-note">Select a dashboard first to configure view, entity, and playlist settings.</div>
          `}
        </div>

        <div class="state-section ${hasDashboard && hasEntity ? "" : "hidden"}">
          <h4>State → Playlist Mappings${currentStateSuffix}</h4>
          ${knownStates.length ? `
            <div class="state-rows-container">
              ${knownStates
                .map(
                  (state) => `
                    <div class="state-mapping-row">
                      <div class="state-label">${state}</div>
                      <input type="text" value="${(mapping.state_map || {})[state] || ""}" data-field="state_map.${state}" data-mapping-id="${mapping.id}" placeholder="Playlist URL or ID" />
                      <button type="button" class="remove-state-btn" data-action="remove-state" data-state-key="${state}" data-mapping-id="${mapping.id}">Remove</button>
                    </div>
                  `
                )
                .join("")}
            </div>
          ` : `
            <div class="field-note">Select an entity to see available states.</div>
          `}
          <div class="state-add-row">
            <input type="text" class="custom-state-key-input" value="${mapping._newStateKey || ""}" data-field="_newStateKey" data-mapping-id="${mapping.id}" placeholder="add custom state" />
            <input type="text" value="${mapping._newStatePlaylist || ""}" data-field="_newStatePlaylist" data-mapping-id="${mapping.id}" placeholder="Playlist URL or ID" />
            <button data-action="add-state" data-mapping-id="${mapping.id}">Add</button>
          </div>
        </div>

        <div class="form-actions">
          <button type="button" data-action="preview" data-mapping-id="${mapping.id}">Preview Background</button>
          <div class="form-actions-right">
            <button data-action="cancel" data-mapping-id="${mapping.id}">Cancel</button>
            <button class="primary" data-action="save" data-mapping-id="${mapping.id}">Save</button>
          </div>
        </div>
      </div>
    `;
  }

  _render() {
    const cards = this._mappings.map((mapping) => this._renderMappingCard(mapping)).join("");
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: 16px; color: var(--primary-text-color); }
        h2 { margin: 0 0 16px 0; }
        .toolbar { display:flex; justify-content:space-between; align-items:center; margin-bottom: 16px; gap: 12px; }
        .toolbar button { padding: 8px 12px; border-radius: 8px; border: 1px solid var(--divider-color); cursor: pointer; }
        .card { border: 1px solid var(--divider-color); border-radius: 12px; padding: 12px; margin-bottom: 12px; background: var(--card-background-color); }
        .editing { border-color: var(--primary-color); }
        .header-row { display:flex; justify-content:space-between; gap:12px; align-items:center; }
        .header-left { display:flex; gap:12px; align-items:center; flex:1; }
        .enabled-toggle-section { flex-shrink:0; }
        .header-row h3 { margin:0; }
        .actions { display:flex; flex-direction:column; gap:6px; align-items:flex-end; justify-content:center; flex-shrink:0; }
        .action-buttons { display:flex; gap:8px; align-items:center; justify-content:flex-end; }
        .status-icons { display:flex; gap:10px; align-items:center; justify-content:flex-end; min-height: 22px; }
        .status-icon { display:inline-flex; width:22px; height:22px; align-items:center; justify-content:center; cursor:default; opacity:0.45; transition:opacity 0.2s; font-size:20px; line-height:1; }
        .status-icon.active { opacity:1; color:var(--success-color, #4caf50); }
        .status-icon.audio { opacity:1; color:var(--primary-text-color); }
        button { background: transparent; color: var(--primary-text-color); border: 1px solid var(--divider-color); border-radius: 8px; padding: 6px 10px; cursor: pointer; }
        button.primary { background: var(--primary-color); color: var(--text-primary-color); border-color: var(--primary-color); }
        button.danger { border-color: var(--error-color); color: var(--error-color); }
        .primary-button { display:inline-flex; align-items:center; justify-content:center; text-decoration:none; background: var(--primary-color); color: var(--text-primary-color); border: 1px solid var(--primary-color); border-radius: 8px; padding: 6px 10px; cursor: pointer; }
        .summary-grid { margin-top: 30px; display:grid; gap:8px; grid-template-columns: 1fr auto; align-items:center; }
        .state-entity-summary { min-width: 0; }
        .current-state-value { font-weight: 400; color: var(--secondary-text-color); }
        .status-icons-summary { display:flex; gap:10px; align-items:center; justify-content:flex-end; }
        .form-grid { margin-top: 12px; display:grid; grid-template-columns: 160px 1fr; gap:10px; align-items:start; }
        .form-grid input[type='text'], .form-grid select { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 8px; border: 1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color); margin-bottom: 6px; }
        .form-grid .entity-selector-host { display: block; width: 100%; margin-bottom: 6px; }
        .form-grid .entity-selector-host > * { display: block; width: 100%; }
        .field-note { color: var(--secondary-text-color); font-size: 0.9rem; }
        .field-note.playlist-resolved-title { color: var(--success-color, #4caf50); font-weight: 600; }
        .field-note.playlist-resolved-details { color: var(--secondary-text-color); font-size: 0.85rem; }
        .playlist-input-row { display:grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap:8px; margin-bottom: 6px; align-items: center; }
        .playlist-input-row input[type='text'] { margin-bottom: 0; align-self: center; }
        .playlist-input-row button,
        .playlist-input-row .primary-button,
        .playlist-input-row .playlist-inline-status { margin-bottom: 0; align-self: center; }
        .playlist-inline-status { display:flex; flex-direction:column; gap:2px; align-items: flex-end; justify-content: center; min-height: 36px; }
        .playlist-inline-status .field-note,
        .playlist-inline-status .playlist-status-placeholder { margin: 0; }
        .playlist-status-placeholder { color: var(--secondary-text-color); font-style: italic; font-size: 0.9rem; }
        .playlist-search-row { display:grid; grid-template-columns: 1fr auto; gap:8px; margin-bottom: 6px; }
        .playlist-results { border: 1px solid var(--divider-color); border-radius: 8px; overflow: hidden; margin-bottom: 6px; }
        .playlist-result-item { display:grid; grid-template-columns: 100px 1fr auto; gap:12px; padding: 10px; border-bottom: 1px solid var(--divider-color); align-items: center; }
        .playlist-result-item:last-child { border-bottom: none; }
        .playlist-result-thumbnail { width: 100px; height: 60px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
        .playlist-result-thumbnail-placeholder { width: 100px; height: 60px; background: var(--divider-color); border-radius: 4px; flex-shrink: 0; }
        .playlist-result-content { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .playlist-result-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
        .playlist-result-meta { color: var(--secondary-text-color); font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
        .playlist-result-actions { display: flex; gap: 6px; flex-shrink: 0; }
        .preview-button { padding: 6px 8px; border: 1px solid var(--divider-color); background: transparent; color: var(--primary-text-color); border-radius: 4px; cursor: pointer; font-weight: 500; min-width: 36px; }
        .playlist-link { color: var(--primary-color); text-decoration: underline; }
        .secondary-button { display:inline-flex; align-items:center; justify-content:center; text-decoration:none; background: transparent; color: var(--primary-text-color); border: 1px solid var(--divider-color); border-radius: 8px; padding: 6px 10px; cursor: pointer; }
        .playlist-link-button { color: var(--primary-text-color); text-decoration: none; }
        .secondary-action { margin-top: 6px; }
        .preview-row { margin-top: 8px; }
        .inline-toggle-row { display: flex; align-items: center; gap: 10px; }
        .playback-options-row { display: flex; flex-wrap: wrap; gap: 18px; align-items: center; }
        .toggle-option { display: inline-flex; align-items: center; gap: 10px; }
        .fade-layout { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(140px, 1fr) minmax(110px, 140px) minmax(110px, 140px); gap: 10px 18px; align-items: start; }
        .corner-column { display: grid; gap: 10px; }
        .corner-column label { display: flex; align-items: center; gap: 6px; font-size: 0.92rem; }
        .fade-controls-column { display: grid; gap: 10px; }
        .fade-control-label { display: grid; gap: 6px; color: var(--secondary-text-color); font-size: 0.9rem; }
        .fade-controls-column input[type='color'] { width: 84px; height: 34px; padding: 2px; margin: 0; }
        .opacity-input-row { display: inline-flex; align-items: center; gap: 8px; }
        .opacity-input-row input[type='text'] { width: 72px; margin: 0; }
        .fade-opacity-suffix { color: var(--secondary-text-color); }
        .state-section { margin-top: 14px; }
        .hidden { display: none; }
        .state-rows-container { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
        .state-mapping-row { display: grid; grid-template-columns: 160px minmax(0, 1fr) auto; gap: 10px; align-items: center; }
        .state-label { font-weight: 400; white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .remove-state-btn { padding: 6px 10px; }
        .state-add-row { display:grid; grid-template-columns: 160px minmax(0, 1fr) auto; gap:10px; margin-bottom: 10px; }
        .state-add-row .custom-state-key-input { background: transparent; border: 1px solid transparent; color: var(--primary-text-color); }
        .state-add-row .custom-state-key-input::placeholder { color: var(--secondary-text-color); }
        .state-add-row .custom-state-key-input:focus { outline: none; border-color: transparent; box-shadow: none; }
        table { width:100%; border-collapse: collapse; }
        th, td { border-bottom: 1px solid var(--divider-color); text-align:left; padding: 8px; }
        .muted { color: var(--secondary-text-color); }
        .error { color: var(--error-color); margin-bottom: 10px; }
        .small-error { margin-top: 6px; margin-bottom: 0; }
        .toggle-wrapper { display: flex; align-items: center; gap: 12px; }
        .toggle-label { font-size: 0.9rem; color: var(--secondary-text-color); }
        .toggle { width: 48px; height: 28px; border: none; border-radius: 14px; cursor: pointer; position: relative; padding: 0; transition: background-color 0.3s ease; background-color: var(--divider-color); }
        .toggle.on { background-color: var(--primary-color); }
        .toggle::after { content: ""; position: absolute; width: 24px; height: 24px; border-radius: 12px; background-color: white; top: 2px; left: 2px; transition: left 0.3s ease; }
        .toggle.on::after { left: 22px; }
        .form-actions { display: flex; gap: 8px; justify-content: space-between; align-items: center; margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--divider-color); }
        .form-actions-right { display: flex; gap: 8px; }
        .preview-dialog-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.56);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 4000;
          backdrop-filter: blur(2px);
        }
        .preview-dialog {
          width: min(92vw, 1280px);
          height: min(82vh, 720px);
          max-height: calc(100vh - 48px);
          border: 0;
          border-radius: 14px;
          overflow: hidden;
          background: #000;
          position: relative;
          box-shadow: 0 14px 48px rgba(0, 0, 0, 0.45);
        }
        .preview-scene {
          position: absolute;
          inset: 0;
        }
        .preview-scene iframe,
        #yt-preview-target,
        #yt-preview-target iframe {
          width: 100%;
          height: 100%;
          border: 0;
          pointer-events: none;
        }
        .preview-overlay {
          position: absolute;
          inset: 0;
          pointer-events: none;
          background: var(--preview-overlay-gradient, none);
          transition: opacity 0.6s ease-in-out;
          z-index: 2;
        }
        .preview-overlay.no-transition {
          transition: none;
        }
        .preview-dialog-actions {
          position: absolute;
          top: 10px;
          right: 10px;
          z-index: 3;
        }
      </style>
      <div class="toolbar">
        <h2>YouTube Backgrounds</h2>
        <button id="add-mapping" class="primary">Add Mapping</button>
      </div>
      ${this._error ? `<div class="error">${this._error}</div>` : ""}
      ${cards || `<div class="muted">No mappings configured yet.</div>`}
      ${this._preview.open ? `
        <div class="preview-dialog-backdrop" data-action="close-preview">
          <div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Background preview">
            <div class="preview-dialog-actions">
              <button type="button" data-action="close-preview">Close Preview</button>
            </div>
            <div class="preview-scene">
              <div id="yt-preview-target"></div>
            </div>
            <div class="preview-overlay ${this._preview.transition === "none" ? "no-transition" : ""}" style="--preview-overlay-gradient: ${this._escapeHtml(this._preview.overlayGradient)};"></div>
          </div>
        </div>
      ` : ""}
    `;
    this._bindEvents();
  }
}

if (!customElements.get(PANEL_TAG)) {
  customElements.define(PANEL_TAG, YouTubeBackgroundPanel);
}