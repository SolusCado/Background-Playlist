import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("youtube-background-panel")
export class YouTubeBackgroundPanel extends LitElement {
  @property() hass;
  @property() narrow;
  @state() private mappings = [];
  @state() private editingId = null;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .container {
      padding: 16px;
      flex: 1;
      overflow-y: auto;
    }

    h1 {
      margin: 0 0 16px 0;
      font-size: 24px;
    }

    .actions {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
    }

    ha-button {
      margin-right: 8px;
    }

    .mappings-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .mapping-card {
      border: 1px solid var(--divider-color);
      border-radius: 8px;
      padding: 16px;
      background: var(--card-background-color);
    }

    .mapping-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .mapping-title {
      font-size: 16px;
      font-weight: 500;
    }

    .mapping-actions {
      display: flex;
      gap: 8px;
    }

    ha-icon-button {
      --mdc-icon-size: 24px;
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 16px;
      margin-top: 12px;
    }

    ha-textfield {
      width: 100%;
    }

    .state-map {
      grid-column: 1 / -1;
    }

    .state-map-textarea {
      width: 100%;
      min-height: 100px;
      padding: 8px;
      border: 1px solid var(--divider-color);
      border-radius: 4px;
      font-family: monospace;
      background: var(--input-background-color);
      color: var(--input-text-color);
    }

    .empty-state {
      text-align: center;
      color: var(--secondary-text-color);
      padding: 32px 16px;
    }

    .empty-state ha-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .button-group {
      display: flex;
      gap: 8px;
      margin-top: 16px;
      justify-content: flex-end;
    }

    .mapping-info {
      padding: 8px 0;
    }

    .mapping-info p {
      margin: 4px 0;
      font-size: 14px;
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    await this.loadMappings();
  }

  async loadMappings() {
    try {
      if (!this.hass) return;
      const response = await this.hass.callWS({
        type: "youtube_background/get_mappings"
      });
      this.mappings = response.mappings || [];
    } catch (e) {
      console.error("Failed to load mappings", e);
      this.mappings = [];
    }
  }

  render() {
    return html`
      <div class="container">
        <h1>YouTube Background</h1>
        
        <div class="actions">
          <ha-button raised @click=${this.addMapping}>
            <ha-icon icon="mdi:plus" slot="icon"></ha-icon>
            Add Mapping
          </ha-button>
        </div>

        ${this.mappings.length === 0
          ? html`
              <div class="empty-state">
                <ha-icon icon="mdi:youtube"></ha-icon>
                <p>No mappings configured yet.</p>
                <p>Click "Add Mapping" to get started.</p>
              </div>
            `
          : html`
              <div class="mappings-list">
                ${this.mappings.map(
                  (mapping) => html`
                    <div class="mapping-card">
                      <div class="mapping-header">
                        <span class="mapping-title">
                          ${mapping.dashboard_path || "Unnamed"}
                          ${mapping.view_path ? ` / ${mapping.view_path}` : ""}
                        </span>
                        <div class="mapping-actions">
                          <ha-icon-button
                            icon="mdi:pencil"
                            @click=${() => this.editMapping(mapping.id)}
                            title="Edit"
                          ></ha-icon-button>
                          <ha-icon-button
                            icon="mdi:delete"
                            @click=${() => this.deleteMapping(mapping.id)}
                            title="Delete"
                          ></ha-icon-button>
                        </div>
                      </div>
                      
                      ${this.editingId === mapping.id
                        ? this.renderEditForm(mapping)
                        : html`
                            <div class="mapping-info">
                              <p><strong>Entity:</strong> ${mapping.entity_id || "-"}</p>
                              <p><strong>Default Playlist:</strong> ${mapping.default_playlist_id || "-"}</p>
                              <p><strong>Status:</strong> ${mapping.enabled ? "Enabled" : "Disabled"}</p>
                            </div>
                          `}
                    </div>
                  `
                )}
              </div>
            `}
      </div>
    `;
  }

  renderEditForm(mapping) {
    return html`
      <div class="form-grid">
        <ha-textfield
          label="Dashboard Path"
          .value=${mapping.dashboard_path || ""}
          @input=${(e) => this.updateField(mapping.id, "dashboard_path", e.target.value)}
          placeholder="/dashboard/my-dashboard"
        ></ha-textfield>

        <ha-textfield
          label="View Path (optional)"
          .value=${mapping.view_path || ""}
          @input=${(e) => this.updateField(mapping.id, "view_path", e.target.value)}
          placeholder="view-name"
        ></ha-textfield>

        <ha-textfield
          label="Entity ID"
          .value=${mapping.entity_id || ""}
          @input=${(e) => this.updateField(mapping.id, "entity_id", e.target.value)}
          placeholder="weather.home"
        ></ha-textfield>

        <ha-textfield
          label="Default Playlist ID"
          .value=${mapping.default_playlist_id || ""}
          @input=${(e) => this.updateField(mapping.id, "default_playlist_id", e.target.value)}
          placeholder="PLitMvngYLoYRcZ8Z5nlqZXP689Mwg7nLP"
        ></ha-textfield>

        <div class="state-map">
          <label>State to Playlist Mappings (JSON)</label>
          <textarea
            class="state-map-textarea"
            .value=${JSON.stringify(mapping.state_map || {}, null, 2)}
            @input=${(e) => this.updateField(mapping.id, "state_map", e.target.value)}
            placeholder='{"sunny": "PLitMvngYLoYRcZ8Z5nlqZXP689Mwg7nLP", "rainy": "PLitMvngYLoYTIqKQnuuFlBVHJ4dFhBdrL"}'
          ></textarea>
          <small>Map entity states to YouTube playlist IDs</small>
        </div>

        <div class="button-group" style="grid-column: 1 / -1;">
          <ha-button @click=${() => this.cancelEdit()}>
            Cancel
          </ha-button>
          <ha-button raised @click=${() => this.saveMapping(mapping.id)}>
            Save
          </ha-button>
        </div>
      </div>
    `;
  }

  addMapping() {
    const newMapping = {
      id: Math.random().toString(36).substr(2, 9),
      dashboard_path: "",
      view_path: "",
      entity_id: "",
      default_playlist_id: "",
      state_map: {},
      enabled: true,
      new: true
    };
    this.mappings = [...this.mappings, newMapping];
    this.editingId = newMapping.id;
    this.requestUpdate();
  }

  editMapping(id) {
    this.editingId = id;
  }

  cancelEdit() {
    this.editingId = null;
    this.requestUpdate();
  }

  updateField(id, field, value) {
    const mapping = this.mappings.find(m => m.id === id);
    if (!mapping) return;

    if (field === "state_map") {
      try {
        mapping[field] = JSON.parse(value);
      } catch (e) {
        // Keep as is if invalid JSON
      }
    } else {
      mapping[field] = value;
    }
    this.requestUpdate();
  }

  async saveMapping(id) {
    const mapping = this.mappings.find(m => m.id === id);
    if (!mapping) return;

    try {
      if (mapping.new) {
        const response = await this.hass.callWS({
          type: "youtube_background/create_mapping",
          mapping
        });
        mapping.id = response.id;
        delete mapping.new;
      } else {
        await this.hass.callWS({
          type: "youtube_background/update_mapping",
          mapping_id: id,
          updates: mapping
        });
      }
      this.editingId = null;
      this.requestUpdate();
    } catch (e) {
      console.error("Failed to save mapping", e);
    }
  }

  async deleteMapping(id) {
    if (!confirm("Are you sure you want to delete this mapping?")) return;

    try {
      await this.hass.callWS({
        type: "youtube_background/delete_mapping",
        mapping_id: id
      });
      this.mappings = this.mappings.filter(m => m.id !== id);
    } catch (e) {
      console.error("Failed to delete mapping", e);
    }
  }
}