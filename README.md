# YouTube Background for Home Assistant

This integration allows you to set YouTube playlists as backgrounds for your Lovelace dashboards/views based on Home Assistant entity states.

## Installation

1. Install via HACS (recommended) or copy the `custom_components/youtube_background` folder to your Home Assistant config directory.
2. Restart Home Assistant.
3. Add the integration in Settings > Devices & Services.
4. Optionally add a YouTube Data API key for playlist search and validation.
5. Configure mappings in the YouTube Background panel.

## YouTube API Key

An API key is optional, but strongly recommended.

Without an API key, you can still paste a playlist ID or URL manually. With an API key, the integration can:
- Search for playlists from the panel
- Validate playlist URLs and IDs
- Show playlist titles, item counts, and estimated durations

### Create an API key

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project, or select an existing one.
3. Go to **APIs & Services → Library**.
4. Search for **YouTube Data API v3** and enable it.
5. Go to **APIs & Services → Credentials**.
6. Click **Create Credentials → API key**.
7. Copy the generated API key.

### Add or update the API key in Home Assistant

1. In Home Assistant, go to **Settings → Devices & Services → Integrations**.
2. Open **YouTube Background**.
3. Click **Configure**.
4. Paste your API key and save.

## Configuration

After installing, open the **YouTube Backgrounds** panel from the Home Assistant sidebar to manage your mappings.

Each mapping can specify:
- Dashboard path
- Optional view path
- Entity ID to monitor
- Default playlist ID or playlist URL
- State-to-playlist mappings
- Mute, autoplay, shuffle, transition, and debug settings
- Corner fade gradient settings

### Dashboard path

The **Dashboard path** is the first segment of the dashboard URL.

Examples:
- `https://home.example.com/dashboard-television/lounge` → dashboard path is `dashboard-television`
- `https://home.example.com/lovelace/0` → dashboard path is `lovelace`

### View path

The **View path** is optional.

- Leave it blank to apply the background to the entire dashboard.
- Set it to a specific view path to apply the background only on that one view.

Examples:
- `https://home.example.com/dashboard-television/lounge` → view path is `lounge`
- `https://home.example.com/dashboard-television/0` → view path can be `0`

### Recommended setup flow

1. Create a mapping.
2. Choose the target **Dashboard path**.
3. Optionally choose a **View path**.
4. Paste a playlist URL or playlist ID into **Default Playlist**.
5. Click **Validate** to confirm the playlist.
6. Optionally set an **Entity ID** and add **state rules** to switch playlists dynamically.
7. Save the mapping.

### State-based playlist switching

If an entity is configured, the integration will check its current state and try to match it against your state rules.

Example:
- Entity: `input_select.house_mode`
- State `day` → daytime playlist
- State `night` → nighttime playlist
- Fallback → default playlist

### Notes

- The live background player only runs on configured dashboards and views.
- If you navigate to a dashboard or screen without a matching mapping, the player is hidden.
- The preview in the panel is designed to match the live dashboard behavior as closely as possible.

## Migration from YAML

If you were using the old YAML-based config, you can manually recreate the mappings in the panel.

## Support

For issues, please check the [GitHub repository](https://github.com/SolusCado/Background-Playlist).