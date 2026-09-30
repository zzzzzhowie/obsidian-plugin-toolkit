import { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, HideUIElementsSettings, HideUIElementsSettingTab } from './settings';

const BODY_CLASSES: Record<keyof HideUIElementsSettings, string> = {
	hideTagTab: 'hue-hide-tag-tab',
	hideAllPropertiesTab: 'hue-hide-all-properties-tab',
	hideBookmarksTab: 'hue-hide-bookmarks-tab',
	hideOutgoingLinksTab: 'hue-hide-outgoing-links-tab',
	hideBacklinkStatus: 'hue-hide-backlink-status',
	hideEditorStatus: 'hue-hide-editor-status',
	hideSyncStatus: 'hue-hide-sync-status',
	hideCharacterCount: 'hue-hide-character-count',
	hideFilePropertiesTab: 'hue-hide-file-properties-tab',
	hideVaultName: 'hue-hide-vault-name',
};

export default class HideUIElementsPlugin extends Plugin {
	settings: HideUIElementsSettings;

	async onload() {
		await this.loadSettings();
		this.applyStyles();
		this.addSettingTab(new HideUIElementsSettingTab(this.app, this));
	}

	onunload() {
		for (const cls of Object.values(BODY_CLASSES)) {
			document.body.classList.remove(cls);
		}
	}

	applyStyles() {
		for (const [key, cls] of Object.entries(BODY_CLASSES) as [keyof HideUIElementsSettings, string][]) {
			document.body.toggleClass(cls, this.settings[key]);
		}
	}

	async loadSettings() {
		// Only carry over known keys, so a removed option (e.g. `hideBookmarkStatus`)
		// doesn't linger in data.json; save once if anything was dropped.
		const saved = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		const stale = Object.keys(saved).filter((key) => !(key in DEFAULT_SETTINGS));
		for (const key of stale) delete saved[key];
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved as Partial<HideUIElementsSettings>);
		if (stale.length > 0) await this.saveSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
