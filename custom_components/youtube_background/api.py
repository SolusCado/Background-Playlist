"""YouTube Data API helpers for YouTube Background."""
from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs, urlparse

from aiohttp import ClientError

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"


class YouTubeApiError(Exception):
    """Raised when the YouTube Data API request fails."""


def extract_playlist_id(value: str | None) -> str:
    """Extract a playlist ID from a raw ID or a YouTube URL."""
    raw_value = (value or "").strip()
    if not raw_value:
        return ""

    if "youtube.com" not in raw_value and "youtu.be" not in raw_value:
        return raw_value

    parsed = urlparse(raw_value)
    params = parse_qs(parsed.query)
    playlist_id = params.get("list", [""])[0].strip()
    return playlist_id or raw_value


async def async_search_playlists(
    hass: HomeAssistant,
    api_key: str,
    query: str,
    max_results: int = 10,
) -> list[dict[str, Any]]:
    """Search YouTube playlists by query string."""
    search_payload = await _async_request_json(
        hass,
        "/search",
        {
            "part": "snippet",
            "type": "playlist",
            "q": query,
            "maxResults": min(max(max_results, 1), 25),
            "key": api_key,
        },
    )

    items = search_payload.get("items", [])
    playlist_ids = [
        item.get("id", {}).get("playlistId")
        for item in items
        if item.get("id", {}).get("playlistId")
    ]
    details_by_id = await async_get_playlist_details_bulk(hass, api_key, playlist_ids)

    results: list[dict[str, Any]] = []
    for item in items:
        playlist_id = item.get("id", {}).get("playlistId")
        if not playlist_id:
            continue

        snippet = item.get("snippet", {})
        details = details_by_id.get(playlist_id, {})
        thumbnails = snippet.get("thumbnails", {})
        thumbnail = (
            thumbnails.get("medium", {}).get("url")
            or thumbnails.get("default", {}).get("url")
            or thumbnails.get("high", {}).get("url")
        )
        results.append(
            {
                "id": playlist_id,
                "title": snippet.get("title", playlist_id),
                "description": snippet.get("description", ""),
                "channel_title": snippet.get("channelTitle", ""),
                "thumbnail_url": thumbnail,
                "item_count": details.get("item_count"),
            }
        )

    return results


async def async_resolve_playlist(
    hass: HomeAssistant,
    api_key: str,
    value: str,
) -> dict[str, Any]:
    """Resolve a playlist URL or ID into normalized playlist metadata."""
    playlist_id = extract_playlist_id(value)
    if not playlist_id:
        raise YouTubeApiError("Enter a playlist URL or playlist ID.")

    details = await async_get_playlist_details_bulk(hass, api_key, [playlist_id])
    playlist = details.get(playlist_id)
    if not playlist:
        raise YouTubeApiError("Playlist not found or not accessible with this API key.")

    return {
        "id": playlist_id,
        **playlist,
    }


async def async_get_playlist_details_bulk(
    hass: HomeAssistant,
    api_key: str,
    playlist_ids: list[str],
) -> dict[str, dict[str, Any]]:
    """Return playlist metadata for the provided IDs."""
    normalized_ids = [playlist_id for playlist_id in playlist_ids if playlist_id]
    if not normalized_ids:
        return {}

    payload = await _async_request_json(
        hass,
        "/playlists",
        {
            "part": "snippet,contentDetails",
            "id": ",".join(normalized_ids),
            "maxResults": min(len(normalized_ids), 50),
            "key": api_key,
        },
    )

    details: dict[str, dict[str, Any]] = {}
    for item in payload.get("items", []):
        playlist_id = item.get("id")
        if not playlist_id:
            continue

        snippet = item.get("snippet", {})
        content = item.get("contentDetails", {})
        thumbnails = snippet.get("thumbnails", {})
        details[playlist_id] = {
            "title": snippet.get("title", playlist_id),
            "description": snippet.get("description", ""),
            "channel_title": snippet.get("channelTitle", ""),
            "item_count": content.get("itemCount"),
            "thumbnail_url": (
                thumbnails.get("medium", {}).get("url")
                or thumbnails.get("default", {}).get("url")
                or thumbnails.get("high", {}).get("url")
            ),
        }

    return details


async def _async_request_json(
    hass: HomeAssistant,
    endpoint: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Perform a YouTube Data API request and return JSON."""
    session = async_get_clientsession(hass)
    try:
        async with session.get(f"{YOUTUBE_API_BASE}{endpoint}", params=params) as response:
            payload = await response.json(content_type=None)
    except (ClientError, TimeoutError) as err:
        raise YouTubeApiError("Unable to reach the YouTube Data API.") from err

    if response.status >= 400:
        message = payload.get("error", {}).get("message") or "YouTube API request failed."
        raise YouTubeApiError(message)

    return payload