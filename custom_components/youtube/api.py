"""YouTube Data API helpers for YouTube Background."""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, urlparse

from aiohttp import ClientError

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"
ISO8601_DURATION_RE = re.compile(
    r"^P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)?$"
)


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

    estimated_seconds, sampled_items = await async_estimate_playlist_duration(
        hass,
        api_key,
        playlist_id,
        int(playlist.get("item_count") or 0),
    )

    return {
        "id": playlist_id,
        **playlist,
        "estimated_duration_seconds": estimated_seconds,
        "estimated_duration_text": _format_duration_human(estimated_seconds),
        "duration_sampled_items": sampled_items,
    }


async def async_estimate_playlist_duration(
    hass: HomeAssistant,
    api_key: str,
    playlist_id: str,
    total_items: int,
    max_sample_items: int = 500,
) -> tuple[int, int]:
    """Estimate total playlist duration in seconds.

    Reads up to ``max_sample_items`` playlist entries and scales the duration if
    the playlist is larger than the sampled set.
    """
    if not playlist_id:
        return 0, 0

    video_ids: list[str] = []
    page_token = ""

    while True:
        remaining = max_sample_items - len(video_ids)
        if remaining <= 0:
            break

        payload = await _async_request_json(
            hass,
            "/playlistItems",
            {
                "part": "contentDetails",
                "playlistId": playlist_id,
                "maxResults": min(50, remaining),
                "pageToken": page_token,
                "key": api_key,
            },
        )

        for item in payload.get("items", []):
            content = item.get("contentDetails", {})
            video_id = content.get("videoId")
            if video_id:
                video_ids.append(video_id)

        page_token = payload.get("nextPageToken", "")
        if not page_token:
            break

    if not video_ids:
        return 0, 0

    sampled_seconds = 0
    for start in range(0, len(video_ids), 50):
        chunk = video_ids[start : start + 50]
        payload = await _async_request_json(
            hass,
            "/videos",
            {
                "part": "contentDetails",
                "id": ",".join(chunk),
                "maxResults": 50,
                "key": api_key,
            },
        )

        for item in payload.get("items", []):
            duration = item.get("contentDetails", {}).get("duration", "")
            sampled_seconds += _parse_iso8601_duration_seconds(duration)

    sampled_items = len(video_ids)
    if total_items > sampled_items and sampled_items > 0:
        ratio = total_items / sampled_items
        estimated_seconds = int(round(sampled_seconds * ratio))
        return estimated_seconds, sampled_items

    return sampled_seconds, sampled_items


def _parse_iso8601_duration_seconds(value: str) -> int:
    """Parse an ISO-8601 duration into total seconds."""
    match = ISO8601_DURATION_RE.match(value or "")
    if not match:
        return 0

    days = int(match.group("days") or 0)
    hours = int(match.group("hours") or 0)
    minutes = int(match.group("minutes") or 0)
    seconds = int(match.group("seconds") or 0)
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def _format_duration_human(total_seconds: int) -> str:
    """Format seconds to a compact human-readable duration."""
    seconds = max(int(total_seconds or 0), 0)
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)

    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


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