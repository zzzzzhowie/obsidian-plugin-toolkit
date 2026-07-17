import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Menu,
	TAbstractFile,
	TFolder,
} from "obsidian";
import { MyPluginSettings, DEFAULT_SETTINGS } from "./settings";
import { PinnedItemsManager } from "./pinned-items";
import { FolderNoteManager } from "./folder-note";
import { FileCountManager } from "./file-count";

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	pinnedItemsManager: PinnedItemsManager;
	folderNoteManager: FolderNoteManager;
	fileCountManager: FileCountManager;
	private lastSettingsHash: string = "";
	// The pane the user last clicked in, used to scope the sidebar hotkeys.
	private lastPointerZone: "file-tree" | "right" | "other" = "other";

	async onload() {
		await this.loadSettings();

		// Initialize managers
		this.pinnedItemsManager = new PinnedItemsManager(this.app, this);
		this.folderNoteManager = new FolderNoteManager(this.app, this);
		this.fileCountManager = new FileCountManager(this.app, this);

		// Initialize features
		this.pinnedItemsManager.initialize();
		this.folderNoteManager.initialize();
		this.fileCountManager.initialize();

		// Register context menu event for files and folders
		this.registerEvent(
			this.app.workspace.on(
				"file-menu",
				(menu: Menu, file: TAbstractFile) => {
					this.addContextMenuItems(menu, file);
				},
			),
		);

		// VSCode-style sidebar toggles, scoped to the pane you last interacted
		// with:
		//  - Cmd/Ctrl+B while the left file tree is active -> toggle left sidebar
		//  - Cmd/Ctrl+L while the right sidebar is active  -> toggle right sidebar
		// Obsidian does NOT move DOM focus into the file explorer / sidebars
		// (document.activeElement stays <body>), so :focus can't tell us where we
		// are. Instead we remember the last pointer target's pane. Anything else
		// (e.g. the editor) is left untouched so defaults still work (Cmd+B = bold).
		this.registerDomEvent(
			document,
			"pointerdown",
			(evt) => {
				const target = evt.target as HTMLElement | null;
				if (
					target?.closest(
						'.workspace-leaf-content[data-type="file-explorer"]',
					)
				) {
					this.lastPointerZone = "file-tree";
				} else if (target?.closest(".mod-right-split")) {
					this.lastPointerZone = "right";
				} else {
					this.lastPointerZone = "other";
				}
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

				if (key === "b" && this.lastPointerZone === "file-tree") {
					evt.preventDefault();
					evt.stopPropagation();
					this.app.workspace.leftSplit.toggle();
					return;
				}

				if (key === "l" && this.lastPointerZone === "right") {
					evt.preventDefault();
					evt.stopPropagation();
					this.app.workspace.rightSplit.toggle();
				}
			},
			{ capture: true },
		);

		// Initialize settings hash
		this.lastSettingsHash = JSON.stringify(this.settings);

		// Listen for vault changes to detect sync updates
		// When settings are synced from another device via Obsidian Sync, reload them
		// Obsidian Sync automatically syncs .obsidian/plugins/<plugin-id>/data.json
		const pluginDataPath = `.obsidian/plugins/${this.manifest.id}/data.json`;

		const checkSettingsSync = async () => {
			try {
				const currentSettings = await this.loadData();
				const currentHash = JSON.stringify(currentSettings);
				if (currentHash !== this.lastSettingsHash) {
					// Settings changed (likely from sync)
					await this.loadSettings();
					this.lastSettingsHash = JSON.stringify(this.settings);
					this.pinnedItemsManager.refreshPinnedItems();
				}
			} catch (error) {
				// Ignore errors during sync check
			}
		};

		// Check for sync updates periodically (every 2 seconds)
		this.registerInterval(window.setInterval(checkSettingsSync, 2000));

		// Also listen for file modifications as a backup
		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				if (file.path === pluginDataPath) {
					await checkSettingsSync();
				}
			}),
		);

		// Add settings tab
		this.addSettingTab(new MyPluginSettingTab(this.app, this));
	}

	onunload() {
		this.pinnedItemsManager.cleanup();
		this.folderNoteManager.removeDynamicStyles();
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

	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);

		// Migrate old pinned items without order field
		let needsSave = false;
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
		// Update hash after saving
		this.lastSettingsHash = JSON.stringify(this.settings);
	}
}

class MyPluginSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "File Explorer Enhancements" });

		// Folder note settings
		new Setting(containerEl)
			.setName("Show folder notes")
			.setDesc(
				"Show an indicator (📝) next to folders that have a folder note (a markdown file with the same name as the folder).",
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
				"Show the number of files in each folder. Displays as 'direct/total' where direct is the number of files directly in the folder and total includes subfolders.",
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

		containerEl.createEl("h3", { text: "Pinned Items" });

		new Setting(containerEl)
			.setName("Pin files and folders")
			.setDesc(
				"Right-click on any file or folder in the file explorer to pin it to the top. Reorder pinned items by dragging them directly in the file explorer; remove one by hovering it and clicking ×.",
			);
	}
}
