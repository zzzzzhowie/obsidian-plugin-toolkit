import { App, TFolder, TFile, Menu } from "obsidian";
import { getFolderNote, escapeCSSSelector, getFolderFromNote } from "./utils";
import type MyPlugin from "./main";

export class FolderNoteManager {
	app: App;
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	initialize() {
		// Add folder note indicator to file explorer when layout is ready
		this.app.workspace.onLayoutReady(() => {
			// Immediately hide folder notes to prevent flash
			this.hideAllFolderNotesQuick();
			
			// Multiple retries with increasing delays for better compatibility
			setTimeout(() => {
				this.updateAllFolderNotes();
			}, 50);
			
			setTimeout(() => {
				this.updateAllFolderNotes();
			}, 200);
			
			setTimeout(() => {
				this.updateAllFolderNotes();
			}, 500);
			
			setTimeout(() => {
				this.updateAllFolderNotes();
			}, 1000);
			
			setTimeout(() => {
				this.updateAllFolderNotes();
			}, 2000);
		});

		// Update when files are created/renamed/deleted
		this.plugin.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					setTimeout(() => {
						this.updateFolderNoteForFile(file);
					}, 100);
				}
			})
		);

		this.plugin.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && file.extension === "md") {
					setTimeout(() => {
						this.updateFolderNoteForFile(file);
						// Also update the old location
						const oldParent = this.getParentFromPath(oldPath);
						if (oldParent) {
							this.updateFolderNote(oldParent);
						}
					}, 100);
				}
			})
		);

		this.plugin.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					const parent = file.parent;
					if (parent) {
						setTimeout(() => {
							this.updateFolderNote(parent);
						}, 100);
					}
				}
			})
		);

		// Update on layout changes
		this.plugin.registerEvent(
			this.app.workspace.on("layout-change", () => {
				// Immediately hide to prevent flash
				this.hideAllFolderNotesQuick();
				setTimeout(() => {
					this.updateAllFolderNotes();
				}, 100);
				setTimeout(() => {
					this.updateAllFolderNotes();
				}, 500);
			})
		);

		// Update when files are opened (clicking on files might refresh DOM)
		this.plugin.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				// Check if the opened file is a folder note
				if (file instanceof TFile) {
					const folder = getFolderFromNote(file, this.app);
					if (folder) {
						// Expand the folder in file explorer with delay to ensure DOM is ready
						// Use try-catch to ensure errors don't prevent file opening
						setTimeout(() => {
							try {
								this.expandFolder(folder);
								// Highlight the folder instead of the file
								this.highlightFolder(folder);
							} catch (error) {
								// Silently fail - don't interfere with file opening
								console.error("Failed to expand/highlight folder:", error);
							}
						}, 200);
					}
				}
				
				setTimeout(() => {
					try {
						this.updateAllFolderNotes();
					} catch (error) {
						// Silently fail - don't interfere with file opening
						console.error("Failed to update folder notes:", error);
					}
				}, 100);
			})
		);

		// Update when active leaf changes
		this.plugin.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				setTimeout(() => {
					this.updateAllFolderNotes();
				}, 100);
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

	private updateFolderNoteForFile(file: TFile) {
		const parent = file.parent;
		if (parent) {
			this.updateFolderNote(parent);
		}
	}

	updateAllFolderNotes() {
		// First, show all previously hidden folder notes (even if disabled)
		this.showAllHiddenFolderNotes();

		if (!this.plugin.settings.showFolderNotes) {
			// Remove all folder note styling
			this.removeAllFolderNoteStyles();
			return;
		}

		// Then update each folder
		const folders = this.getAllFolders();
		folders.forEach((folder) => this.updateFolderNote(folder));
	}

	private showAllHiddenFolderNotes() {
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

		// Remove the hidden class from all previously hidden files
		const hiddenFiles = fileExplorerView.containerEl.querySelectorAll('.is-folder-note-hidden');
		hiddenFiles.forEach((el) => {
			el.removeClass('is-folder-note-hidden');
		});
	}

	private removeAllFolderNoteStyles() {
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

		// Remove all folder note classes and click handlers
		const folderTitles = fileExplorerView.containerEl.querySelectorAll('.nav-folder-title.has-folder-note');
		folderTitles.forEach((folderTitle) => {
			const el = folderTitle as HTMLElement;
			el.removeClass('has-folder-note');

			// Remove click handler from the title content
			const folderTitleContent = el.querySelector('.nav-folder-title-content') as HTMLElement;
			if (folderTitleContent) {
				const existingContentHandler = (folderTitleContent as any)._folderNoteClickHandler;
				if (existingContentHandler) {
					folderTitleContent.removeEventListener("click", existingContentHandler);
					delete (folderTitleContent as any)._folderNoteClickHandler;
				}
			}
		});
	}

	private hideAllFolderNotesQuick() {
		if (!this.plugin.settings.showFolderNotes) return;

		const folders = this.getAllFolders();
		folders.forEach((folder) => {
			const folderNote = getFolderNote(folder, this.app);
			if (folderNote) {
				// Quickly hide the file element
				const fileEl = this.getFileElement(folderNote);
				if (fileEl) {
					fileEl.addClass("is-folder-note-hidden");
				}
			}
		});
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

	updateFolderNote(folder: TFolder) {
		if (!this.plugin.settings.showFolderNotes) return;

		const folderNote = getFolderNote(folder, this.app);
		const folderTitleEl = this.getFolderElement(folder);

		if (!folderTitleEl) {
			// Folder not visible in DOM (probably collapsed), skip silently
			return;
		}

		// Get the folder title content element (the text part)
		const folderTitleContent = folderTitleEl.querySelector(".nav-folder-title-content") as HTMLElement;

		// Remove existing click handler
		const existingContentHandler = (folderTitleContent as any)._folderNoteClickHandler;
		if (existingContentHandler) {
			folderTitleContent.removeEventListener("click", existingContentHandler);
			delete (folderTitleContent as any)._folderNoteClickHandler;
		}

		if (folderNote) {
			// Add folder note class for styling (underline text)
			folderTitleEl.addClass("has-folder-note");

			// Hide the folder note file in the file explorer
			this.hideFolderNoteFile(folderNote);

			// Add click handler ONLY to the text content
			if (folderTitleContent) {
				const contentHandler = (e: MouseEvent) => {
					// Check if the click is actually on the text (not the padding/whitespace)
					const target = e.target as HTMLElement;
					
					// Only handle if clicking directly on the content element itself
					if (target === folderTitleContent || target.classList.contains('nav-folder-title-content')) {
						// Get the text width to determine if click is on actual text
						const range = document.createRange();
						const textNode = folderTitleContent.firstChild;
						
						if (textNode && textNode.nodeType === Node.TEXT_NODE) {
							range.selectNodeContents(textNode);
							const textRect = range.getBoundingClientRect();
							const clickX = e.clientX;
							
							// Only open folder note if click is within the text bounds
							if (clickX >= textRect.left && clickX <= textRect.right) {
								e.preventDefault();
								e.stopPropagation();
								// Check for Cmd (Mac) or Ctrl (Windows/Linux) key
								// If modifier key pressed, open in new tab; otherwise open in current tab
								const openInNewTab = e.metaKey || e.ctrlKey;
								const leaf = this.app.workspace.getLeaf(openInNewTab);
								leaf.openFile(folderNote);
							}
							// Otherwise, let the default toggle behavior happen
						}
					}
				};

				(folderTitleContent as any)._folderNoteClickHandler = contentHandler;
				folderTitleContent.addEventListener("click", contentHandler);
			}
		} else {
			// Remove folder note class if no longer has a folder note
			folderTitleEl.removeClass("has-folder-note");
		}
	}

	private hideFolderNoteFile(file: TFile) {
		const fileEl = this.getFileElement(file);
		if (fileEl) {
			fileEl.addClass("is-folder-note-hidden");
		}
	}

	private getFileElement(file: TFile): HTMLElement | null {
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

		// Find the file element by data-path attribute with escaped path
		const escapedPath = escapeCSSSelector(file.path);
		const fileElements = fileExplorerView.containerEl.querySelectorAll(
			`.nav-file-title[data-path="${escapedPath}"]`
		);

		if (fileElements && fileElements.length > 0) {
			// Return the parent tree-item element
			const fileTitle = fileElements[0] as HTMLElement;
			return fileTitle.closest('.tree-item.nav-file') as HTMLElement;
		}

		return null;
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

		return folderTitleElements && folderTitleElements.length > 0 ? (folderTitleElements[0] as HTMLElement) : null;
	}

	/**
	 * Expand a folder in the file explorer and scroll to it
	 */
	expandFolder(folder: TFolder) {
		// Use a simple recursive approach to expand all parent folders first
		const expandParents = (currentFolder: TFolder) => {
			const parent = currentFolder.parent;
			if (parent && parent !== this.app.vault.getRoot()) {
				expandParents(parent);
			}
			this.expandSingleFolder(currentFolder);
		};

		expandParents(folder);
		
		// Scroll to the folder after a short delay to ensure DOM is updated
		setTimeout(() => {
			this.scrollToFolder(folder);
		}, 200);
	}

	/**
	 * Expand a single folder in the file explorer
	 */
	private expandSingleFolder(folder: TFolder) {
		try {
			const folderTitleEl = this.getFolderElement(folder);
			if (!folderTitleEl) {
				return;
			}

			// Check if folder is already expanded
			const treeItem = folderTitleEl.closest('.tree-item') as HTMLElement;
			if (!treeItem) {
				return;
			}

			// Check if the folder is collapsed
			const isCollapsed = treeItem.classList.contains('is-collapsed');

			if (isCollapsed) {
				// Only use DOM manipulation - don't trigger click events that might interfere
				treeItem.classList.remove('is-collapsed');
				const children = treeItem.querySelector('.nav-folder-children') as HTMLElement;
				if (children) {
					children.style.display = '';
				}
			}
		} catch (error) {
			// Silently fail - don't interfere with file opening
			console.error("Failed to expand single folder:", error);
		}
	}

	/**
	 * Scroll to a folder in the file explorer
	 */
	private scrollToFolder(folder: TFolder) {
		const folderTitleEl = this.getFolderElement(folder);
		if (!folderTitleEl) {
			return;
		}

		// Scroll the folder into view
		folderTitleEl.scrollIntoView({
			behavior: 'smooth',
			block: 'center',
			inline: 'nearest'
		});
	}

	/**
	 * Highlight a folder in the file explorer instead of the file
	 */
	highlightFolder(folder: TFolder) {
		try {
			const fileExplorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
			if (!fileExplorerLeaves || fileExplorerLeaves.length === 0) {
				return;
			}

			const fileExplorer = fileExplorerLeaves[0];
			if (!fileExplorer) {
				return;
			}
			const fileExplorerView = fileExplorer.view as any;

			// Wait a bit for Obsidian's default highlighting to complete, then override it
			setTimeout(() => {
				// Method 1: Try using file explorer view's internal methods
				if (fileExplorerView) {
					// Try revealFile method (might work for folders too)
					if (typeof fileExplorerView.revealFile === 'function') {
						try {
							fileExplorerView.revealFile(folder);
							// Give it a moment, then override the highlight
							setTimeout(() => {
								this.overrideHighlightToFolder(folder);
							}, 50);
							return;
						} catch (e) {
							// Fall through to DOM method
						}
					}
				}

				// Method 2: Use DOM manipulation to override highlight
				this.overrideHighlightToFolder(folder);
			}, 100);
		} catch (error) {
			console.error("Failed to highlight folder:", error);
		}
	}

	/**
	 * Override Obsidian's default file highlight to highlight folder instead
	 */
	private overrideHighlightToFolder(folder: TFolder) {
		const fileExplorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
		if (!fileExplorerLeaves || fileExplorerLeaves.length === 0) {
			return;
		}

		const fileExplorer = fileExplorerLeaves[0];
		if (!fileExplorer) {
			return;
		}
		const fileExplorerView = fileExplorer.view as any;
		const fileExplorerViewContainer = fileExplorerView?.containerEl;
		
		if (!fileExplorerViewContainer) {
			return;
		}

		// Remove active/selected class from all items (files and folders)
		const activeItems = fileExplorerViewContainer.querySelectorAll(
			'.nav-folder-title.is-active, .nav-file-title.is-active, .nav-folder-title.is-selected, .nav-file-title.is-selected'
		);
		activeItems.forEach((item: Element) => {
			item.classList.remove('is-active', 'is-selected');
		});

		// Also remove from tree-item level
		const activeTreeItems = fileExplorerViewContainer.querySelectorAll(
			'.tree-item.is-active, .tree-item.is-selected'
		);
		activeTreeItems.forEach((item: Element) => {
			item.classList.remove('is-active', 'is-selected');
		});

		// Add active class to the folder
		const folderTitleEl = this.getFolderElement(folder);
		if (folderTitleEl) {
			folderTitleEl.classList.add('is-active');
			const treeItem = folderTitleEl.closest('.tree-item') as HTMLElement;
			if (treeItem) {
				treeItem.classList.add('is-active');
			}
			
			// Scroll to folder
			this.scrollToFolder(folder);
		}
	}

	addContextMenuItems(menu: Menu, folder: TFolder) {
		if (!this.plugin.settings.showFolderNotes) return;

		const folderNote = getFolderNote(folder, this.app);

		if (folderNote) {
			menu.addItem((item) => {
				item.setTitle("📝 Open folder note")
					.setIcon("document")
					.onClick(() => {
						const leaf = this.app.workspace.getLeaf(false);
						leaf.openFile(folderNote);
					});
			});
		} else {
			menu.addItem((item) => {
				item.setTitle("📝 Create folder note")
					.setIcon("document-create")
					.onClick(async () => {
						const notePath = `${folder.path}/${folder.name}.md`;
						const newFile = await this.app.vault.create(
							notePath,
							`# ${folder.name}\n\n`
						);
						const leaf = this.app.workspace.getLeaf(false);
						await leaf.openFile(newFile);
					});
			});
		}
	}
}

