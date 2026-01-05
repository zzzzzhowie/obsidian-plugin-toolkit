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
			const pathToCopy = headerAnchor ? `${absolutePath}#${headerAnchor}` : absolutePath;

			// Copy to clipboard
			await navigator.clipboard.writeText(pathToCopy);
			
			// Show notification with absolute path
			const displayPath = headerAnchor ? `${absolutePath}#${headerAnchor}` : absolutePath;
			new Notice(`Path copied: ${displayPath}`);
		} catch (error) {
			// Silently fail
		}
	}

	private getCurrentHeaderAnchor(view: MarkdownView): string | null {
		try {
			const editor = view.editor;
			const cursor = editor.getCursor();
			const line = editor.getLine(cursor.line);

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

			// Check if cursor is actually in the header DOM element using CodeMirror API
			// @ts-ignore - cm property exists but not in types
			const cmEditor = editor.cm;
			
			// Convert cursor position to offset (cmEditor.domAtPos needs offset, not {line, ch})
			// Use CodeMirror state to calculate offset
			const state = cmEditor.state;
			const lineStart = state.doc.line(cursor.line + 1).from; // line is 0-based, state.doc.line is 1-based
			const offset = lineStart + cursor.ch;
			
			// Get the DOM node at cursor position
			const domAtPos = cmEditor.domAtPos(offset);
			if (!domAtPos || !domAtPos.node) {
				return anchor;
			}

			// Check if the element or its parent is a header element (cm-header class)
			let currentElement: Node | null = domAtPos.node;
			let depth = 0;
			while (currentElement && currentElement.nodeType !== Node.DOCUMENT_NODE && depth < 10) {
				if (currentElement.nodeType === Node.ELEMENT_NODE) {
					const el = currentElement as Element;
					if (el.classList && el.classList.contains('cm-header')) {
						// Only return anchor if it's not empty
						if (anchor && anchor.length > 0) {
							return anchor;
						}
						return null;
					}
				}
				currentElement = currentElement.parentNode;
				depth++;
			}

			return null;
		} catch (error) {
			return null;
		}
	}
}
