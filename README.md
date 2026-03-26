# YouTube Background for Home Assistant

This integration allows you to set YouTube playlists as backgrounds for your Lovelace dashboards/views based on Home Assistant entity states.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=SolusCado&repository=Background-Playlist&category=Integration)

## Installation

### Option 1: HACS (Recommended)

#### Install from default HACS store

1. In Home Assistant, go to **Settings → Devices & Services → Integrations**.
2. Click the **Explore & Download** button in HACS.
3. Search for **YouTube Background** in HACS.
4. Click **Install**.
5. Restart Home Assistant.
6. Go to **Settings → Devices & Services** and click **Create Integration** to add **YouTube Background**.

#### Or add as custom repository

1. In HACS, click the menu (⋮) in the top right and select **Custom repositories**.
2. Paste this URL: `https://github.com/SolusCado/Background-Playlist`
3. Select **Integration** as the category.
4. Click **Create**.
5. Search for **YouTube Background** and click **Install**.
6. Restart Home Assistant.
7. Go to **Settings → Devices & Services** and click **Create Integration** to add **YouTube Background**.

### Option 2: Manual Installation

1. Download the repository as a ZIP file from [GitHub](https://github.com/SolusCado/Background-Playlist) (or clone it).
2. Extract the `youtube_background` folder from `custom_components/`.
3. Copy it to your Home Assistant `config/custom_components/` directory.
4. Restart Home Assistant.
5. Go to **Settings → Devices & Services** and click **Create Integration** to add **YouTube Background**.

### Option 3: Mac Kiosk App

For macOS users who want to run Home Assistant in kiosk mode, this repository also includes a packaged desktop app:

- Release asset: `Desktop-Kiosk-macOS-universal.zip`
- Checksum asset: `Desktop-Kiosk-macOS-universal.zip.sha256`

This app is intended for dedicated wall displays, desktops, or always-on dashboard screens where you want Home Assistant to launch in a focused kiosk-style window. It also works well for running your Home Assistant dashboard as your desktop wallpaper on macOS.

#### Launch the Mac kiosk app

1. Open the latest [GitHub release](https://github.com/SolusCado/Background-Playlist/releases/latest) and download `Desktop-Kiosk-macOS-universal.zip`.
2. Extract the ZIP archive.
3. Move `Desktop Kiosk.app` into your `Applications` folder if you want to keep it installed.
4. Open the app and point it at your Home Assistant instance.
5. If macOS warns that the app was downloaded from the internet, open it from **System Settings → Privacy & Security** or by Control-clicking the app and choosing **Open**.

### API Key Setup (Optional but Recommended)

An API key is optional, but strongly recommended for enhanced functionality (playlist search, validation, metadata).

## YouTube API Key

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

![Mapping overview](assets/Mapping%20Overview.png)

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

![Configure mapping](assets/Configure%20Mapping.png)

### State-based playlist switching

If an entity is configured, the integration will check its current state and try to match it against your state rules.

Example:
- Entity: `input_select.house_mode`
- State `day` → daytime playlist
- State `night` → nighttime playlist
- Fallback → default playlist

![Example background](assets/Example.png)

### Notes

- The live background player only runs on configured dashboards and views.
- If you navigate to a dashboard or screen without a matching mapping, the player is hidden.
- The preview in the panel is designed to match the live dashboard behavior as closely as possible.

## Support

For issues, please check the [GitHub repository](https://github.com/SolusCado/Background-Playlist).
