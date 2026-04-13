"""Constants for YouTube Background integration."""

DOMAIN = "youtube_background"
CONF_MAPPINGS = "mappings"
CONF_DASHBOARD_PATH = "dashboard_path"
CONF_VIEW_PATH = "view_path"
CONF_ENTITY_ID = "entity_id"
CONF_DEFAULT_PLAYLIST_ID = "default_playlist_id"
CONF_DEFAULT_PLAYLIST_TITLE = "default_playlist_title"
CONF_DEFAULT_PLAYLIST_ITEM_COUNT = "default_playlist_item_count"
CONF_STATE_MAP = "state_map"
CONF_ENABLED = "enabled"
CONF_MUTE = "mute"
CONF_AUTOPLAY = "autoplay"
CONF_RANDOMIZE = "randomize"
CONF_TRANSITION = "transition"
CONF_DEBUG = "debug"
CONF_FADE_CORNERS = "fade_corners"
CONF_FADE_COLOR = "fade_color"
CONF_FADE_OPACITY = "fade_opacity"
CONF_ID = "id"
CONF_YOUTUBE_API_KEY = "youtube_api_key"

# Storage
STORAGE_KEY = f"{DOMAIN}_mappings"
STORAGE_VERSION = 1

# API
API_GET_CONFIG = "get_config"
API_UPDATE_MAPPING = "update_mapping"
API_DELETE_MAPPING = "delete_mapping"
API_CREATE_MAPPING = "create_mapping"
API_SEARCH_PLAYLISTS = "search_playlists"
API_RESOLVE_PLAYLIST = "resolve_playlist"
API_GET_YOUTUBE_API_STATUS = "get_youtube_api_status"
API_GET_PLAYLIST_FALLBACK_VIDEO = "get_playlist_fallback_video"

# Services and events
SERVICE_PLAY = "play"
SERVICE_PAUSE = "pause"
EVENT_PLAY_REQUEST = f"{DOMAIN}_play"
EVENT_PAUSE_REQUEST = f"{DOMAIN}_pause"