import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { keymap } from "@codemirror/view";
import { tryReplace as tryReplaceBlock } from "replace";
import { runSelectBlock } from "select";
import { CalloutSuggest, CheckboxSuggest } from "suggest";
import { FenceSuggest } from "fence-suggest";

export type PluginSettings = {
	replaceBlocks: boolean;
	showCheckboxSuggestions: boolean;
	checkboxVariants: string;
	showCalloutSuggestions: boolean;
	calloutSuggestions: string;
	enableSelectBlockEE: boolean;
	showFenceSuggestions: boolean;
	fenceLanguages: string;
	fenceTemplates: string;
};

const DEFAULT_SETTINGS: PluginSettings = {
	replaceBlocks: true,
	showCheckboxSuggestions: false,
	checkboxVariants: ' x><!-/?*nliISpcb"0123456789',
	showCalloutSuggestions: true,
	calloutSuggestions:
		"note, summary, info, todo, tip, check, help, warning, fail, error, bug, example, quote",
	enableSelectBlockEE: true,
	showFenceSuggestions: true,
	fenceLanguages:
		"python, javascript, typescript, shell, bash, sql, mermaid, excalidraw, json, yaml, html, css, go, jsx, tsx, java, c, cpp, rust, markdown, plain, diff, http, dockerfile",
	fenceTemplates: "",
};

/** `lang: first line` per line of the setting, a `\n` in it for a line break. */
function parseTemplates(text: string): Record<string, string> {
	const templates: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const at = line.indexOf(":");
		if (at <= 0) continue;
		const lang = line.slice(0, at).trim().toLowerCase();
		const body = line.slice(at + 1).trim().replace(/\\n/g, "\n");
		if (lang && body) templates[lang] = body;
	}
	return templates;
}

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

		if (this.settings.showFenceSuggestions) {
			this.registerEditorSuggest(
				new FenceSuggest(this.app, {
					languages: this.settings.fenceLanguages
						.split(",")
						.map((name) => name.trim().toLowerCase())
						.filter(Boolean),
					templates: parseTemplates(this.settings.fenceTemplates),
				})
			);
		}
	}

	async loadSettings() {
		// Only carry over known keys, so options this fork removed (e.g.
		// `selectFullCodeBlock`) don't linger in data.json; save once if any were dropped.
		const saved = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		const stale = Object.keys(saved).filter((key) => !(key in DEFAULT_SETTINGS));
		for (const key of stale) delete saved[key];
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		if (stale.length > 0) await this.saveSettings();
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

		new Setting(containerEl)
			.setName("Show code block language suggestions")
			.setDesc(
				"While typing an opening fence (```py), suggest the language, most used in this vault first. Reload required."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showFenceSuggestions)
					.onChange(async (value) => {
						this.plugin.settings.showFenceSuggestions = value;
						await this.plugin.saveSettings();
						new Notice("Reload required!");
					})
			);

		new Setting(containerEl)
			.setName("Code block languages")
			.setDesc(
				"Offered even before the vault uses them; languages the vault already uses are added. Separate by commas. Reload required."
			)
			.addTextArea((text) =>
				text.setValue(this.plugin.settings.fenceLanguages).onChange(async (value) => {
					this.plugin.settings.fenceLanguages = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Code block templates")
			.setDesc(
				"What a new block starts with, one language per line as `language: text` (\\n for a line break), e.g. `mermaid: sequenceDiagram`. Reload required."
			)
			.addTextArea((text) =>
				text.setValue(this.plugin.settings.fenceTemplates).onChange(async (value) => {
					this.plugin.settings.fenceTemplates = value;
					await this.plugin.saveSettings();
				})
			);
	}
}
