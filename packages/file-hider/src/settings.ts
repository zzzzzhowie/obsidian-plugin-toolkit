import { App, PluginSettingTab, Setting } from 'obsidian';
import FileHiderPlugin from './main';

export interface FileHiderSettings {
	/** Whether hidden items are currently invisible (true) or revealed (false) */
	hidden: boolean;
	/** List of vault-relative paths to hide (e.g. "folder/subfolder", "notes/secret.md") */
	hiddenPaths: string[];
	/** Wildcard patterns to hide by name (e.g. "attachment" hides all folders/files named "attachment") */
	hiddenPatterns: string[];
}

export const DEFAULT_SETTINGS: FileHiderSettings = {
	hidden: true,
	hiddenPaths: [],
	hiddenPatterns: [],
};

export class FileHiderSettingTab extends PluginSettingTab {
	plugin: FileHiderPlugin;

	constructor(app: App, plugin: FileHiderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Hide files & folders')
			.setDesc('When enabled, items in the hidden list are invisible in the file explorer.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hidden).onChange(async (value) => {
					this.plugin.settings.hidden = value;
					await this.plugin.saveSettings();
					this.plugin.refreshStyles();
				})
			);

		// ── Wildcard patterns ──────────────────────────────────
		containerEl.createEl('h3', { text: 'Wildcard patterns' });
		containerEl.createEl('p', {
			text: 'Hide all files/folders matching a name pattern at any nesting level. For example, "attachment" hides every folder named "attachment" across the entire vault.',
			cls: 'setting-item-description',
		});

		// Input to add a new pattern
		const addPatternSetting = new Setting(containerEl).setName('Add pattern');
		let inputEl: HTMLInputElement | null = null;

		const doAddPattern = async () => {
			if (!inputEl) return;
			const value = inputEl.value.trim();
			if (!value) return;
			if (this.plugin.settings.hiddenPatterns.includes(value)) return;
			await this.plugin.addPattern(value);
			this.display();
		};

		addPatternSetting
			.addText((text) => {
				text.setPlaceholder('e.g. attachments');
				inputEl = text.inputEl;
				text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
					if (e.key === 'Enter') {
						void doAddPattern();
					}
				});
			})
			.addButton((btn) =>
				btn.setButtonText('Add').onClick(() => {
					void doAddPattern();
				})
			);

		// List existing patterns
		if (this.plugin.settings.hiddenPatterns.length === 0) {
			containerEl.createEl('p', {
				text: 'No patterns yet.',
				cls: 'setting-item-description',
			});
		} else {
			for (const pattern of this.plugin.settings.hiddenPatterns) {
				new Setting(containerEl)
					.setName(pattern)
					.addButton((btn) =>
						btn
							.setIcon('cross')
							.setTooltip('Remove pattern')
							.onClick(async () => {
								await this.plugin.removePattern(pattern);
								this.display();
							})
					);
			}
		}

		// ── Exact hidden paths ─────────────────────────────────
		containerEl.createEl('h3', { text: 'Hidden paths' });

		if (this.plugin.settings.hiddenPaths.length === 0) {
			containerEl.createEl('p', {
				text: 'No hidden files or folders. Right-click an item in the file explorer to hide it.',
				cls: 'setting-item-description',
			});
		} else {
			for (const path of this.plugin.settings.hiddenPaths) {
				new Setting(containerEl)
					.setName(path)
					.addButton((btn) =>
						btn
							.setIcon('cross')
							.setTooltip('Unhide')
							.onClick(async () => {
								await this.plugin.unhidePath(path);
								this.display();
							})
					);
			}
		}
	}
}
