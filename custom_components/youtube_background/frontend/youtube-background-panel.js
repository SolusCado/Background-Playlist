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

  async _loadInitialData() {
    await Promise.all([this._loadMappings(), this._loadDashboards(), this._loadYouTubeApiStatus()]);
    this._entityOptions = Object.keys(this._hass?.states || {}).sort();
    this._render();
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
        mute: mapping.mute !== false,
        autoplay: mapping.autoplay !== false,
        randomize: mapping.randomize !== false,
        transition: mapping.transition || "fade",
        debug: mapping.debug === true,
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
        _playlistResolvedTitle: "",
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
      _playlistResolvedTitle: "",
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
    mapping._playlistResolvedTitle = mapping._playlistResolvedTitle || "";
    this._stateSuggestions[mapping.id] = await this._extractStateSuggestions(mapping.entity_id);
    this._loadViewsForDashboard(mapping.dashboard_path);
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
      mapping._playlistResolvedTitle = "";
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

    try {
      const response = await this._hass.callWS({
        type: "youtube_background/resolve_playlist",
        value: rawValue,
      });
      const playlist = response?.playlist || {};
      mapping[fieldName] = playlist.id || rawValue;
      mapping._playlistResolvedTitle = playlist.title || "";
      mapping._playlistSearchError = "";
    } catch (error) {
      console.error(error);
      mapping._playlistSearchError = error?.message || "Could not validate playlist.";
    }

    this._render();
  }

  _applyPlaylistSearchResult(mappingId, playlistId) {
    const mapping = this._mappings.find((item) => item.id === mappingId);
    if (!mapping) {
      return;
    }

    const playlist = (mapping._playlistSearchResults || []).find((item) => item.id === playlistId);
    mapping.default_playlist_id = playlistId;
    mapping._playlistResolvedTitle = playlist?.title || "";
    mapping._playlistSearchError = "";
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

    const origin = window.location.origin || "";
    const query = new URLSearchParams({
      list: playlistId,
      autoplay: mapping.autoplay !== false ? "1" : "0",
      mute: mapping.mute !== false ? "1" : "0",
      controls: "0",
      loop: "1",
      playlist: playlistId,
      modestbranding: "1",
      rel: "0",
      playsinline: "1",
      enablejsapi: "1",
      origin,
    });

    if (mapping.randomize !== false) {
      query.set("index", String(Math.floor(Math.random() * 50)));
    }

    this._preview = {
      open: true,
      embedUrl: `https://www.youtube.com/embed/videoseries?${query.toString()}`,
      overlayGradient: this._buildOverlayGradient(mapping),
      transition: mapping.transition === "none" ? "none" : "fade",
    };
    this._error = "";
    this._render();
  }

  _closePreview() {
    this._preview = {
      open: false,
      embedUrl: "",
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
      enabled: !!mapping.enabled,
      dashboard_path: (mapping.dashboard_path || "").trim(),
      view_path: (mapping.view_path || "").trim(),
      entity_id: (mapping.entity_id || "").trim(),
      default_playlist_id: (mapping.default_playlist_id || "").trim(),
      state_map: mapping.state_map || {},
      mute: !!mapping.mute,
      autoplay: !!mapping.autoplay,
      randomize: !!mapping.randomize,
      transition: mapping.transition || "fade",
      debug: !!mapping.debug,
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
        mapping[field] = !mapping[field];
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
        if (action === "use-playlist") this._applyPlaylistSearchResult(mappingId, playlistId);
        if (action === "clear-entity") this._clearEntity(mappingId);
        if (action === "preview") this._openPreview(mappingId);
        if (action === "close-preview") this._closePreview();
      });
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
        if (field === "fade_opacity") {
          return;
        }
        const value = event.currentTarget.type === "checkbox"
          ? event.currentTarget.checked
          : event.currentTarget.value;
        await this._updateField(mappingId, field, value);
      });
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

    if (!mapping._isEditing) {
      return `
        <div class="card">
          <div class="header-row">
            <div>
              <h3>${mapping.dashboard_path || "(no dashboard)"}${mapping.view_path ? ` / ${mapping.view_path}` : ""}</h3>
              <div class="meta">Entity: ${mapping.entity_id || "-"}</div>
            </div>
            <div class="actions">
              <button data-action="edit" data-mapping-id="${mapping.id}">Edit</button>
              <button class="danger" data-action="delete" data-mapping-id="${mapping.id}">Delete</button>
            </div>
          </div>
          <div class="summary-grid">
            <div><strong>Default Playlist:</strong> ${mapping.default_playlist_id || "-"}</div>
            <div><strong>Enabled:</strong> ${mapping.enabled ? "Yes" : "No"}</div>
              <div><strong>Autoplay:</strong> ${mapping.autoplay !== false ? "Yes" : "No"}</div>
              <div><strong>Muted:</strong> ${mapping.mute !== false ? "Yes" : "No"}</div>
              <div><strong>Transition:</strong> ${mapping.transition || "fade"}</div>
            <div><strong>State Rules:</strong> ${stateRows.length}</div>
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
                <input type="text" value="${mapping.default_playlist_id || ""}" data-field="default_playlist_id" data-mapping-id="${mapping.id}" placeholder="Playlist URL or ID" />
                <button type="button" data-action="resolve-playlist" data-mapping-id="${mapping.id}">Validate</button>
              </div>
              ${mapping._playlistResolvedTitle ? `<div class="field-note">Selected: ${this._escapeHtml(mapping._playlistResolvedTitle)}</div>` : ""}
              ${this._youtubeApiConfigured ? `
                <div class="playlist-search-row">
                  <input type="text" value="${mapping._playlistSearchQuery || ""}" data-field="_playlistSearchQuery" data-mapping-id="${mapping.id}" placeholder="Search YouTube playlists" />
                  <button type="button" data-action="search-playlists" data-mapping-id="${mapping.id}" ${mapping._playlistSearchBusy ? "disabled" : ""}>${mapping._playlistSearchBusy ? "Searching..." : "Search"}</button>
                </div>
                ${searchResults.length ? `
                  <div class="playlist-results">
                    ${searchResults
                      .map(
                        (item) => `
                          <div class="playlist-result-item">
                            <div>
                              <div class="playlist-result-title">${this._escapeHtml(item.title)}</div>
                              <div class="playlist-result-meta">${this._escapeHtml(item.channel_title || "")}${item.item_count != null ? ` • ${item.item_count} items` : ""}</div>
                            </div>
                            <button type="button" data-action="use-playlist" data-mapping-id="${mapping.id}" data-playlist-id="${item.id}">Use</button>
                          </div>
                        `
                      )
                      .join("")}
                  </div>
                ` : ""}
              ` : `<div class="field-note">Add a YouTube Data API key in the integration options to search playlists by name.</div>`}
              <div class="field-note">Browse playlists: <a class="playlist-link" href="https://www.youtube.com/@BaileyPoint/playlists" target="_blank" rel="noopener noreferrer">youtube.com/@BaileyPoint/playlists</a></div>
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
                <button class="toggle ${mapping.randomize !== false ? "on" : "off"}" data-toggle-field="randomize" data-mapping-id="${mapping.id}" type="button" role="switch" aria-checked="${mapping.randomize !== false}" aria-label="Randomize Playlist"></button>
                <span>Randomize Playlist</span>
              </div>
            </div>

            <label>Transition</label>
            <select data-field="transition" data-mapping-id="${mapping.id}">
              <option value="fade" ${!mapping.transition || mapping.transition === "fade" ? "selected" : ""}>Fade</option>
              <option value="none" ${mapping.transition === "none" ? "selected" : ""}>None</option>
            </select>

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
          <h4>State → Playlist Mappings</h4>
          ${knownStates.length ? `<div class="known-states">${knownStates.length === 1 ? "Current State" : "Known States"}: ${knownStates.join(", ")}</div>` : ""}
          <div class="state-add-row">
            <input type="text" value="${mapping._newStateKey || ""}" data-field="_newStateKey" data-mapping-id="${mapping.id}" placeholder="state (e.g. sunny)" />
            <input type="text" value="${mapping._newStatePlaylist || ""}" data-field="_newStatePlaylist" data-mapping-id="${mapping.id}" placeholder="playlist URL or ID" />
            <button data-action="add-state" data-mapping-id="${mapping.id}">Add</button>
          </div>

          <table>
            <thead><tr><th>State</th><th>Playlist ID</th><th></th></tr></thead>
            <tbody>
              ${stateRows
                .map(
                  ([stateKey, playlistId]) => `
                    <tr>
                      <td>${stateKey}</td>
                      <td>${playlistId}</td>
                      <td><button class="danger" data-action="remove-state" data-state-key="${stateKey}" data-mapping-id="${mapping.id}">Remove</button></td>
                    </tr>`
                )
                .join("") || `<tr><td colspan="3" class="muted">No state rules yet.</td></tr>`}
            </tbody>
          </table>
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
        .header-row { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
        .header-row h3 { margin:0; }
        .actions { display:flex; gap:8px; }
        button { background: transparent; color: var(--primary-text-color); border: 1px solid var(--divider-color); border-radius: 8px; padding: 6px 10px; cursor: pointer; }
        button.primary { background: var(--primary-color); color: var(--text-primary-color); border-color: var(--primary-color); }
        button.danger { border-color: var(--error-color); color: var(--error-color); }
        .summary-grid { margin-top: 10px; display:grid; gap:8px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
        .form-grid { margin-top: 12px; display:grid; grid-template-columns: 160px 1fr; gap:10px; align-items:start; }
        .form-grid input[type='text'], .form-grid select { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 8px; border: 1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color); margin-bottom: 6px; }
        .form-grid .entity-selector-host { display: block; width: 100%; margin-bottom: 6px; }
        .form-grid .entity-selector-host > * { display: block; width: 100%; }
        .field-note { color: var(--secondary-text-color); font-size: 0.9rem; }
        .playlist-input-row, .playlist-search-row { display:grid; grid-template-columns: 1fr auto; gap:8px; margin-bottom: 6px; }
        .playlist-results { border: 1px solid var(--divider-color); border-radius: 8px; overflow: hidden; margin-bottom: 6px; }
        .playlist-result-item { display:flex; justify-content:space-between; align-items:center; gap:12px; padding: 10px; border-bottom: 1px solid var(--divider-color); }
        .playlist-result-item:last-child { border-bottom: none; }
        .playlist-result-title { font-weight: 600; }
        .playlist-result-meta { color: var(--secondary-text-color); font-size: 0.9rem; }
        .playlist-link { color: var(--primary-color); text-decoration: underline; }
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
        .known-states { color: var(--secondary-text-color); margin-bottom: 8px; }
        .state-add-row { display:grid; grid-template-columns: 1fr 2fr auto; gap:8px; margin-bottom: 10px; }
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
          background: transparent;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }
        .preview-dialog {
          width: 100vw;
          height: 100vh;
          border: 0;
          border-radius: 0;
          overflow: hidden;
          background: #000;
          position: fixed;
          inset: 0;
          z-index: 2;
          box-shadow: none;
        }
        .preview-scene {
          position: absolute;
          inset: 0;
        }
        .preview-scene iframe {
          aspect-ratio: 16 / 9;
          height: 100vh;
          width: initial;
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          border: 0;
          pointer-events: none;
        }
        .preview-overlay {
          position: fixed;
          inset: 0;
          width: 100vw;
          height: 100vh;
          pointer-events: none;
          background: var(--preview-overlay-gradient, none);
          transition: opacity 0.6s ease-in-out;
          z-index: 1;
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
        <div class="preview-dialog-backdrop">
          <div class="preview-overlay ${this._preview.transition === "none" ? "no-transition" : ""}" style="--preview-overlay-gradient: ${this._escapeHtml(this._preview.overlayGradient)};"></div>
          <div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Background preview">
            <div class="preview-dialog-actions">
              <button type="button" data-action="close-preview">Close Preview</button>
            </div>
            <div class="preview-scene">
              <iframe src="${this._escapeHtml(this._preview.embedUrl)}" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="origin-when-cross-origin"></iframe>
            </div>
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