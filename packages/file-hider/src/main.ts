import { Notice, Plugin, TAbstractFile, TFolder } from 'obsidian';
import { DEFAULT_SETTINGS, FileHiderSettings, FileHiderSettingTab } from './settings';

export default class FileHiderPlugin extends Plugin {
	settings: FileHiderSettings;

	/** The <style> element we inject into the document to hide paths */
	private styleEl: HTMLStyleElement | null = null;

	async onload() {
		await this.loadSettings();

		// Inject a <style> element and populate it
		this.styleEl = document.createElement('style');
		this.styleEl.id = 'file-hider-styles';
		document.head.appendChild(this.styleEl);
		this.refreshStyles();

		// Register right-click context menu on the file explorer
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file: TAbstractFile) => {
				const isHidden = this.settings.hiddenPaths.includes(file.path);
				const label = file instanceof TFolder ? 'Folder' : 'File';

				if (isHidden) {
					menu.addItem((item) => {
						item.setTitle(`Unhide ${label}`)
							.setIcon('eye')
							.onClick(() => {
								void this.unhidePath(file.path);
							});
					});
				} else {
					menu.addItem((item) => {
						item.setTitle(`Hide ${label}`)
							.setIcon('eye-off')
							.onClick(() => {
								void this.hidePath(file.path);
							});
					});
				}
			})
		);

		// Register command: toggle visibility of all hidden items
		this.addCommand({
			id: 'toggle-hidden-visibility',
			name: 'Toggle hidden file visibility',
			callback: () => {
				this.settings.hidden = !this.settings.hidden;
				void this.saveSettings();
				this.refreshStyles();
				new Notice(this.settings.hidden ? 'Hidden files: invisible' : 'Hidden files: visible');
			},
		});

		// Settings tab
		this.addSettingTab(new FileHiderSettingTab(this.app, this));
	}

	onunload() {
		// Remove the injected style element
		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = null;
		}
	}

	/**
	 * Rebuild the CSS rules that hide file-explorer nodes.
	 *
	 * Exact paths use `[data-path="..."]`.
	 * Wildcard patterns use `[data-path$="/name"]` (ends-with) plus an exact
	 * match for top-level items — matching the name at any nesting depth.
	 *
	 * When `settings.hidden` is false (items revealed), we emit no rules.
	 */
	refreshStyles(): void {
		if (!this.styleEl) return;

		const hasPaths = this.settings.hiddenPaths.length > 0;
		const hasPatterns = this.settings.hiddenPatterns.length > 0;

		if (!this.settings.hidden || (!hasPaths && !hasPatterns)) {
			this.styleEl.textContent = '';
			return;
		}

		const rules: string[] = [];

		// Exact path rules
		for (const p of this.settings.hiddenPaths) {
			const escaped = CSS.escape(p);
			rules.push(
				`.nav-file:has(> .nav-file-title[data-path="${escaped}"]) { display: none !important; }`,
				`.nav-folder:has(> .nav-folder-title[data-path="${escaped}"]) { display: none !important; }`,
			);
		}

		// Wildcard pattern rules
		// Pattern "attachments" or "**/attachments" both hide anything whose
		// path equals "attachments" OR ends with "/attachments" (any depth).
		for (const rawPattern of this.settings.hiddenPatterns) {
			// Strip glob prefix for CSS generation
			const name = rawPattern.startsWith('**/') ? rawPattern.slice(3) : rawPattern;
			const escaped = CSS.escape(name);
			const suffix = CSS.escape(`/${name}`);
			rules.push(
				// Top-level exact match
				`.nav-file:has(> .nav-file-title[data-path="${escaped}"]) { display: none !important; }`,
				`.nav-folder:has(> .nav-folder-title[data-path="${escaped}"]) { display: none !important; }`,
				// Nested match (ends with "/name")
				`.nav-file:has(> .nav-file-title[data-path$="${suffix}"]) { display: none !important; }`,
				`.nav-folder:has(> .nav-folder-title[data-path$="${suffix}"]) { display: none !important; }`,
			);
		}

		this.styleEl.textContent = rules.join('\n');
	}

	/** Add a path to the hidden list */
	async hidePath(path: string): Promise<void> {
		if (this.settings.hiddenPaths.includes(path)) return;
		this.settings.hiddenPaths.push(path);
		await this.saveSettings();
		this.refreshStyles();
	}

	/** Remove a path from the hidden list */
	async unhidePath(path: string): Promise<void> {
		this.settings.hiddenPaths = this.settings.hiddenPaths.filter((p) => p !== path);
		await this.saveSettings();
		this.refreshStyles();
	}

	/** Add a wildcard pattern */
	async addPattern(pattern: string): Promise<void> {
		if (this.settings.hiddenPatterns.includes(pattern)) return;
		this.settings.hiddenPatterns.push(pattern);
		await this.saveSettings();
		this.refreshStyles();
	}

	/** Remove a wildcard pattern */
	async removePattern(pattern: string): Promise<void> {
		this.settings.hiddenPatterns = this.settings.hiddenPatterns.filter((p) => p !== pattern);
		await this.saveSettings();
		this.refreshStyles();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<FileHiderSettings>
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
