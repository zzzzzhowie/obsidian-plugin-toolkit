import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { keymap } from "@codemirror/view";
import { tryReplace as tryReplaceBlock } from "replace";
import { runSelectBlock } from "select";
import { CalloutSuggest, CheckboxSuggest } from "suggest";

export type PluginSettings = {
	replaceBlocks: boolean;
	showCheckboxSuggestions: boolean;
	checkboxVariants: string;
	showCalloutSuggestions: boolean;
	calloutSuggestions: string;
	enableSelectBlockEE: boolean;
};

const DEFAULT_SETTINGS: PluginSettings = {
	replaceBlocks: true,
	showCheckboxSuggestions: false,
	checkboxVariants: ' x><!-/?*nliISpcb"0123456789',
	showCalloutSuggestions: true,
	calloutSuggestions:
		"note, summary, info, todo, tip, check, help, warning, fail, error, bug, example, quote",
	enableSelectBlockEE: true,
};

export default class BlockierPlugin extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SettingsTab(this.app, this));

		this.addCommand({
			id: "select-block",
			name: "Select block",
			editorCallback: (editor: Editor) => {
				runSelectBlock(editor);
			},
		});

		this.registerEditorExtension(
			keymap.of([
				{
					key: "Space",
					run: () => {
						const view = this.app.workspace.getActiveViewOfType(MarkdownView);
						if (this.settings.replaceBlocks && view) {
							tryReplaceBlock(view.editor);
						}
						return false;
					},
				},
			])
		);

		if (this.settings.enableSelectBlockEE) {
			this.registerEditorExtension(
				keymap.of([
					{
						key: "c-a", // ctrl a
						mac: "m-a", // cmd a
						run: () => {
							const editor = this.app.workspace.activeEditor?.editor;
							if (!editor) return false;
							runSelectBlock(editor);
							// we always handle it (select code block or select all),
							// so stop other bindings from also firing.
							return true;
						},
					},
				])
			);
		}

		// Checking at plugin initialisation instead of every keypress.
		// Requires reload if this setting is changed.
		if (this.settings.showCheckboxSuggestions) {
			this.registerEditorSuggest(
				new CheckboxSuggest(this.app, this, this.settings.checkboxVariants)
			);
		}

		if (this.settings.showCalloutSuggestions) {
			this.registerEditorSuggest(
				new CalloutSuggest(this.app, this, this.settings.calloutSuggestions)
			);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: BlockierPlugin;

	constructor(app: App, plugin: BlockierPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "Select block" });

		// need to use an editor extension so that ctrl-a works in other contexts
		// (e.g. select all in settings / properties)
		new Setting(containerEl)
			.setName("Use ctrl/cmd-A for Select block")
			.setDesc(
				"Override ctrl/cmd-A: when the cursor is inside a fenced code block, select only that code block; otherwise select all. Press again inside a fully-selected block to select all. Disable this and bind the \"Select block\" command to a different hotkey if you prefer. Reload required."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableSelectBlockEE)
					.onChange(async (value) => {
						this.plugin.settings.enableSelectBlockEE = value;
						await this.plugin.saveSettings();
						new Notice("Reload required!");
					})
			);

		containerEl.createEl("h2", { text: "Block edit" });

		new Setting(containerEl)
			.setName("Replace blocks")
			.setDesc(
				"Replaces the block type if you enter the prefix at the start of the paragraph."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.replaceBlocks).onChange(async (value) => {
					this.plugin.settings.replaceBlocks = value;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h2", { text: "Suggestions" });

		new Setting(containerEl)
			.setName("Show checkbox suggestions")
			.setDesc(
				"Whether to show suggestions of checkbox variants supported by your theme. Reload required."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showCheckboxSuggestions)
					.onChange(async (value) => {
						this.plugin.settings.showCheckboxSuggestions = value;
						await this.plugin.saveSettings();
						new Notice("Reload required!");
					})
			);

		new Setting(containerEl)
			.setName("Checkbox suggestion variants")
			.setDesc(
				"Which checkboxes to be shown in the suggestion. These should be supported by your theme. Each character will be one suggestion."
			)
			.addText((text) =>
				text.setValue(this.plugin.settings.checkboxVariants).onChange(async (value) => {
					this.plugin.settings.checkboxVariants = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Show callout suggestions")
			.setDesc(
				"Whether to show suggestions of callout variants supported by your theme. Reload required."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showCalloutSuggestions)
					.onChange(async (value) => {
						this.plugin.settings.showCalloutSuggestions = value;
						await this.plugin.saveSettings();
						new Notice("Reload required!");
					})
			);

		new Setting(containerEl)
			.setName("Callout suggestion variants")
			.setDesc("Which callouts to be shown in the suggestion. Separate by commas.")
			.addTextArea((text) =>
				text.setValue(this.plugin.settings.calloutSuggestions).onChange(async (value) => {
					this.plugin.settings.calloutSuggestions = value;
					await this.plugin.saveSettings();
				})
			);
	}
}
