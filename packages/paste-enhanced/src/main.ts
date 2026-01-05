import { Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	PasteEnhancedSettings,
	PasteEnhancedSettingTab,
} from "./settings";
import { isInCodeBlock, processPasteContent } from "./utils/pasteHandler";

export default class PasteEnhancedPlugin extends Plugin {
	settings: PasteEnhancedSettings;

	async onload() {
		await this.loadSettings();

		// Register settings tab
		this.addSettingTab(new PasteEnhancedSettingTab(this.app, this));

		// Register paste event listener
		this.registerEvent(
			this.app.workspace.on("editor-paste", (evt, editor, view) => {
				if (!this.settings.enabled) {
					return; // If plugin is disabled, don't process
				}

				// Get clipboard content (prefer HTML, fallback to plain text)
				const clipboardHtml =
					evt.clipboardData?.getData("text/html") || null;
				const clipboardText =
					evt.clipboardData?.getData("text/plain") || "";

				if (!clipboardText && !clipboardHtml) {
					return;
				}

				// Detect the area where cursor is located
				const inCodeBlock = isInCodeBlock(editor);

				// Check if the pasted content is a plain URL (without HTML)
				// If so, skip processing to avoid conflict with obsidian-auto-link-title plugin
				if (!inCodeBlock && !clipboardHtml && clipboardText) {
					const urlRegex = /^https?:\/\/[^\s]+$/i;
					const trimmedText = clipboardText.trim();
					// If it's a plain URL, let other plugins handle it
					if (urlRegex.test(trimmedText)) {
						return;
					}
					// If it's already a markdown link, let other plugins handle it
					const markdownLinkRegex = /^\[.*?\]\(https?:\/\/[^\s]+\)$/i;
					if (markdownLinkRegex.test(trimmedText)) {
						return;
					}
				}

				// If HTML contains a link and plain text is just the URL,
				// check if we should skip to avoid conflict with obsidian-auto-link-title
				if (!inCodeBlock && clipboardHtml && clipboardText) {
					const urlRegex = /^https?:\/\/[^\s]+$/i;
					const trimmedText = clipboardText.trim();
					// If plain text is just a URL, let obsidian-auto-link-title handle it
					// This avoids double processing when HTML link and plain URL are both present
					if (urlRegex.test(trimmedText)) {
						// Check if HTML is just a simple link (not complex HTML)
						// Normalize HTML by removing extra whitespace
						const normalizedHtml = clipboardHtml.trim().replace(/\s+/g, ' ');
						const htmlLinkRegex = /^<a\s+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>$/i;
						if (htmlLinkRegex.test(normalizedHtml)) {
							// It's a simple link, let obsidian-auto-link-title handle it
							return;
						}
					}
				}

				// Prevent default paste behavior
				evt.preventDefault();

				// Process paste content
				const processedText = processPasteContent(
					clipboardText,
					clipboardHtml,
					inCodeBlock
				);

				// Insert processed text
				editor.replaceSelection(processedText);
			})
		);
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<PasteEnhancedSettings>
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
