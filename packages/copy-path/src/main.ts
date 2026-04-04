import { Editor, MarkdownView, Notice, Plugin, TAbstractFile } from 'obsidian';

export default class CopyPathPlugin extends Plugin {
	/**
	 * Vault-relative path of the last item the user clicked/hovered in the file explorer.
	 * Used because file-explorer nav items are not real focusable DOM elements,
	 * so document.activeElement never lands inside them.
	 */
	private lastExplorerPath: string | null = null;

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

		// Wait for layout to be ready before registering file-explorer tracking,
		// because the file-explorer leaf may not exist during onload.
		this.app.workspace.onLayoutReady(() => {
			this.registerExplorerTracking();
		});

		// Keyboard listener — fires on Mod+Alt+C anywhere that is NOT an input/modal.
		// We intentionally do NOT restrict to "editor" or "file explorer" focus,
		// because file-explorer nav items are non-focusable divs and never receive
		// document.activeElement focus.
		const handleKeyDown = (evt: KeyboardEvent) => {
			// Use evt.code because on macOS, Option+C produces 'ç' not 'c'
			const isMod = evt.metaKey || evt.ctrlKey;
			const isAlt = evt.altKey;
			const isC = evt.code === 'KeyC';

			if (!isMod || !isAlt || !isC) return;

			const activeElement = document.activeElement;

			// Skip input fields, command palette, modals, etc.
			const isInputField =
				activeElement?.tagName === 'INPUT' ||
				activeElement?.tagName === 'TEXTAREA' ||
				activeElement?.closest('.prompt') !== null ||
				activeElement?.closest('.modal') !== null ||
				activeElement?.closest('.suggestion-container') !== null;

			if (isInputField) return;

			evt.preventDefault();
			evt.stopPropagation();
			evt.stopImmediatePropagation();
			this.copyAbsolutePath();
		};

		// Capture phase so we intercept before CodeMirror or other handlers
		document.addEventListener('keydown', handleKeyDown, true);
		this.register(() => {
			document.removeEventListener('keydown', handleKeyDown, true);
		});
	}

	onunload() {}

	/**
	 * Register a mousedown listener (via event delegation) on the file explorer
	 * container so we always know the last item the user interacted with,
	 * regardless of whether keyboard focus moved elsewhere.
	 */
	private registerExplorerTracking() {
		const leaves = this.app.workspace.getLeavesOfType('file-explorer');
		for (const leaf of leaves) {
			this.registerDomEvent(
				leaf.view.containerEl,
				'mousedown',
				(evt: MouseEvent) => {
					const target = evt.target as HTMLElement | null;
					if (!target) return;
					// Walk up from the clicked element to find the nearest [data-path] node.
					// Both .nav-file-title and .nav-folder-title carry data-path in Obsidian.
					const item = target.closest('[data-path]') as HTMLElement | null;
					if (item?.dataset.path) {
						this.lastExplorerPath = item.dataset.path;
					}
				}
			);
		}

		// Also handle new file-explorer leaves opened after startup (rare, but safe)
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				const currentLeaves = this.app.workspace.getLeavesOfType('file-explorer');
				for (const leaf of currentLeaves) {
					// registerDomEvent is idempotent for the same element+type combo
					// in practice each leaf is new so this is fine
					this.registerDomEvent(
						leaf.view.containerEl,
						'mousedown',
						(evt: MouseEvent) => {
							const target = evt.target as HTMLElement | null;
							if (!target) return;
							const item = target.closest('[data-path]') as HTMLElement | null;
							if (item?.dataset.path) {
								this.lastExplorerPath = item.dataset.path;
							}
						}
					);
				}
			})
		);
	}

	private async copyAbsolutePath() {
		try {
			const vault = this.app.vault;
			const activeElement = document.activeElement;

			// Determine if keyboard focus is currently inside a Markdown editor.
			const isInEditor =
				activeElement?.closest('.cm-editor') !== null ||
				activeElement?.closest('.markdown-source-view') !== null ||
				activeElement?.closest('.markdown-preview-view') !== null;

			if (isInEditor) {
				// ── EDITOR CONTEXT ────────────────────────────────────────────
				// Copy the currently open file's path, optionally with a header anchor.
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView?.file) return;

				// @ts-ignore - getFullPath exists on adapter but not in public types
				const absolutePath: string = vault.adapter.getFullPath(activeView.file.path);
				const headerAnchor = this.getCurrentHeaderAnchor(activeView);
				const pathWithAnchor = headerAnchor ? `${absolutePath}#${headerAnchor}` : absolutePath;

				await navigator.clipboard.writeText(`"${pathWithAnchor}"`);
				new Notice(`Path copied: "${pathWithAnchor}"`);
				return;
			}

			// ── FILE EXPLORER CONTEXT ─────────────────────────────────────────
			// Focus is NOT in editor (e.g. user clicked a folder/file in the sidebar).
			// Use the last item the user moused-down on inside the file explorer.
			if (this.lastExplorerPath) {
				const abstractFile = vault.getAbstractFileByPath(this.lastExplorerPath);
				if (abstractFile) {
					// @ts-ignore - getFullPath exists on adapter but not in public types
					const absolutePath: string = vault.adapter.getFullPath(abstractFile.path);
					await navigator.clipboard.writeText(`"${absolutePath}"`);
					new Notice(`Path copied: "${absolutePath}"`);
					return;
				}
			}

			// ── FALLBACK ──────────────────────────────────────────────────────
			// Editor not active, no explorer selection — try whatever is open.
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView?.file) return;

			// @ts-ignore
			const absolutePath: string = vault.adapter.getFullPath(activeView.file.path);
			await navigator.clipboard.writeText(`"${absolutePath}"`);
			new Notice(`Path copied: "${absolutePath}"`);
		} catch {
			// Silently fail
		}
	}

	private getCurrentHeaderAnchor(view: MarkdownView): string | null {
		try {
			const editor = view.editor;
			const cursor = editor.getCursor();
			const line = editor.getLine(cursor.line);

			// Don't treat # inside code blocks as headers
			if (this.isInCodeBlock(editor, cursor.line)) {
				return null;
			}

			const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
			if (!headerMatch || !headerMatch[2]) {
				return null;
			}

			const headerText = headerMatch[2].trim();

			// Convert header text to anchor format
			// Keep Chinese characters, only replace spaces with hyphens
			const anchor = headerText
				.replace(/\s+/g, '-')
				.replace(/-+/g, '-')
				.replace(/^-|-$/g, '');

			if (!anchor) return null;

			// @ts-ignore - cm property exists but not in types
			const cmEditor = editor.cm;
			const state = cmEditor.state;
			const lineStart = state.doc.line(cursor.line + 1).from;
			const lineEnd = state.doc.line(cursor.line + 1).to;
			const checkOffset = cursor.ch === 0 ? Math.min(lineStart + 1, lineEnd) : lineStart + cursor.ch;

			const domAtPos = cmEditor.domAtPos(checkOffset);
			if (!domAtPos?.node) return anchor;

			let currentElement: Node | null = domAtPos.node;
			let depth = 0;
			while (currentElement && currentElement.nodeType !== Node.DOCUMENT_NODE && depth < 10) {
				if (currentElement.nodeType === Node.ELEMENT_NODE) {
					if ((currentElement as Element).classList?.contains('cm-header')) {
						return anchor;
					}
				}
				currentElement = currentElement.parentNode;
				depth++;
			}

			return anchor;
		} catch {
			return null;
		}
	}

	/**
	 * Check if a given line is inside a fenced code block by scanning from the
	 * top of the document. Uses CodeMirror state for reliability.
	 */
	private isInCodeBlock(editor: Editor, lineNumber: number): boolean {
		try {
			// @ts-ignore
			const cmEditor = editor.cm;
			if (!cmEditor?.state) return false;

			const state = cmEditor.state;
			let inFencedBlock = false;
			let fenceMarker = '';

			for (let i = 1; i <= lineNumber + 1; i++) {
				const text = state.doc.line(i).text as string;
				const fenceMatch = text.match(/^(`{3,}|~{3,})/);
				const fenceStr = fenceMatch?.[1];
				if (fenceMatch && fenceStr) {
					const fenceChar = fenceStr.charAt(0);
					if (!inFencedBlock) {
						inFencedBlock = true;
						fenceMarker = fenceChar;
					} else if (fenceChar === fenceMarker) {
						const minLen = Math.max(fenceStr.length, fenceMarker.length);
						if (text.startsWith(fenceChar.repeat(minLen))) {
							inFencedBlock = false;
							fenceMarker = '';
						}
					}
				}
			}

			return inFencedBlock;
		} catch {
			return false;
		}
	}
}
