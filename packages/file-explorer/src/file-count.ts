import { App, TFolder, TFile } from "obsidian";
import { countFilesInFolder, countDirectFiles, escapeCSSSelector } from "./utils";
import type MyPlugin from "./main";

export class FileCountManager {
	app: App;
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	initialize() {
		// Add file count to file explorer when layout is ready
		this.app.workspace.onLayoutReady(() => {
			// Initial update with multiple retries for iOS
			setTimeout(() => {
				this.updateAllFileCounts();
			}, 300);
			
			// Retry after 1 second for iOS compatibility
			setTimeout(() => {
				this.updateAllFileCounts();
			}, 1000);
			
			// Final retry after 2 seconds
			setTimeout(() => {
				this.updateAllFileCounts();
			}, 2000);
		});

		// Also update on sidebar toggle to ensure class is applied
		this.plugin.registerEvent(
			this.app.workspace.on("layout-change", () => {
				setTimeout(() => {
					if (this.plugin.settings.showFileCount) {
						this.addFileCountClass();
					} else {
						this.removeFileCountClass();
					}
				}, 100);
			})
		);

		// Update when files are created/renamed/deleted
		this.plugin.registerEvent(
			this.app.vault.on("create", (file) => {
				setTimeout(() => {
					if (file instanceof TFile) {
						const parent = file.parent;
						if (parent) {
							this.updateFileCount(parent);
							this.updateParentCounts(parent);
						}
					} else if (file instanceof TFolder) {
						this.updateFileCount(file);
						if (file.parent) {
							this.updateParentCounts(file.parent);
						}
					}
				}, 100);
			})
		);

		this.plugin.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				setTimeout(() => {
					if (file instanceof TFile) {
						const parent = file.parent;
						if (parent) {
							this.updateFileCount(parent);
							this.updateParentCounts(parent);
						}
						// Also update old parent
						const oldParent = this.getParentFromPath(oldPath);
						if (oldParent) {
							this.updateFileCount(oldParent);
							this.updateParentCounts(oldParent);
						}
					} else if (file instanceof TFolder) {
						this.updateFileCount(file);
						if (file.parent) {
							this.updateParentCounts(file.parent);
						}
					}
				}, 100);
			})
		);

		this.plugin.registerEvent(
			this.app.vault.on("delete", (file) => {
				setTimeout(() => {
					if (file instanceof TFile) {
						const parent = file.parent;
						if (parent) {
							this.updateFileCount(parent);
							this.updateParentCounts(parent);
						}
					} else if (file instanceof TFolder) {
						if (file.parent) {
							this.updateFileCount(file.parent);
							this.updateParentCounts(file.parent);
						}
					}
				}, 100);
			})
		);

		// Update when file explorer is expanded/collapsed
		this.plugin.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				setTimeout(() => {
					this.updateAllFileCounts();
				}, 200);
			})
		);
	}

	private getParentFromPath(path: string): TFolder | null {
		const parts = path.split("/");
		parts.pop(); // Remove file name
		const parentPath = parts.join("/");
		if (!parentPath) return this.app.vault.getRoot();
		
		const parent = this.app.vault.getAbstractFileByPath(parentPath);
		return parent instanceof TFolder ? parent : null;
	}

	private updateParentCounts(folder: TFolder) {
		let current = folder.parent;
		while (current) {
			this.updateFileCount(current);
			current = current.parent;
		}
	}

	updateAllFileCounts() {
		if (!this.plugin.settings.showFileCount) {
			// Remove all existing badges when disabled
			this.removeAllBadges();
			// Remove the class that adds padding
			this.removeFileCountClass();
			return;
		}

		// Add class to enable padding for badges
		this.addFileCountClass();

		const folders = this.getAllFolders();
		folders.forEach((folder) => {
			this.updateFileCount(folder);
		});
	}

	private removeAllBadges() {
		const fileExplorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
		if (!fileExplorerLeaves || fileExplorerLeaves.length === 0) {
			return;
		}

		const fileExplorer = fileExplorerLeaves[0];
		if (!fileExplorer) {
			return;
		}
		const fileExplorerView = fileExplorer.view as {
			containerEl?: HTMLElement;
		};

		if (!fileExplorerView.containerEl) {
			return;
		}

		// Remove all file count badges
		const badges = fileExplorerView.containerEl.querySelectorAll('.file-count-badge');
		badges.forEach((badge) => badge.remove());
	}

	private addFileCountClass() {
		const fileExplorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
		if (!fileExplorerLeaves || fileExplorerLeaves.length === 0) {
			return;
		}

		const fileExplorer = fileExplorerLeaves[0];
		if (!fileExplorer) {
			return;
		}
		const fileExplorerView = fileExplorer.view as {
			containerEl?: HTMLElement;
		};

		if (!fileExplorerView.containerEl) {
			return;
		}

		// Add class to container to enable file count styles
		fileExplorerView.containerEl.addClass('file-count-enabled');
	}

	private removeFileCountClass() {
		const fileExplorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
		if (!fileExplorerLeaves || fileExplorerLeaves.length === 0) {
			return;
		}

		const fileExplorer = fileExplorerLeaves[0];
		if (!fileExplorer) {
			return;
		}
		const fileExplorerView = fileExplorer.view as {
			containerEl?: HTMLElement;
		};

		if (!fileExplorerView.containerEl) {
			return;
		}

		// Remove class from container
		fileExplorerView.containerEl.removeClass('file-count-enabled');
	}

	private getAllFolders(): TFolder[] {
		const folders: TFolder[] = [];
		
		const collectFolders = (folder: TFolder) => {
			folders.push(folder);
			folder.children.forEach((child) => {
				if (child instanceof TFolder) {
					collectFolders(child);
				}
			});
		};

		collectFolders(this.app.vault.getRoot());
		return folders;
	}

	updateFileCount(folder: TFolder) {
		if (!this.plugin.settings.showFileCount) return;

		const folderTitleEl = this.getFolderElement(folder);
		if (!folderTitleEl) {
			// Folder not visible in DOM (probably collapsed), skip silently
			return;
		}

		// Remove existing count badge
		const existingBadge = folderTitleEl.querySelector(".file-count-badge");
		if (existingBadge) {
			existingBadge.remove();
		}

		// Count files (recursive - includes all files in subfolders)
		const totalCount = countFilesInFolder(folder, true);

		if (totalCount > 0) {
			// folderTitleEl is already the .nav-folder-title element
			const badge = createSpan({
				cls: "file-count-badge",
			});

			// Show only total count
			badge.setText(`${totalCount}`);
			badge.setAttribute("aria-label", `${totalCount} file(s) in this folder (including subfolders)`);

			// Append to nav-folder-title element
			folderTitleEl.appendChild(badge);
		}
	}

	private getFolderElement(folder: TFolder): HTMLElement | null {
		const fileExplorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
		if (!fileExplorerLeaves || fileExplorerLeaves.length === 0) {
			return null;
		}

		const fileExplorer = fileExplorerLeaves[0];
		if (!fileExplorer) {
			return null;
		}
		const fileExplorerView = fileExplorer.view as {
			containerEl?: HTMLElement;
		};

		if (!fileExplorerView.containerEl) {
			return null;
		}

		// Find the folder title element by data-path attribute with escaped path
		const escapedPath = escapeCSSSelector(folder.path);
		const folderTitleElements = fileExplorerView.containerEl.querySelectorAll(
			`.nav-folder-title[data-path="${escapedPath}"]`
		);

		return folderTitleElements.length > 0 ? (folderTitleElements[0] as HTMLElement) : null;
	}
}

