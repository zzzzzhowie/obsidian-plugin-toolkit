import { App, PluginSettingTab, Setting } from 'obsidian';
import HideUIElementsPlugin from './main';

export interface HideUIElementsSettings {
	// Sidebar tabs
	hideTagTab: boolean;
	hideAllPropertiesTab: boolean;
	hideBookmarksTab: boolean;
	hideOutgoingLinksTab: boolean;
	// Status bar
	hideBacklinkStatus: boolean;
	hideEditorStatus: boolean;
	hideSyncStatus: boolean;
	hideBookmarkStatus: boolean;
	hideCharacterCount: boolean;
	hideFilePropertiesTab: boolean;
	hideVaultName: boolean;
}

export const DEFAULT_SETTINGS: HideUIElementsSettings = {
	hideTagTab: true,
	hideAllPropertiesTab: true,
	hideBookmarksTab: true,
	hideOutgoingLinksTab: false,
	hideBacklinkStatus: true,
	hideEditorStatus: true,
	hideSyncStatus: true,
	hideBookmarkStatus: true,
	hideCharacterCount: true,
	hideFilePropertiesTab: true,
	hideVaultName: true,
};

export class HideUIElementsSettingTab extends PluginSettingTab {
	plugin: HideUIElementsPlugin;

	constructor(app: App, plugin: HideUIElementsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Sidebar Tabs' });

		new Setting(containerEl)
			.setName('Hide Tags tab')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideTagTab).onChange(async (value) => {
					this.plugin.settings.hideTagTab = value;
					await this.plugin.saveSettings();
					this.plugin.applyStyles();
				})
			);

		new Setting(containerEl)
			.setName('Hide All Properties tab')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideAllPropertiesTab).onChange(async (value) => {
					this.plugin.settings.hideAllPropertiesTab = value;
					await this.plugin.saveSettings();
					this.plugin.applyStyles();
				})
			);

		new Setting(containerEl)
			.setName('Hide Bookmarks tab')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideBookmarksTab).onChange(async (value) => {
					this.plugin.settings.hideBookmarksTab = value;
					await this.plugin.saveSettings();
					this.plugin.applyStyles();
				})
			);

		new Setting(containerEl)
			.setName('Hide Outgoing Links tab')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideOutgoingLinksTab).onChange(async (value) => {
					this.plugin.settings.hideOutgoingLinksTab = value;
					await this.plugin.saveSettings();
					this.plugin.applyStyles();
				})
			);

		new Setting(containerEl)
			.setName('Hide File Properties tab')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideFilePropertiesTab).onChange(async (value) => {
					this.plugin.settings.hideFilePropertiesTab = value;
					await this.plugin.saveSettings();
					this.plugin.applyStyles();
				})
			);

		containerEl.createEl('h2', { text: 'Status Bar' });

		new Setting(containerEl)
			.setName('Hide Backlinks')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideBacklinkStatus).onChange(async (value) => {
					this.plugin.settings.hideBacklinkStatus = value;
					await this.plugin.saveSettings();
					this.plugin.applyStyles();
				})
			);

		new Setting(containerEl)
			.setName('Hide Editor mode icon')
			.setDesc('The pencil/preview icon shown in Live Preview mode')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideEditorStatus).onChange(async (value) => {
					this.plugin.settings.hideEditorStatus = value;
					await this.plugin.saveSettings();
					this.plugin.applyStyles();
				})
			);

		new Setting(containerEl)
			.setName('Hide Sync status icon')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideSyncStatus).onChange(async (value) => {
					this.plugin.settings.hideSyncStatus = value;
					await this.plugin.saveSettings();
					this.plugin.applyStyles();
				})
			);

		new Setting(containerEl)
			.setName('Hide Bookmarks icon')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideBookmarkStatus).onChange(async (value) => {
					this.plugin.settings.hideBookmarkStatus = value;
					await this.plugin.saveSettings();
					this.plugin.applyStyles();
				})
			);

		new Setting(containerEl)
			.setName('Hide character count')
			.setDesc('Keep only the word count in the status bar')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideCharacterCount).onChange(async (value) => {
					this.plugin.settings.hideCharacterCount = value;
					await this.plugin.saveSettings();
					this.plugin.applyStyles();
				})
			);

		containerEl.createEl('h2', { text: 'Other' });

		new Setting(containerEl)
			.setName('Hide vault name')
			.setDesc('Hide the vault name shown in the bottom-left corner')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideVaultName).onChange(async (value) => {
					this.plugin.settings.hideVaultName = value;
					await this.plugin.saveSettings();
					this.plugin.applyStyles();
				})
			);
	}
}
