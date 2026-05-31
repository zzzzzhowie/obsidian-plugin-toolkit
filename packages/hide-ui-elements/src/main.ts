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
	hideBookmarkStatus: 'hue-hide-bookmark-status',
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<HideUIElementsSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
