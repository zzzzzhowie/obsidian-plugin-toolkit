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

		// Remember the last file-explorer item pressed, and forget it on a press anywhere else.
		// One listener on the document does both: file-explorer items are non-focusable divs,
		// so document.activeElement never says where the user is. (It used to be one listener
		// per file explorer, plus another added on every layout change.)
		const handleMouseDown = (evt: MouseEvent) => {
			const target = evt.target instanceof HTMLElement ? evt.target : null;
			const inExplorer = target?.closest('.workspace-leaf-content[data-type="file-explorer"]');
			if (!inExplorer) {
				this.lastExplorerPath = null;
				return;
			}
			// Both .nav-file-title and .nav-folder-title carry data-path.
			const path = target?.closest<HTMLElement>('[data-path]')?.dataset.path;
			if (path) this.lastExplorerPath = path;
		};
		document.addEventListener('mousedown', handleMouseDown, true);
		this.register(() => {
			document.removeEventListener('mousedown', handleMouseDown, true);
		});
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
				// The inline title (the filename shown atop the note) is a separate
				// element from the CM editor, so clicking it never moves the editor
				// cursor — the last heading the cursor sat on would otherwise leak
				// through as a stale anchor. Clicking the title means "the file itself",
				// so emit the bare path with no header anchor.
				const onInlineTitle = activeElement?.closest('.inline-title') != null;
				const headerAnchor = onInlineTitle
					? null
					: this.getCurrentHeaderAnchor(activeView);
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
			if (activeView?.file) {
				// @ts-ignore
				const absolutePath: string = vault.adapter.getFullPath(activeView.file.path);
				await navigator.clipboard.writeText(`"${absolutePath}"`);
				new Notice(`Path copied: "${absolutePath}"`);
				return;
			}

			// ── VAULT ROOT FALLBACK ────────────────────────────────────────────
			// No window focused, no file open, no explorer selection —
			// fall back to the vault's root directory path.
			// @ts-ignore - getFullPath exists on adapter but not in public types
			const vaultPath: string = vault.adapter.getFullPath('/');
			// Remove trailing slash if present
			const cleanVaultPath = vaultPath.replace(/\/$/, '');
			await navigator.clipboard.writeText(`"${cleanVaultPath}"`);
			new Notice(`Vault path copied: "${cleanVaultPath}"`);
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
