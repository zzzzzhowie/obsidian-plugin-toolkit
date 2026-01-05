import { Editor } from "obsidian";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/**
 * Detect the region type where the cursor is located
 */
export type CursorRegion = "code-block" | "inline-code" | "normal";

/**
 * Detect the region type where the cursor is located
 * Strictly detect via DOM: only return code-block when the cursor's DOM is wrapped by HyperMD-codeblock class
 */
export function getCursorRegion(editor: Editor): CursorRegion {
	// Detect if in multi-line code block via DOM
	// Check if the cursor's DOM is wrapped by HyperMD-codeblock class
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
		const cm = (editor as any).cm;
		if (cm) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
			const dom = cm.dom || cm.contentDOM;
			if (dom) {
				// Get currently selected DOM element (cursor position)
				const selection = window.getSelection();
				if (selection && selection.rangeCount > 0) {
					const range = selection.getRangeAt(0);
					let cursorElement: Node | null = range.startContainer;

					// If it's a text node, get its parent element
					if (cursorElement.nodeType === Node.TEXT_NODE) {
						cursorElement = cursorElement.parentElement;
					}

					// Traverse up the DOM tree to check if there's a parent element with HyperMD-codeblock class
					let currentElement = cursorElement as HTMLElement | null;
					while (currentElement && currentElement !== dom) {
						if (
							currentElement.classList &&
							currentElement.classList.contains("HyperMD-codeblock")
						) {
							return "code-block";
						}
						currentElement = currentElement.parentElement;
					}
				}

				// If unable to get via selection, fallback to finding by line number
				const cursor = editor.getCursor();
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
				const lines = dom.querySelectorAll(
					".cm-line"
				) as NodeListOf<HTMLElement>;
				if (lines && lines.length > cursor.line) {
					const lineElement = lines[cursor.line];
					if (lineElement) {
						// Check if the line element itself or its parent has HyperMD-codeblock class
						let currentElement: HTMLElement | null = lineElement;
						while (currentElement && currentElement !== dom) {
							if (
								currentElement.classList &&
								currentElement.classList.contains("HyperMD-codeblock")
							) {
								return "code-block";
							}
							currentElement = currentElement.parentElement;
						}
					}
				}
			}
		}
	} catch {
		// DOM detection failed, don't return code block
		// Fail silently, return normal
	}

	return "normal";
}

/**
 * Detect if cursor is in code block
 * Strictly judge by HyperMD-codeblock wrapping
 */
export function isInCodeBlock(editor: Editor): boolean {
	const region = getCursorRegion(editor);
	return region === "code-block";
}

/**
 * Convert HTML to Markdown
 */
function htmlToMarkdown(html: string): string {
	const turndownService = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
	// Add GitHub Flavored Markdown support (including tables)
	// gfm is a function that accepts turndownService as parameter
	gfm(turndownService);
	let markdown = turndownService.turndown(html);
	
	// Remove empty lines between bullet points
	// Process line by line to remove empty lines between consecutive bullet points
	const lines = markdown.split('\n');
	const processedLines: string[] = [];
	const bulletPointRegex = /^\s*-\s/; // Matches lines starting with "- " (with optional indentation)
	
	for (let i = 0; i < lines.length; i++) {
		const currentLine = lines[i];
		
		// Skip if currentLine is undefined
		if (currentLine === undefined) {
			continue;
		}
		
		// If current line is empty, check if it's between bullet points
		if (currentLine.trim() === '') {
			// Find the last non-empty line before current line
			let prevNonEmptyIndex = i - 1;
			while (prevNonEmptyIndex >= 0) {
				const prevLine = lines[prevNonEmptyIndex];
				if (prevLine === undefined || prevLine.trim() !== '') {
					break;
				}
				prevNonEmptyIndex--;
			}
			
			// Find the next non-empty line after current line
			let nextNonEmptyIndex = i + 1;
			while (nextNonEmptyIndex < lines.length) {
				const nextLine = lines[nextNonEmptyIndex];
				if (nextLine === undefined || nextLine.trim() !== '') {
					break;
				}
				nextNonEmptyIndex++;
			}
			
			// Check if both previous and next non-empty lines are bullet points
			if (prevNonEmptyIndex >= 0 && nextNonEmptyIndex < lines.length) {
				const prevLine = lines[prevNonEmptyIndex];
				const nextLine = lines[nextNonEmptyIndex];
				if (prevLine !== undefined && nextLine !== undefined) {
					const isPrevBulletPoint = bulletPointRegex.test(prevLine);
					const isNextBulletPoint = bulletPointRegex.test(nextLine);
					
					// Skip empty line(s) if they're between two bullet points
					if (isPrevBulletPoint && isNextBulletPoint) {
						continue;
					}
				}
			}
		}
		
		processedLines.push(currentLine);
	}
	
	markdown = processedLines.join('\n');
	
	// Remove trailing empty lines
	markdown = markdown.replace(/\n+$/, '');
	
	return markdown;
}

/**
 * Extract plain text from HTML (without converting to Markdown), preserving indentation and line breaks
 * Used for pasting in code blocks, needs to completely preserve original format
 * Special attention: Python code indentation and line breaks must be completely preserved
 */
function htmlToPlainText(html: string): string {
	try {
		// Safely parse HTML using DOMParser
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, "text/html");

		// Prioritize checking <pre> tags, they usually contain code and completely preserve format
		const preElements = doc.querySelectorAll("pre");
		if (preElements.length > 0) {
			let result = "";
			preElements.forEach((element, index) => {
				if (index > 0) result += "\n";
				// Use textContent to preserve all whitespace characters (including indentation, tabs, line breaks)
				// textContent doesn't compress whitespace, this is key
				let text = element.textContent || "";
				// Clean up excessive line breaks (compress multiple consecutive line breaks to single line break, remove gaps between lines)
				text = text.replace(/\n{2,}/g, "\n");
				result += text;
			});
			// Remove newlines at the top and bottom of the entire result
			result = result.replace(/^\n+/, "").replace(/\n+$/, "");
			return result;
		}

		// Check if there are <code> tags (might be part of code block)
		const codeElements = doc.querySelectorAll("code");
		if (codeElements.length > 0) {
			let result = "";
			codeElements.forEach((element, index) => {
				if (index > 0) result += "\n";
				// Use textContent to preserve all whitespace characters
				let text = element.textContent || "";
				// Clean up excessive line breaks (compress multiple consecutive line breaks to single line break, remove gaps between lines)
				text = text.replace(/\n{2,}/g, "\n");
				result += text;
			});
			// Remove newlines at the top and bottom of the entire result
			result = result.replace(/^\n+/, "").replace(/\n+$/, "");
			return result;
		}

		// For other cases, need to manually process to preserve line breaks
		// Traverse all elements, convert block-level elements to line breaks
		function extractTextWithLineBreaks(node: Node): string {
			let text = "";

			if (node.nodeType === Node.TEXT_NODE) {
				text += node.textContent || "";
			} else if (node.nodeType === Node.ELEMENT_NODE) {
				const element = node as Element;
				const tagName = element.tagName.toLowerCase();

				// Add line breaks before and after block-level elements
				const blockElements = [
					"div",
					"p",
					"br",
					"li",
					"h1",
					"h2",
					"h3",
					"h4",
					"h5",
					"h6",
					"pre",
					"blockquote",
				];
				if (blockElements.includes(tagName)) {
					// Process child nodes
					for (let i = 0; i < element.childNodes.length; i++) {
						const childNode = element.childNodes[i];
						if (childNode) {
							text += extractTextWithLineBreaks(childNode);
						}
					}
					// If it's br, add line break
					if (tagName === "br") {
						text += "\n";
					} else if (tagName !== "pre") {
						// Other block-level elements add line breaks before and after (pre is already handled above)
						text = "\n" + text + "\n";
					}
				} else {
					// Inline elements, directly process child nodes
					for (let i = 0; i < element.childNodes.length; i++) {
						const childNode = element.childNodes[i];
						if (childNode) {
							text += extractTextWithLineBreaks(childNode);
						}
					}
				}
			}

			return text;
		}

		// Start extraction from body
		let text = "";
		for (let i = 0; i < doc.body.childNodes.length; i++) {
			const childNode = doc.body.childNodes[i];
			if (childNode) {
				text += extractTextWithLineBreaks(childNode);
			}
		}

		// If extraction fails, use textContent as fallback
		if (!text || text.trim().length === 0) {
			text = doc.body.textContent || "";
		}

		// Clean up excessive line breaks (compress multiple consecutive line breaks to single line break, remove gaps between lines)
		// This can remove gaps between lines in code blocks
		text = text.replace(/\n{2,}/g, "\n");

		// Remove newlines at top and bottom
		text = text.replace(/^\n+/, "").replace(/\n+$/, "");

		// Preserve original format, but clean up excessive line breaks
		// Preserve indentation and single line breaks, but remove gaps caused by multiple consecutive line breaks
		return text;
	} catch {
		// If parsing fails, return empty string
		return "";
	}
}

/**
 * Process paste content
 */
export function processPasteContent(
	clipboardText: string,
	clipboardHtml: string | null,
	isCodeBlock: boolean
): string {
	if (isCodeBlock) {
		// In code block: always use plain text, preserve original indentation and line breaks
		// Prefer extracting plain text from HTML (preserve format), if no HTML then use plain text
		if (clipboardHtml) {
			// Extract plain text directly from HTML, preserve indentation, line breaks and format
			const plainText = htmlToPlainText(clipboardHtml);
			if (plainText) {
				return plainText;
			}
		}
		// If no HTML or extraction failed, use plain text
		// Remove newlines at top and bottom
		return clipboardText.replace(/^\n+/, "").replace(/\n+$/, "");
	} else {
		// Not in code block: if copied content is HTML, convert it to markdown
		// Only code blocks convert to plain text, all other cases convert to markdown
		if (clipboardHtml) {
			try {
				// Convert HTML to Markdown
				return htmlToMarkdown(clipboardHtml);
			} catch {
				// If conversion fails, use plain text
				return clipboardText;
			}
		}
		// If no HTML, directly use plain text
		return clipboardText;
	}
}
