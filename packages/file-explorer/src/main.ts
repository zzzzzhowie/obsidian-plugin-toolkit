import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	Menu,
	TAbstractFile,
	TFolder,
	TFile,
} from "obsidian";
import { FileExplorerSettings, DEFAULT_SETTINGS } from "./settings";
import { getFolderFromNote, getFolderNote } from "./utils";
import { PinnedItemsManager } from "./pinned-items";
import { FolderNoteManager } from "./folder-note";
import { FileCountManager } from "./file-count";
import { FileHiderManager } from "./hider";
import { registerReuseTab } from "./reuse-tab";
import { openInBrowserSupported, openInDefaultBrowser, placeAfterSectionStart } from "./open-in-browser";

/** The `file-menu` sources that get "Open in default browser". */
const BROWSER_MENU_SOURCES = new Set(["file-explorer-context-menu", "tab-header", "more-options"]);

export default class FileExplorerPlugin extends Plugin {
	settings: FileExplorerSettings;
	pinnedItemsManager: PinnedItemsManager;
	folderNoteManager: FolderNoteManager;
	fileCountManager: FileCountManager;
	fileHiderManager: FileHiderManager;
	// Whether the pane last clicked in was the file tree, which scopes Cmd/Ctrl+B.
	private lastPointerInFileTree = false;

	async onload() {
		await this.loadSettings();

		// Initialize managers
		this.pinnedItemsManager = new PinnedItemsManager(this.app, this);
		this.folderNoteManager = new FolderNoteManager(this.app, this);
		this.fileCountManager = new FileCountManager(this.app, this);
		this.fileHiderManager = new FileHiderManager(this.app, this);

		// Initialize features
		this.pinnedItemsManager.initialize();
		this.folderNoteManager.initialize();
		this.fileCountManager.initialize();
		this.fileHiderManager.initialize();

		// Command: toggle visibility of all hidden items
		this.addCommand({
			id: "toggle-hidden-visibility",
			name: "Toggle hidden file visibility",
			callback: () => {
				this.settings.hideFiles = !this.settings.hideFiles;
				void this.saveSettings();
				this.fileHiderManager.refreshStyles();
				new Notice(
					this.settings.hideFiles
						? "Hidden files: invisible"
						: "Hidden files: visible",
				);
			},
		});

		// Register context menu event for files and folders
		this.registerEvent(
			this.app.workspace.on(
				"file-menu",
				(menu: Menu, file: TAbstractFile, source: string) => {
					this.addContextMenuItems(menu, file);
					// From the file explorer, a tab's right-click menu and the note's "⋯" menu —
					// the menus Obsidian itself puts file actions in. A folder with a folder
					// note stands for that note in the tree, so it opens the note.
					const target =
						file instanceof TFile
							? file
							: file instanceof TFolder
								? getFolderNote(file, this.app)
								: null;
					if (
						BROWSER_MENU_SOURCES.has(source) &&
						target &&
						openInBrowserSupported()
					) {
						menu.addItem((item) => {
							// Right under Obsidian's "Open in default app", above "Reveal in Finder".
							item.setTitle("Open in default browser")
								.setIcon("globe")
								.setSection("system")
								.onClick(() => {
									void openInDefaultBrowser(this.app, target);
								});
							placeAfterSectionStart(menu, item, "system");
						});
					}
				},
			),
		);

		// Mod-click a file that is already open goes to that tab instead of opening
		// a second one for it. See reuse-tab.ts.
		registerReuseTab(this);

		// VSCode-style sidebar toggle, scoped to the pane you last interacted
		// with:
		//  - Cmd/Ctrl+B while the left file tree is active -> toggle left sidebar
		// (Cmd/Ctrl+L is intentionally left alone so claudian-enhanced can use it
		// to switch the right sidebar between Outline and Claudian.)
		// Obsidian does NOT move DOM focus into the file explorer / sidebars
		// (document.activeElement stays <body>), so :focus can't tell us where we
		// are. Instead we remember the last pointer target's pane. Anything else
		// (e.g. the editor) is left untouched so defaults still work (Cmd+B = bold).
		this.registerDomEvent(
			document,
			"pointerdown",
			(evt) => {
				const target = evt.target as HTMLElement | null;
				this.lastPointerInFileTree = !!target?.closest(
					'.workspace-leaf-content[data-type="file-explorer"]',
				);
			},
			{ capture: true },
		);

		this.registerDomEvent(
			window,
			"keydown",
			(evt) => {
				if (!(evt.metaKey || evt.ctrlKey) || evt.shiftKey || evt.altKey)
					return;

				const key = evt.key.toLowerCase();

				if (key === "b" && this.lastPointerInFileTree) {
					evt.preventDefault();
					evt.stopPropagation();
					this.app.workspace.leftSplit.toggle();
				}
			},
			{ capture: true },
		);

		// Add settings tab
		this.addSettingTab(new FileExplorerSettingTab(this.app, this));
	}

	onunload() {
		this.pinnedItemsManager.cleanup();
		this.folderNoteManager.cleanup();
		this.fileCountManager.cleanup();
		this.fileHiderManager.cleanup();
	}

	/**
	 * Settings changed on disk — synced in from another device. Obsidian calls this when the
	 * plugin's data.json changes, which replaces polling the file every two seconds (a poll
	 * that never settled when data.json lacked a default key, reloading forever).
	 */
	async onExternalSettingsChange() {
		await this.loadSettings();
		this.pinnedItemsManager.refreshPinnedItems();
		this.fileHiderManager.refreshStyles();
		this.folderNoteManager.updateAllFolderNotes();
		this.fileCountManager.updateAllFileCounts();
	}

	addContextMenuItems(menu: Menu, file: TAbstractFile) {
		// Add pin/unpin menu item
		const isPinned = this.settings.pinnedItems.some(
			(item) => item.path === file.path,
		);

		if (!isPinned) {
			menu.addItem((item) => {
				item.setTitle("Pin to top").onClick(async () => {
					await this.pinnedItemsManager.pinItem(file);
				});
			});
		} else {
			menu.addItem((item) => {
				item.setTitle("Unpin").onClick(async () => {
					await this.pinnedItemsManager.unpinItem(file.path);
				});
			});
		}

		// Add "new folder with note" for both files and folders.
		// Right-clicking a folder creates inside it; a file creates in its parent.
		const targetParent =
			file instanceof TFolder
				? file
				: file.parent ?? this.app.vault.getRoot();
		menu.addItem((item) => {
			// Place it in the same section as the native "New note"/"New folder"
			// items (action-primary) so it sits right below them, with no icon.
			item.setTitle("New folder with note")
				.setSection("action-primary")
				.onClick(() =>
					this.folderNoteManager.createFolderWithNote(targetParent),
				);
		});

		// Convert an existing markdown note into a folder note (moves the file
		// into a same-named sibling folder). Only offered for markdown files
		// that aren't already a folder note.
		if (
			file instanceof TFile &&
			file.extension === "md" &&
			!getFolderFromNote(file, this.app)
		) {
			menu.addItem((item) => {
				item.setTitle("Convert to folder note")
					.setSection("action-primary")
					.onClick(() =>
						this.folderNoteManager.convertToFolderNote(file),
					);
			});
		}

		// Hide / Unhide the item from the file explorer
		const isFolder = file instanceof TFolder;
		const label = isFolder ? "Folder" : "File";
		if (this.fileHiderManager.isHidden(file.path)) {
			menu.addItem((item) => {
				item.setTitle(`Unhide ${label}`)
					.setIcon("eye")
					.onClick(() => {
						void this.fileHiderManager.unhidePath(file.path);
					});
			});
		} else {
			menu.addItem((item) => {
				item.setTitle(`Hide ${label}`)
					.setIcon("eye-off")
					.onClick(() => {
						void this.fileHiderManager.hidePath(file.path);
					});
			});
		}
	}

	async loadSettings() {
		// Only carry over known keys, so fields from removed features (e.g. the old
		// virtual vaults) don't linger in data.json; they're dropped on the save below.
		const saved = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		const stale = Object.keys(saved).filter((key) => !(key in DEFAULT_SETTINGS));
		for (const key of stale) delete saved[key];
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

		// Migrate old pinned items without order field
		let needsSave = stale.length > 0;
		this.settings.pinnedItems.forEach((item, index) => {
			if (item.order === undefined) {
				item.order = index;
				needsSave = true;
			}
		});

		if (needsSave) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class FileExplorerSettingTab extends PluginSettingTab {
	plugin: FileExplorerPlugin;

	constructor(app: App, plugin: FileExplorerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Folder note settings
		new Setting(containerEl)
			.setName("Show folder notes")
			.setDesc(
				"Treat a note named after its folder (e.g. Projects/Projects.md) as the folder's note: it's hidden from the list, the folder name is underlined, and clicking the folder name opens the note.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showFolderNotes)
					.onChange(async (value) => {
						this.plugin.settings.showFolderNotes = value;
						await this.plugin.saveSettings();
						this.plugin.folderNoteManager.updateAllFolderNotes();
					}),
			);

		// File count settings
		new Setting(containerEl)
			.setName("Show file count")
			.setDesc(
				"Show the number of files in each folder, including its subfolders.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showFileCount)
					.onChange(async (value) => {
						this.plugin.settings.showFileCount = value;
						await this.plugin.saveSettings();
						this.plugin.fileCountManager.updateAllFileCounts();
					}),
			);

		this.displayHiderSettings(containerEl);
	}

	private displayHiderSettings(containerEl: HTMLElement): void {
		const hider = this.plugin.fileHiderManager;

		containerEl.createEl("h3", { text: "Hide Files & Folders" });

		// ── Name patterns ──────────────────────────────────────
		containerEl.createEl("p", {
			text: 'Patterns hide every file or folder with exactly this name, at any depth. For example, "attachments" hides every folder named "attachments" across the entire vault.',
			cls: "setting-item-description",
		});

		let inputEl: HTMLInputElement | null = null;
		const doAddPattern = async () => {
			if (!inputEl) return;
			const value = inputEl.value.trim();
			if (!value) return;
			if (this.plugin.settings.hiddenPatterns.includes(value)) return;
			await hider.addPattern(value);
			this.display();
		};

		new Setting(containerEl)
			.setName("Add pattern")
			.addText((text) => {
				text.setPlaceholder("e.g. attachments");
				inputEl = text.inputEl;
				text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
					if (e.key === "Enter") {
						void doAddPattern();
					}
				});
			})
			.addButton((btn) =>
				btn.setButtonText("Add").onClick(() => {
					void doAddPattern();
				}),
			);

		if (this.plugin.settings.hiddenPatterns.length === 0) {
			containerEl.createEl("p", {
				text: "No patterns yet.",
				cls: "setting-item-description",
			});
		} else {
			for (const pattern of this.plugin.settings.hiddenPatterns) {
				new Setting(containerEl).setName(pattern).addButton((btn) =>
					btn
						.setIcon("cross")
						.setTooltip("Remove pattern")
						.onClick(async () => {
							await hider.removePattern(pattern);
							this.display();
						}),
				);
			}
		}

		// ── Exact hidden paths ─────────────────────────────────
		containerEl.createEl("h4", { text: "Hidden paths" });

		if (this.plugin.settings.hiddenPaths.length === 0) {
			containerEl.createEl("p", {
				text: "No hidden files or folders. Right-click an item in the file explorer to hide it.",
				cls: "setting-item-description",
			});
		} else {
			for (const path of this.plugin.settings.hiddenPaths) {
				new Setting(containerEl).setName(path).addButton((btn) =>
					btn
						.setIcon("cross")
						.setTooltip("Unhide")
						.onClick(async () => {
							await hider.unhidePath(path);
							this.display();
						}),
				);
			}
		}
	}
}
