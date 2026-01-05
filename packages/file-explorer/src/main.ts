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
				}
			)
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
			})
		);

		// Add settings tab
		this.addSettingTab(new MyPluginSettingTab(this.app, this));
	}

	onunload() {
		this.pinnedItemsManager.cleanup();
	}

	addContextMenuItems(menu: Menu, file: TAbstractFile) {
		// Add pin/unpin menu item
		const isPinned = this.settings.pinnedItems.some(
			(item) => item.path === file.path
		);

		if (!isPinned) {
			menu.addItem((item) => {
				item.setTitle("📌 Pin to top")
					.setIcon("pin")
					.onClick(async () => {
						await this.pinnedItemsManager.pinItem(file);
					});
			});
		} else {
			menu.addItem((item) => {
				item.setTitle("📌 Unpin")
					.setIcon("pin-off")
					.onClick(async () => {
						await this.pinnedItemsManager.unpinItem(file.path);
					});
			});
		}

		// Add folder note menu items for folders
		if (file instanceof TFolder) {
			this.folderNoteManager.addContextMenuItems(menu, file);
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
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
				"Show an indicator (📝) next to folders that have a folder note (a markdown file with the same name as the folder)."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showFolderNotes)
					.onChange(async (value) => {
						this.plugin.settings.showFolderNotes = value;
						await this.plugin.saveSettings();
						this.plugin.folderNoteManager.updateAllFolderNotes();
					})
			);

		// File count settings
		new Setting(containerEl)
			.setName("Show file count")
			.setDesc(
				"Show the number of files in each folder. Displays as 'direct/total' where direct is the number of files directly in the folder and total includes subfolders."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showFileCount)
					.onChange(async (value) => {
						this.plugin.settings.showFileCount = value;
						await this.plugin.saveSettings();
						this.plugin.fileCountManager.updateAllFileCounts();
					})
			);

		containerEl.createEl("h3", { text: "Pinned Items" });

		new Setting(containerEl)
			.setName("Pin files and folders")
			.setDesc(
				"Right-click on any file or folder in the file explorer to pin it to the top for quick access."
			);

		// Display current pinned items
		if (this.plugin.settings.pinnedItems.length > 0) {
			containerEl.createEl("h4", { text: "Currently pinned:" });
			containerEl.createEl("p", {
				text: "Drag items to reorder them. Changes sync automatically across devices.",
				cls: "setting-item-description",
			});

			const listEl = containerEl.createEl("ul", {
				cls: "pinned-items-list",
			});

			// Sort items by order for display
			const sortedItems = [...this.plugin.settings.pinnedItems].sort(
				(a, b) => {
					const orderA = a.order ?? 0;
					const orderB = b.order ?? 0;
					if (orderA !== orderB) {
						return orderA - orderB;
					}
					return a.name.localeCompare(b.name);
				}
			);

			sortedItems.forEach((item, index) => {
				const itemEl = listEl.createEl("li");
				itemEl.setAttr("draggable", "true");
				itemEl.dataset.path = item.path;
				itemEl.style.cursor = "move";

				// Drag handle icon
				itemEl.createSpan({
					text: "⋮⋮",
					cls: "pinned-item-drag-handle",
				});

				itemEl.createSpan({
					text: `${item.type === "folder" ? "📁" : "📄"} ${
						item.path
					}`,
					cls: "pinned-item-path",
				});

				const removeBtn = itemEl.createEl("button", {
					text: "Remove",
					cls: "pinned-item-remove-btn",
				});

				removeBtn.addEventListener("click", async () => {
					await this.plugin.pinnedItemsManager.unpinItem(item.path);
					this.display(); // Refresh the settings display
				});

				// Drag and drop handlers
				itemEl.addEventListener("dragstart", (e) => {
					if (e.dataTransfer) {
						e.dataTransfer.effectAllowed = "move";
						e.dataTransfer.setData("text/plain", item.path);
					}
					itemEl.classList.add("dragging");
					setTimeout(() => {
						itemEl.style.display = "none";
					}, 0);
				});

				itemEl.addEventListener("dragend", (e) => {
					itemEl.classList.remove("dragging");
					itemEl.style.display = "";
					// Remove drag-over class from all items
					listEl.querySelectorAll(".drag-over").forEach((el) => {
						el.classList.remove("drag-over");
					});
				});

				itemEl.addEventListener("dragover", (e) => {
					e.preventDefault();
					if (e.dataTransfer) {
						e.dataTransfer.dropEffect = "move";
					}
					const dragging = listEl.querySelector(".dragging") as HTMLElement;
					if (!dragging) return;

					const afterElement = this.getDragAfterElement(
						listEl,
						e.clientY
					);
					if (afterElement == null) {
						listEl.appendChild(dragging);
					} else {
						listEl.insertBefore(dragging, afterElement);
					}
				});

				itemEl.addEventListener("dragenter", (e) => {
					e.preventDefault();
					if (!itemEl.classList.contains("dragging")) {
						itemEl.classList.add("drag-over");
					}
				});

				itemEl.addEventListener("dragleave", () => {
					itemEl.classList.remove("drag-over");
				});

				itemEl.addEventListener("drop", async (e) => {
					e.preventDefault();
					itemEl.classList.remove("drag-over");
					const draggedPath = e.dataTransfer?.getData("text/plain");
					if (!draggedPath || draggedPath === item.path) return;

					// Reorder items based on current DOM order
					const newOrder: { path: string; order: number }[] = [];
					const children = Array.from(listEl.children) as HTMLElement[];
					children.forEach((child, idx) => {
						const path = child.dataset.path;
						if (path) {
							newOrder.push({ path, order: idx });
						}
					});

					await this.plugin.pinnedItemsManager.reorderItems(newOrder);
					this.display(); // Refresh the settings display
				});
			});

			new Setting(containerEl)
				.setName("Clear all pinned items")
				.setDesc("Remove all pinned items at once")
				.addButton((button) =>
					button
						.setButtonText("Clear all")
						.setWarning()
						.onClick(async () => {
							this.plugin.settings.pinnedItems = [];
							await this.plugin.saveSettings();
							this.plugin.pinnedItemsManager.refreshPinnedItems();
							this.display();
						})
				);
		} else {
			containerEl.createEl("p", {
				text: "No items pinned yet. Right-click on any file or folder to pin it.",
				cls: "setting-item-description",
			});
		}
	}

	private getDragAfterElement(
		container: HTMLElement,
		y: number
	): HTMLElement | null {
		const draggableElements = Array.from(
			container.querySelectorAll("li:not(.dragging)")
		) as HTMLElement[];

		return draggableElements.reduce(
			(closest, child) => {
				const box = child.getBoundingClientRect();
				const offset = y - box.top - box.height / 2;

				if (offset < 0 && offset > closest.offset) {
					return { offset: offset, element: child };
				} else {
					return closest;
				}
			},
			{ offset: Number.NEGATIVE_INFINITY, element: null as HTMLElement | null }
		).element;
	}
}

