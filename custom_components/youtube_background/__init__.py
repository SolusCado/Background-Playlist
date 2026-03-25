"""YouTube Background integration for Home Assistant."""
from __future__ import annotations

import json
import logging
import inspect
from pathlib import Path
from typing import Any
from uuid import uuid4

import voluptuous as vol

from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.frontend import (
    add_extra_js_url,
    async_register_built_in_panel,
    async_remove_panel,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType

from .api import (
    YouTubeApiError,
    async_get_playlist_fallback_video,
    async_resolve_playlist,
    async_search_playlists,
    extract_playlist_id,
)
from .const import (
    API_GET_YOUTUBE_API_STATUS,
    API_GET_PLAYLIST_FALLBACK_VIDEO,
    CONF_AUTOPLAY,
    CONF_DASHBOARD_PATH,
    CONF_DEBUG,
    CONF_DEFAULT_PLAYLIST_ID,
    CONF_DEFAULT_PLAYLIST_TITLE,
    CONF_ENABLED,
    CONF_ENTITY_ID,
    CONF_FADE_COLOR,
    CONF_FADE_CORNERS,
    CONF_FADE_OPACITY,
    CONF_ID,
    CONF_MAPPINGS,
    CONF_MUTE,
    CONF_RANDOMIZE,
    CONF_STATE_MAP,
    CONF_TRANSITION,
    CONF_VIEW_PATH,
    CONF_YOUTUBE_API_KEY,
    DOMAIN,
    STORAGE_KEY,
    STORAGE_VERSION,
)

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
STATIC_URL_BASE = "/youtube_background_static"
PANEL_URL_PATH = "youtube-background"
PANEL_STATIC_URL = f"{STATIC_URL_BASE}/youtube-background-panel.js"
RUNTIME_STATIC_URL = f"{STATIC_URL_BASE}/youtube-background-runtime.js"
PANEL_JS = "youtube-background-panel"


def _load_asset_version() -> str:
    """Load frontend asset version from manifest.json."""
    manifest_path = Path(__file__).with_name("manifest.json")
    try:
        with manifest_path.open("r", encoding="utf-8") as manifest_file:
            manifest = json.load(manifest_file)
        version = str(manifest.get("version", "")).strip()
        return version or "dev"
    except Exception:
        _LOGGER.exception("Failed to load asset version from %s", manifest_path)
        return "dev"


ASSET_VERSION = _load_asset_version()


class YouTubeBackgroundData:
    """Store YouTube Background data."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the data store."""
        self.hass = hass
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._mappings: list[dict[str, Any]] = []

    async def async_load(self) -> None:
        """Load data from storage."""
        data = await self._store.async_load()
        if not data:
            self._mappings = []
            return

        raw_mappings = data.get(CONF_MAPPINGS, [])
        if not isinstance(raw_mappings, list):
            raw_mappings = []

        migrated: list[dict[str, Any]] = []
        changed = False

        for raw in raw_mappings:
            if not isinstance(raw, dict):
                changed = True
                continue

            prepared = _prepare_mapping(raw)
            migrated.append(prepared)
            if prepared != raw:
                changed = True

        self._mappings = migrated

        if changed:
            await self.async_save()

    async def async_save(self) -> None:
        """Save data to storage."""
        await self._store.async_save({CONF_MAPPINGS: self._mappings})

    def get_mappings(self) -> list[dict[str, Any]]:
        """Get all mappings."""
        return [dict(mapping) for mapping in self._mappings]

    def get_mapping_for_dashboard(
        self, dashboard_path: str, view_path: str | None = None
    ) -> dict[str, Any] | None:
        """Get mapping for a specific dashboard/view."""
        normalized_dashboard = (dashboard_path or "").strip("/")
        normalized_view = (view_path or "").strip("/")

        fallback_mapping: dict[str, Any] | None = None
        for mapping in self._mappings:
            if not mapping.get(CONF_ENABLED, True):
                continue

            mapping_dashboard = (mapping.get(CONF_DASHBOARD_PATH) or "").strip("/")
            mapping_view = (mapping.get(CONF_VIEW_PATH) or "").strip("/")

            if not _dashboard_paths_match(mapping_dashboard, normalized_dashboard):
                continue

            if mapping_view and mapping_view == normalized_view:
                return dict(mapping)

            if not mapping_view and fallback_mapping is None:
                fallback_mapping = dict(mapping)

        return fallback_mapping

    def create_mapping(self, mapping: dict[str, Any]) -> dict[str, Any]:
        """Create a new mapping."""
        prepared = _prepare_mapping(mapping)
        self._mappings.append(prepared)
        return dict(prepared)

    def update_mapping(self, mapping_id: str, updates: dict[str, Any]) -> bool:
        """Update an existing mapping."""
        for i, mapping in enumerate(self._mappings):
            if mapping[CONF_ID] == mapping_id:
                merged = dict(mapping)
                merged.update(updates)
                merged[CONF_ID] = mapping_id
                self._mappings[i] = _prepare_mapping(merged)
                return True
        return False

    def delete_mapping(self, mapping_id: str) -> bool:
        """Delete a mapping."""
        for i, mapping in enumerate(self._mappings):
            if mapping[CONF_ID] == mapping_id:
                del self._mappings[i]
                return True
        return False


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the YouTube Background integration."""
    hass.data[DOMAIN] = YouTubeBackgroundData(hass)
    await hass.data[DOMAIN].async_load()
    await async_register_websocket_commands(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up YouTube Background from a config entry."""
    try:
        await _async_register_static_assets(hass)
        _async_remove_existing_panel(hass)
        async_register_built_in_panel(
            hass=hass,
            component_name="custom",
            sidebar_title="YouTube Backgrounds",
            sidebar_icon="mdi:youtube-tv",
            frontend_url_path=PANEL_URL_PATH,
            require_admin=True,
            config={
                "_panel_custom": {
                    "name": PANEL_JS,
                    "js_url": f"{PANEL_STATIC_URL}?v={ASSET_VERSION}",
                }
            },
            update=True,
        )

        add_extra_js_url(hass, f"{RUNTIME_STATIC_URL}?v={ASSET_VERSION}")
    except Exception:
        _LOGGER.exception("Failed to set up entry for %s", DOMAIN)
        return False

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    _async_remove_existing_panel(hass)
    return True


# WebSocket API
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/get_config",
        vol.Required("dashboard_path"): cv.string,
        vol.Optional("view_path", default=""): cv.string,
    }
)
@websocket_api.async_response
async def websocket_get_config(hass: HomeAssistant, connection, msg):
    """Handle get config websocket command."""
    dashboard_path = msg.get("dashboard_path")
    view_path = msg.get("view_path")
    data: YouTubeBackgroundData = hass.data[DOMAIN]
    mapping = data.get_mapping_for_dashboard(
        _normalize_dashboard_path(dashboard_path), _normalize_view_path(view_path)
    )
    connection.send_result(msg["id"], {"config": mapping})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/create_mapping",
        vol.Required("mapping"): dict,
    }
)
@websocket_api.async_response
async def websocket_create_mapping(hass: HomeAssistant, connection, msg):
    """Handle create mapping websocket command."""
    data: YouTubeBackgroundData = hass.data[DOMAIN]
    mapping = msg.get("mapping")
    created = data.create_mapping(mapping)
    await data.async_save()
    connection.send_result(msg["id"], {"success": True, "mapping": created})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/update_mapping",
        vol.Required("mapping_id"): cv.string,
        vol.Required("updates"): dict,
    }
)
@websocket_api.async_response
async def websocket_update_mapping(hass: HomeAssistant, connection, msg):
    """Handle update mapping websocket command."""
    data: YouTubeBackgroundData = hass.data[DOMAIN]
    mapping_id = msg.get("mapping_id")
    updates = msg.get("updates")
    success = data.update_mapping(mapping_id, updates)
    if success:
        await data.async_save()
    connection.send_result(msg["id"], {"success": success})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/get_mappings"})
@websocket_api.async_response
async def websocket_get_mappings(hass: HomeAssistant, connection, msg):
    """Handle get all mappings websocket command."""
    data: YouTubeBackgroundData = hass.data[DOMAIN]
    mappings = data.get_mappings()
    connection.send_result(msg["id"], {"mappings": mappings})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/{API_GET_YOUTUBE_API_STATUS}"})
@websocket_api.async_response
async def websocket_get_youtube_api_status(hass: HomeAssistant, connection, msg):
    """Return whether a YouTube Data API key is configured."""
    connection.send_result(
        msg["id"],
        {"configured": bool(_get_youtube_api_key(hass))},
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/search_playlists",
        vol.Required("query"): cv.string,
        vol.Optional("max_results", default=8): vol.All(vol.Coerce(int), vol.Range(min=1, max=25)),
    }
)
@websocket_api.async_response
async def websocket_search_playlists(hass: HomeAssistant, connection, msg):
    """Search YouTube playlists via the Data API."""
    api_key = _get_youtube_api_key(hass)
    if not api_key:
        connection.send_error(
            msg["id"],
            "missing_api_key",
            "Configure a YouTube Data API key in the integration options to search playlists.",
        )
        return

    try:
        items = await async_search_playlists(
            hass,
            api_key,
            msg["query"],
            msg.get("max_results", 8),
        )
    except YouTubeApiError as err:
        connection.send_error(msg["id"], "youtube_api_error", str(err))
        return

    connection.send_result(msg["id"], {"items": items})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/resolve_playlist",
        vol.Required("value"): cv.string,
    }
)
@websocket_api.async_response
async def websocket_resolve_playlist(hass: HomeAssistant, connection, msg):
    """Resolve a playlist URL or ID into normalized metadata."""
    api_key = _get_youtube_api_key(hass)
    value = msg["value"]
    normalized_id = extract_playlist_id(value)

    if api_key:
        try:
            playlist = await async_resolve_playlist(hass, api_key, value)
        except YouTubeApiError as err:
            connection.send_error(msg["id"], "youtube_api_error", str(err))
            return
        connection.send_result(msg["id"], {"playlist": playlist})
        return

    if not normalized_id:
        connection.send_error(msg["id"], "invalid_playlist", "Enter a valid playlist URL or playlist ID.")
        return

    connection.send_result(msg["id"], {"playlist": {"id": normalized_id}})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/{API_GET_PLAYLIST_FALLBACK_VIDEO}",
        vol.Required("playlist_id"): cv.string,
    }
)
@websocket_api.async_response
async def websocket_get_playlist_fallback_video(hass: HomeAssistant, connection, msg):
    """Resolve an embeddable fallback video from a playlist."""
    api_key = _get_youtube_api_key(hass)
    if not api_key:
        connection.send_error(
            msg["id"],
            "missing_api_key",
            "Configure a YouTube Data API key in the integration options to enable fallback video resolution.",
        )
        return

    try:
        video_id = await async_get_playlist_fallback_video(hass, api_key, msg["playlist_id"])
    except YouTubeApiError as err:
        connection.send_error(msg["id"], "youtube_api_error", str(err))
        return

    connection.send_result(msg["id"], {"video_id": video_id or ""})


async def async_register_websocket_commands(hass: HomeAssistant):
    """Register websocket commands."""
    websocket_api.async_register_command(hass, websocket_get_config)
    websocket_api.async_register_command(hass, websocket_create_mapping)
    websocket_api.async_register_command(hass, websocket_update_mapping)
    websocket_api.async_register_command(hass, websocket_delete_mapping)
    websocket_api.async_register_command(hass, websocket_get_mappings)
    websocket_api.async_register_command(hass, websocket_get_youtube_api_status)
    websocket_api.async_register_command(hass, websocket_search_playlists)
    websocket_api.async_register_command(hass, websocket_resolve_playlist)
    websocket_api.async_register_command(hass, websocket_get_playlist_fallback_video)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/delete_mapping",
        vol.Required("mapping_id"): cv.string,
    }
)
@websocket_api.async_response
async def websocket_delete_mapping(hass: HomeAssistant, connection, msg):
    """Handle delete mapping websocket command."""
    data: YouTubeBackgroundData = hass.data[DOMAIN]
    mapping_id = msg.get("mapping_id")
    success = data.delete_mapping(mapping_id)
    if success:
        await data.async_save()
    connection.send_result(msg["id"], {"success": success})


def _normalize_dashboard_path(path: str) -> str:
    """Normalize dashboard path — strip leading/trailing slashes only."""
    return (path or "").strip().strip("/")


def _dashboard_paths_match(stored: str, requested: str) -> bool:
    """Match dashboard paths tolerantly — treat 'foo' and 'dashboard-foo' as equal."""
    def _bare(p: str) -> str:
        p = (p or "").strip().strip("/")
        return p[len("dashboard-"):] if p.startswith("dashboard-") else p
    return stored == requested or _bare(stored) == _bare(requested)


def _normalize_view_path(path: str | None) -> str | None:
    """Normalize view path."""
    if path is None:
        return None
    return path.strip().strip("/")


def _prepare_mapping(mapping: dict[str, Any]) -> dict[str, Any]:
    """Prepare and validate a mapping payload."""
    mapping_id = mapping.get(CONF_ID) or str(uuid4())
    dashboard_path = _normalize_dashboard_path(mapping.get(CONF_DASHBOARD_PATH, ""))
    view_path = _normalize_view_path(mapping.get(CONF_VIEW_PATH, ""))
    entity_id = (mapping.get(CONF_ENTITY_ID) or "").strip().lower()
    default_playlist_id = _normalize_playlist_value(mapping.get(CONF_DEFAULT_PLAYLIST_ID))
    default_playlist_title = str(mapping.get(CONF_DEFAULT_PLAYLIST_TITLE) or "").strip()

    state_map_in = mapping.get(CONF_STATE_MAP) or {}
    state_map: dict[str, str] = {}
    if isinstance(state_map_in, dict):
        for raw_state, raw_playlist in state_map_in.items():
            state_key = str(raw_state).strip().lower()
            playlist_value = _normalize_playlist_value(raw_playlist)
            if state_key and playlist_value:
                state_map[state_key] = playlist_value

    raw_corners = mapping.get(CONF_FADE_CORNERS) or []
    allowed_corners = {"top_left", "top_right", "bottom_left", "bottom_right"}
    fade_corners: list[str] = []
    if isinstance(raw_corners, list):
        for corner in raw_corners:
            corner_value = str(corner).strip().lower()
            if corner_value in allowed_corners and corner_value not in fade_corners:
                fade_corners.append(corner_value)

    raw_color = str(mapping.get(CONF_FADE_COLOR, "#000000") or "#000000").strip().lower()
    if not raw_color.startswith("#"):
        raw_color = f"#{raw_color}"
    if len(raw_color) != 7 or any(c not in "0123456789abcdef#" for c in raw_color):
        raw_color = "#000000"

    try:
        fade_opacity = float(mapping.get(CONF_FADE_OPACITY, 50))
    except (TypeError, ValueError):
        fade_opacity = 50.0
    fade_opacity = max(0.0, min(100.0, fade_opacity))

    return {
        CONF_ID: mapping_id,
        CONF_ENABLED: _to_bool(mapping.get(CONF_ENABLED), True),
        CONF_DASHBOARD_PATH: dashboard_path,
        CONF_VIEW_PATH: view_path or "",
        CONF_ENTITY_ID: entity_id,
        CONF_DEFAULT_PLAYLIST_ID: default_playlist_id,
        CONF_DEFAULT_PLAYLIST_TITLE: default_playlist_title,
        CONF_STATE_MAP: state_map,
        CONF_MUTE: _to_bool(mapping.get(CONF_MUTE), True),
        CONF_AUTOPLAY: _to_bool(mapping.get(CONF_AUTOPLAY), True),
        CONF_RANDOMIZE: _to_bool(mapping.get(CONF_RANDOMIZE), True),
        CONF_TRANSITION: str(mapping.get(CONF_TRANSITION, "fade") or "fade").strip() or "fade",
        CONF_DEBUG: _to_bool(mapping.get(CONF_DEBUG), False),
        CONF_FADE_CORNERS: fade_corners,
        CONF_FADE_COLOR: raw_color,
        CONF_FADE_OPACITY: fade_opacity,
    }


def _async_remove_existing_panel(hass: HomeAssistant) -> None:
    """Remove the registered panel if it already exists."""
    try:
        async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    except Exception:
        _LOGGER.debug("Panel removal skipped or failed", exc_info=True)


def _get_youtube_api_key(hass: HomeAssistant) -> str:
    """Return the configured YouTube Data API key, if any."""
    for entry in hass.config_entries.async_entries(DOMAIN):
        api_key = entry.options.get(CONF_YOUTUBE_API_KEY, entry.data.get(CONF_YOUTUBE_API_KEY, ""))
        if api_key:
            return str(api_key).strip()
    return ""


def _normalize_playlist_value(value: Any) -> str:
    """Normalize a playlist field to a raw playlist ID when possible."""
    return extract_playlist_id(str(value).strip()) if value is not None else ""


def _to_bool(value: Any, default: bool) -> bool:
    """Convert different value shapes to bool with safe string handling."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off", ""}:
            return False
    return bool(value)


async def _async_register_static_assets(hass: HomeAssistant) -> None:
    """Register static assets and dashboard runtime module."""
    root = Path(__file__).parent / "frontend"
    if not root.exists():
        _LOGGER.error("Frontend assets folder missing: %s", root)
        return

    panel_path = str(root / "youtube-background-panel.js")
    runtime_path = str(root / "youtube-background-runtime.js")

    register_many = getattr(hass.http, "async_register_static_paths", None)
    if callable(register_many):
        try:
            from homeassistant.components.http import StaticPathConfig

            maybe_result = register_many(
                [
                    StaticPathConfig(PANEL_STATIC_URL, panel_path, cache_headers=False),
                    StaticPathConfig(RUNTIME_STATIC_URL, runtime_path, cache_headers=False),
                ]
            )
            if inspect.isawaitable(maybe_result):
                await maybe_result
            return
        except Exception:
            _LOGGER.exception("Failed static registration via async_register_static_paths")

    register_one = getattr(hass.http, "async_register_static_path", None)
    if callable(register_one):
        try:
            maybe_result = register_one(PANEL_STATIC_URL, panel_path, cache_headers=False)
            if inspect.isawaitable(maybe_result):
                await maybe_result
            maybe_result = register_one(RUNTIME_STATIC_URL, runtime_path, cache_headers=False)
            if inspect.isawaitable(maybe_result):
                await maybe_result
            return
        except Exception:
            _LOGGER.exception("Failed static registration via async_register_static_path")

    _LOGGER.error("No supported static path registration API found on hass.http")