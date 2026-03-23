"""Config flow for YouTube Background."""
import voluptuous as vol
import logging
from typing import Any, Dict, Optional

from homeassistant import config_entries
from homeassistant.core import callback

from .const import CONF_YOUTUBE_API_KEY, DOMAIN

_LOGGER = logging.getLogger(__name__)


class YouTubeBackgroundConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for YouTube Background."""

    VERSION = 1

    async def async_step_user(self, user_input: Optional[Dict[str, Any]] = None) -> Any:
        """Handle the initial step."""
        if user_input is not None:
            return self.async_create_entry(title="YouTube Background", data=user_input)

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Optional(CONF_YOUTUBE_API_KEY, default=""): str,
                }
            ),
        )


@callback
def async_get_options_flow(config_entry):
    """Get the options flow for this handler."""
    return YouTubeBackgroundOptionsFlow(config_entry)


class YouTubeBackgroundOptionsFlow(config_entries.OptionsFlow):
    """Handle options."""

    def __init__(self, config_entry):
        """Initialize options flow."""
        self.config_entry = config_entry

    async def async_step_init(self, user_input=None):
        """Manage the options."""
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        existing_key = self.config_entry.options.get(
            CONF_YOUTUBE_API_KEY,
            self.config_entry.data.get(CONF_YOUTUBE_API_KEY, ""),
        )

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Optional(CONF_YOUTUBE_API_KEY, default=existing_key): str,
                }
            ),
        )