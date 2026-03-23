# YouTube Background for Home Assistant

This integration allows you to set YouTube playlists as backgrounds for your Lovelace dashboards/views based on Home Assistant entity states.

## Installation

1. Install via HACS (recommended) or copy the `custom_components/youtube_background` folder to your Home Assistant config directory.
2. Restart Home Assistant.
3. Add the integration in Settings > Devices & Services.
4. Configure mappings in the YouTube Background panel.

## Configuration

After installing, go to Settings > YouTube Background to manage your mappings.

Each mapping can specify:
- Dashboard path
- Optional view path
- Entity ID to monitor
- Default playlist ID
- State-to-playlist mappings

## Migration from YAML

If you were using the old YAML-based config, you can manually recreate the mappings in the panel.

## Support

For issues, please check the [GitHub repository](https://github.com/DeLuca21/background-playlist-ha).