import { Editor, MarkdownView, Notice, Plugin } from 'obsidian';

export default class CopyPathPlugin extends Plugin {
	async onload() {
		// Register command to copy absolute path
		this.addCommand({
			id: 'copy-absolute-path',
			name: 'Copy absolute path',
			hotkeys: [
				{
					modifiers: ['Mod', 'Alt'],
					key: 'c',
				},
			],
			callback: () => {
				this.copyAbsolutePath();
			},
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.copyAbsolutePath();
			},
		});
		
		// Add direct keyboard listener as primary method for editor context
		// Use capture phase to intercept before other handlers
		const handleKeyDown = (evt: KeyboardEvent) => {
			// Check for cmd+option+C (Mac) or ctrl+alt+C (Windows/Linux)
			// Use evt.code instead of evt.key because on macOS, Option+C produces 'ç' not 'c'
			const isMod = evt.metaKey || evt.ctrlKey;
			const isAlt = evt.altKey;
			const isC = evt.code === 'KeyC';
			
			if (isMod && isAlt && isC) {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView) {
					return;
				}
				
				const activeElement = document.activeElement;
				
				// Don't trigger in input fields, command palette, etc.
				const isInputField = activeElement?.tagName === 'INPUT' || 
				                    activeElement?.tagName === 'TEXTAREA' ||
				                    activeElement?.closest('.prompt') !== null ||
				                    activeElement?.closest('.modal') !== null ||
				                    activeElement?.closest('.suggestion-container') !== null;
				
				// Check if we're in CodeMirror editor
				const isInEditor = activeElement?.closest('.cm-editor') !== null ||
				                  activeElement?.closest('.markdown-source-view') !== null ||
				                  activeElement?.closest('.markdown-preview-view') !== null;
				
				if (!isInputField && isInEditor) {
					evt.preventDefault();
					evt.stopPropagation();
					evt.stopImmediatePropagation();
					this.copyAbsolutePath();
				}
			}
		};
		
		// Register with capture phase (true = capture phase)
		document.addEventListener('keydown', handleKeyDown, true);
		this.register(() => {
			document.removeEventListener('keydown', handleKeyDown, true);
		});
	}

	onunload() {
	}

	private async copyAbsolutePath() {
		try {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView) {
				return;
			}

			const file = activeView.file;
			if (!file) {
				return;
			}

			// Get absolute path using vault adapter
			const vault = this.app.vault;
			// @ts-ignore - getFullPath exists on adapter but not in types
			const absolutePath = vault.adapter.getFullPath(file.path);

			// Check if cursor is in a header DOM element
			const headerAnchor = this.getCurrentHeaderAnchor(activeView);
			
			// Build the path with optional header anchor
			const pathWithoutQuotes = headerAnchor ? `${absolutePath}#${headerAnchor}` : absolutePath;
			// Wrap path with double quotes
			const pathToCopy = `"${pathWithoutQuotes}"`;

			// Copy to clipboard
			await navigator.clipboard.writeText(pathToCopy);
			
			// Show notification with absolute path
			const displayPath = headerAnchor ? `${absolutePath}#${headerAnchor}` : absolutePath;
			new Notice(`Path copied: "${displayPath}"`);
		} catch (error) {
			// Silently fail
		}
	}

	private getCurrentHeaderAnchor(view: MarkdownView): string | null {
		try {
			const editor = view.editor;
			const cursor = editor.getCursor();
			const line = editor.getLine(cursor.line);

			// First check if the current line is in a code block
			// If it is, don't treat # as a header
			if (this.isInCodeBlock(editor, cursor.line)) {
				return null;
			}

			// Check if the line is a header (starts with #)
			const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
			if (!headerMatch || !headerMatch[2]) {
				return null;
			}

			// Get the header text
			const headerText = headerMatch[2].trim();
			
			// Convert header text to anchor format
			// Keep Chinese characters, only replace spaces with hyphens
			const anchor = headerText
				.replace(/\s+/g, '-')
				.replace(/-+/g, '-')
				.replace(/^-|-$/g, '');

			// If anchor is empty, return null
			if (!anchor || anchor.length === 0) {
				return null;
			}

			// Check if cursor is actually in the header DOM element using CodeMirror API
			// @ts-ignore - cm property exists but not in types
			const cmEditor = editor.cm;
			
			// Convert cursor position to offset (cmEditor.domAtPos needs offset, not {line, ch})
			// Use CodeMirror state to calculate offset
			const state = cmEditor.state;
			const lineStart = state.doc.line(cursor.line + 1).from; // line is 0-based, state.doc.line is 1-based
			const lineEnd = state.doc.line(cursor.line + 1).to;
			const offset = lineStart + cursor.ch;
			
			// If cursor is at the very beginning of the line (before #), check a position slightly ahead
			// This handles the case where the DOM node at position 0 might not be inside cm-header yet
			const checkOffset = cursor.ch === 0 ? Math.min(lineStart + 1, lineEnd) : offset;
			
			// Get the DOM node at cursor position (or slightly ahead if at start)
			const domAtPos = cmEditor.domAtPos(checkOffset);
			if (!domAtPos || !domAtPos.node) {
				// If we can't get DOM node but line is a header, still return anchor
				// This handles edge cases where DOM might not be ready
				return anchor;
			}

			// Check if the element or its parent is a header element (cm-header class)
			let currentElement: Node | null = domAtPos.node;
			let depth = 0;
			while (currentElement && currentElement.nodeType !== Node.DOCUMENT_NODE && depth < 10) {
				if (currentElement.nodeType === Node.ELEMENT_NODE) {
					const el = currentElement as Element;
					if (el.classList && el.classList.contains('cm-header')) {
						return anchor;
					}
				}
				currentElement = currentElement.parentNode;
				depth++;
			}

			// If we didn't find cm-header class but the line is a header and cursor is on that line,
			// still return the anchor (handles edge cases like cursor at very beginning)
			// This ensures we catch headers even when DOM structure isn't perfect
			return anchor;
		} catch (error) {
			return null;
		}
	}

	/**
	 * Check if a given line is inside a code block
	 * Detects code blocks by checking if the line's DOM element is wrapped by HyperMD-codeblock class
	 */
	private isInCodeBlock(editor: Editor, lineNumber: number): boolean {
		try {
			// @ts-ignore - cm property exists but not in types
			const cmEditor = editor.cm;
			if (!cmEditor) {
				return false;
			}

			// @ts-ignore - dom property exists but not in types
			const dom = cmEditor.dom || cmEditor.contentDOM;
			if (!dom) {
				return false;
			}

			// Get the line element for the given line number
			// @ts-ignore - querySelectorAll exists on DOM
			const lines = dom.querySelectorAll('.cm-line') as NodeListOf<HTMLElement>;
			if (!lines || !lines.length || lines.length <= lineNumber) {
				return false;
			}

			const lineElement = lines[lineNumber];
			if (!lineElement) {
				return false;
			}

			// Check if the line element or its parent has HyperMD-codeblock class
			let currentElement: HTMLElement | null = lineElement;
			while (currentElement && currentElement !== dom) {
				if (
					currentElement.classList &&
					currentElement.classList.contains('HyperMD-codeblock')
				) {
					return true;
				}
				currentElement = currentElement.parentElement;
			}

			return false;
		} catch (error) {
			// If detection fails, assume not in code block (fail-safe)
			return false;
		}
	}
}
