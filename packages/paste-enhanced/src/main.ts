import { Plugin } from "obsidian";
import { isInCodeBlock, processPasteContent } from "./utils/pasteHandler";

/** What Obsidian puts at the start of the HTML it copies out of a note. */
const OBSIDIAN_COPY_MARK = "<!-- obsidian -->";

/**
 * Copied out of an Obsidian note: the clipboard then holds the note's own markdown (as
 * text/plain and text/markdown) beside rendered HTML meant for other apps. Obsidian's own
 * paste recognises this and pastes the markdown back as it was, so it's left to do that.
 * Rebuilding it from the HTML instead lost whatever HTML doesn't keep — an embed like
 * `![[report_2026-09-25.pdf]]` came back as its bare file name, escaped:
 * `report\_2026-09-25.pdf`.
 */
function isObsidianCopy(data: DataTransfer | null): boolean {
	if (!data) return false;
	return data.getData("text/html").includes(OBSIDIAN_COPY_MARK) || data.types.includes("text/markdown");
}

export default class PasteEnhancedPlugin extends Plugin {
	onload() {
		// Register paste event listener
		this.registerEvent(
			this.app.workspace.on("editor-paste", (evt, editor, view) => {
				// Another paste handler (the image uploader, the link titler) already took it.
				if (evt.defaultPrevented) return;
				if (isObsidianCopy(evt.clipboardData)) return;

				// If the clipboard contains an image file, this is an image paste,
				// not a text/code paste. Skip so the image-upload plugin can handle
				// it — otherwise we'd also insert the original <img> as markdown,
				// producing a duplicate alongside the uploaded image.
				const files = evt.clipboardData?.files;
				if (
					files &&
					files.length > 0 &&
					Array.from(files).some(f => f.type.startsWith("image"))
				) {
					return;
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
}
