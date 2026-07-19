import {
	App,
	Notice,
	TFile,
	TFolder,
	TAbstractFile,
} from "obsidian";
import { PinnedItem, MyPluginSettings } from "./settings";
import { getFolderNote, getFolderFromNote } from "./utils";
import type MyPlugin from "./main";

export class PinnedItemsManager {
	app: App;
	plugin: MyPlugin;
	pinnedContainerEl: HTMLElement | null = null;
	private initializationAttempts = 0;
	private readonly MAX_INIT_ATTEMPTS = 10;
	private mutationObserver: MutationObserver | null = null;

	constructor(app: App, plugin: MyPlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	initialize() {
		// Initialize pinned items with retry logic for mobile
		this.app.workspace.onLayoutReady(() => {
			this.initializeWithRetry();
		});

		// Watch for layout changes (important for mobile when sidebars open/close)
		this.plugin.registerEvent(
			this.app.workspace.on("layout-change", () => {
				// Small delay to let the layout settle
				setTimeout(() => {
					if (
						!this.pinnedContainerEl ||
						!this.pinnedContainerEl.isConnected
					) {
						this.pinnedContainerEl = null;
						this.initializeWithRetry();
					}
				}, 150);
			})
		);

		// Watch for workspace changes that might affect the file explorer
		this.plugin.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				// Small delay to let the leaf change complete
				setTimeout(() => {
					if (
						!this.pinnedContainerEl ||
						!this.pinnedContainerEl.isConnected
					) {
						this.initializeWithRetry();
					}
				}, 150);
			})
		);
	}

	private initializeWithRetry() {
		const success = this.addPinnedItemsToFileExplorer();

		if (!success && this.initializationAttempts < this.MAX_INIT_ATTEMPTS) {
			this.initializationAttempts++;
			// Retry with exponential backoff
			const delay = Math.min(
				1000 * Math.pow(1.5, this.initializationAttempts),
				5000
			);
			setTimeout(() => {
				this.initializeWithRetry();
			}, delay);
		} else if (success) {
			this.initializationAttempts = 0;
		}
	}

	cleanup() {
		// Clean up the mutation observer
		if (this.mutationObserver) {
			this.mutationObserver.disconnect();
			this.mutationObserver = null;
		}

		// Clean up the pinned items container
		if (this.pinnedContainerEl) {
			this.pinnedContainerEl.remove();
			this.pinnedContainerEl = null;
		}
	}

	async pinItem(file: TAbstractFile) {
		// If pinning a folder, check if it has a folder note
		// If it does, pin the folder note file instead
		let targetFile: TAbstractFile = file;
		if (file instanceof TFolder) {
			const folderNote = getFolderNote(file, this.app);
			if (folderNote) {
				targetFile = folderNote;
			}
		}

		const item: PinnedItem = {
			path: targetFile.path,
			type: targetFile instanceof TFolder ? "folder" : "file",
			name: targetFile.name,
			order: this.getNextOrder(),
		};

		// Check if already pinned
		if (
			!this.plugin.settings.pinnedItems.some((p) => p.path === targetFile.path)
		) {
			this.plugin.settings.pinnedItems.push(item);
			await this.plugin.saveSettings();
			this.refreshPinnedItems();
			new Notice(`Pinned: ${targetFile.name}`);
		}
	}

	private getNextOrder(): number {
		if (this.plugin.settings.pinnedItems.length === 0) {
			return 0;
		}
		const maxOrder = Math.max(
			...this.plugin.settings.pinnedItems.map((item) => item.order ?? 0)
		);
		return maxOrder + 1;
	}

	async updateItemOrder(path: string, newOrder: number) {
		const item = this.plugin.settings.pinnedItems.find(
			(p) => p.path === path
		);
		if (item) {
			item.order = newOrder;
			await this.plugin.saveSettings();
			this.refreshPinnedItems();
		}
	}

	async reorderItems(newOrder: { path: string; order: number }[]) {
		// Update all items with new order
		newOrder.forEach(({ path, order }) => {
			const item = this.plugin.settings.pinnedItems.find(
				(p) => p.path === path
			);
			if (item) {
				item.order = order;
			}
		});
		await this.plugin.saveSettings();
		this.refreshPinnedItems();
	}

	async unpinItem(path: string) {
		const item = this.plugin.settings.pinnedItems.find(
			(p) => p.path === path
		);
		this.plugin.settings.pinnedItems =
			this.plugin.settings.pinnedItems.filter((item) => item.path !== path);
		await this.plugin.saveSettings();
		this.refreshPinnedItems();
		if (item) {
			new Notice(`Unpinned: ${item.name}`);
		}
	}

	addPinnedItemsToFileExplorer(): boolean {
		try {
			// Don't reinitialize if already exists and connected
			if (this.pinnedContainerEl && this.pinnedContainerEl.isConnected) {
				return true;
			}

			// Get the file explorer leaf
			const fileExplorerLeaves =
				this.app.workspace.getLeavesOfType("file-explorer");

			if (!fileExplorerLeaves || fileExplorerLeaves.length === 0) {
				return false;
			}

			const fileExplorer = fileExplorerLeaves[0];

			if (!fileExplorer || !fileExplorer.view) {
				return false;
			}

			// Access the file explorer view container
			const fileExplorerView = fileExplorer.view as {
				containerEl?: HTMLElement;
			};

			if (!fileExplorerView.containerEl) {
				return false;
			}

			const containerEl = fileExplorerView.containerEl;

			// Find the nav-files-container (the main file list)
			const navFilesContainer = containerEl.querySelector(
				".nav-files-container"
			) as HTMLElement;

			if (!navFilesContainer) {
				// Try alternative approach - just append to containerEl
				const existingContainer = containerEl.querySelector(
					".pinned-items-container"
				);
				if (existingContainer) {
					existingContainer.remove();
				}

				this.pinnedContainerEl = containerEl.createDiv({
					cls: "pinned-items-container pinned-items-fallback",
				});

				this.refreshPinnedItems();
				return true;
			}

			// Make sure nav-files-container is visible and properly styled
			navFilesContainer.style.display = "";
			navFilesContainer.style.visibility = "";

			// Remove old container if it exists but is disconnected
			if (this.pinnedContainerEl && !this.pinnedContainerEl.isConnected) {
				this.pinnedContainerEl = null;
			}

			// Check if pinned container already exists in the DOM to avoid duplicates
			const existingContainer = containerEl.querySelector(
				".pinned-items-container"
			);
			if (
				existingContainer &&
				existingContainer !== this.pinnedContainerEl
			) {
				existingContainer.remove();
			}

			// Create the pinned items container using Obsidian's createDiv method
			this.pinnedContainerEl = containerEl.createDiv({
				cls: "pinned-items-container",
			});

			// Move it to the beginning
			containerEl.insertBefore(
				this.pinnedContainerEl,
				containerEl.firstChild
			);

			// Render the pinned items after a slight delay to ensure DOM is ready
			setTimeout(() => {
				this.refreshPinnedItems();
			}, 100);

			return true;
		} catch (error) {
			console.error(
				"Failed to add pinned items to file explorer:",
				error
			);
			return false;
		}
	}

	refreshPinnedItems() {
		try {
			if (
				!this.pinnedContainerEl ||
				!this.pinnedContainerEl.isConnected
			) {
				// Try to reinitialize if container is missing
				this.initializeWithRetry();
				return;
			}

			// Clear existing items
			this.pinnedContainerEl.empty();

			if (this.plugin.settings.pinnedItems.length === 0) {
				// Hide the container instead of removing it to prevent layout shift
				this.pinnedContainerEl.style.display = "none";
				this.pinnedContainerEl.style.visibility = "hidden";
				this.pinnedContainerEl.style.opacity = "0";
				this.pinnedContainerEl.style.height = "0";
				this.pinnedContainerEl.style.margin = "0";
				this.pinnedContainerEl.style.padding = "0";
				this.pinnedContainerEl.style.borderBottom = "none";
				return;
			}

			this.pinnedContainerEl.style.display = "block";
			this.pinnedContainerEl.style.visibility = "visible";
			this.pinnedContainerEl.style.opacity = "1";
			this.pinnedContainerEl.style.height = "";
			this.pinnedContainerEl.style.margin = "";
			this.pinnedContainerEl.style.padding = "";
			this.pinnedContainerEl.style.borderBottom = "";

			// Sort pinned items by order, then by name as fallback
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

			// Add each pinned item
			sortedItems.forEach((item) => {
				if (!this.pinnedContainerEl) return;

				const itemEl = this.pinnedContainerEl.createDiv({
					cls: "pinned-item",
				});

				// Native HTML5 drag powers desktop reorder; the touch handlers
				// below add mobile support (touch never fires HTML5 drag events).
				itemEl.setAttr("draggable", "true");
				itemEl.dataset.path = item.path;

				// Icon based on type
				itemEl.createSpan({
					cls: "pinned-item-icon",
					text: item.type === "folder" ? "📁" : "📄",
				});

				// Name
				itemEl.createSpan({
					cls: "pinned-item-name",
					text: item.name,
				});

				// Click handler to open the file/folder
				// Handle both touch and click events for better mobile support
				const openFile = async (evt: Event) => {
					evt.preventDefault();
					const file = this.app.vault.getAbstractFileByPath(item.path);
					if (file) {
						if (file instanceof TFile) {
							// Check if this is a folder note
							const folder = getFolderFromNote(file, this.app);
							if (folder) {
								// If it's a folder note, expand and highlight the folder first
								// Then open the file
								this.plugin.folderNoteManager.expandFolder(folder);
								setTimeout(() => {
									this.plugin.folderNoteManager.highlightFolder(folder);
								}, 100);
							}
							// Check for modifier keys (Cmd on Mac, Ctrl on Windows/Linux)
							const mouseEvent = evt as MouseEvent;
							const openInNewTab = mouseEvent.metaKey || mouseEvent.ctrlKey;
							// Open the file in a new tab if modifier key is pressed, otherwise use active leaf
							const leaf = this.app.workspace.getLeaf(openInNewTab);
							await leaf.openFile(file);
						} else if (file instanceof TFolder) {
							// Reveal the folder in the file tree: expand parents, highlight, scroll
							this.plugin.folderNoteManager.expandFolder(file);
							setTimeout(() => {
								this.plugin.folderNoteManager.highlightFolder(file);
							}, 100);

							// If a folder note exists, still open it (preserve existing behavior)
							const mouseEvent = evt as MouseEvent;
							const openInNewTab = mouseEvent.metaKey || mouseEvent.ctrlKey;
							const folderNote = getFolderNote(file, this.app);
							if (folderNote) {
								const leaf = this.app.workspace.getLeaf(openInNewTab);
								await leaf.openFile(folderNote);
							}
						}
					} else {
						new Notice(`File not found: ${item.path}`);
						// Remove the missing item
						this.unpinItem(item.path);
					}
				};

				// Open on click — fires for a desktop click and a mobile tap
				// alike. A touch-drag suppresses this via the flag below.
				let suppressClick = false;
				this.plugin.registerDomEvent(itemEl, "click", (e) => {
					if (suppressClick) {
						suppressClick = false;
						e.preventDefault();
						e.stopPropagation();
						return;
					}
					void openFile(e);
				});

				// Add unpin button
				const unpinBtn = itemEl.createSpan({
					cls: "pinned-item-unpin",
					text: "×",
				});

				const handleUnpin = (e: Event) => {
					e.stopPropagation(); // Prevent opening the file
					e.preventDefault();
					this.unpinItem(item.path);
				};
				this.plugin.registerDomEvent(unpinBtn, "click", handleUnpin);
				// Keep a press on × from arming the row's touch long-press drag.
				this.plugin.registerDomEvent(unpinBtn, "touchstart", (e) =>
					e.stopPropagation()
				);

				const container = this.pinnedContainerEl;

				// Move this row to wherever the pointer is, sliding siblings into
				// the vacated gap with a FLIP animation (touch reorder only).
				const moveDraggedTo = (clientY: number): void => {
					const afterElement = this.getDragAfterElement(
						container,
						clientY
					);
					if (afterElement === itemEl) return;

					const siblings = Array.from(container.children).filter(
						(c): c is HTMLElement => c !== itemEl
					);
					const before = new Map(
						siblings.map((s) => [s, s.getBoundingClientRect().top])
					);

					if (afterElement == null) {
						container.appendChild(itemEl);
					} else {
						container.insertBefore(itemEl, afterElement);
					}

					// FLIP: play each shifted sibling from its old spot to its new one.
					for (const s of siblings) {
						const delta = (before.get(s) ?? 0) - s.getBoundingClientRect().top;
						if (!delta) continue;
						s.style.transition = "none";
						s.style.transform = `translateY(${delta}px)`;
						void s.offsetHeight; // force reflow so the next frame animates
						s.style.transition = "transform 0.18s ease";
						s.style.transform = "";
					}
				};

				// Persist the new order from the current DOM order.
				const persistOrder = async (): Promise<void> => {
					const newOrder: { path: string; order: number }[] = [];
					Array.from(container.children).forEach((child, idx) => {
						const path = (child as HTMLElement).dataset.path;
						if (path) {
							newOrder.push({ path, order: idx });
						}
					});
					await this.reorderItems(newOrder);
				};

				// --- Desktop: native HTML5 drag-and-drop (unchanged) ---
				// stopPropagation keeps these from triggering the file explorer's
				// own file drag-and-drop.
				itemEl.addEventListener("dragstart", (e) => {
					e.stopPropagation();
					if (e.dataTransfer) {
						e.dataTransfer.effectAllowed = "move";
						e.dataTransfer.setData("text/plain", item.path);
					}
					itemEl.classList.add("dragging");
				});

				itemEl.addEventListener("dragend", () => {
					itemEl.classList.remove("dragging");
				});

				itemEl.addEventListener("dragover", (e) => {
					e.preventDefault();
					e.stopPropagation();
					if (e.dataTransfer) {
						e.dataTransfer.dropEffect = "move";
					}
					const dragging = container.querySelector(
						".dragging"
					) as HTMLElement | null;
					if (!dragging || dragging === itemEl) return;
					const afterElement = this.getDragAfterElement(
						container,
						e.clientY
					);
					if (afterElement == null) {
						container.appendChild(dragging);
					} else {
						container.insertBefore(dragging, afterElement);
					}
				});

				itemEl.addEventListener("drop", async (e) => {
					e.preventDefault();
					e.stopPropagation();
					await persistOrder();
				});

				// --- Mobile: touch long-press drag (touch never fires HTML5 DnD) ---
				// Long-press to pick up a row; a swipe before the hold engages is
				// left as a normal scroll.
				const LONG_PRESS_MS = 350;
				const TOUCH_THRESHOLD = 10; // px of slop allowed during the hold
				let touchDragging = false;
				let touchStartX = 0;
				let touchStartY = 0;
				let longPressTimer: number | null = null;
				// A "lifted" copy of the row that floats under the finger while the
				// real row becomes an invisible placeholder gap that reflows.
				let cloneEl: HTMLElement | null = null;
				let grabOffsetY = 0; // finger offset within the row at pickup

				const clearLongPress = (): void => {
					if (longPressTimer !== null) {
						window.clearTimeout(longPressTimer);
						longPressTimer = null;
					}
				};

				// Lift the row: spawn a fixed-position floating clone and turn the
				// original into a placeholder. Called once the long-press fires.
				const liftRow = (): void => {
					const rect = itemEl.getBoundingClientRect();
					grabOffsetY = touchStartY - rect.top;
					const clone = itemEl.cloneNode(true) as HTMLElement;
					clone.classList.add("pinned-item-drag-clone");
					clone.classList.remove("dragging", "dragging-touch");
					clone.style.width = `${rect.width}px`;
					clone.style.left = `${rect.left}px`;
					clone.style.top = `${rect.top}px`;
					document.body.appendChild(clone);
					cloneEl = clone;
					itemEl.classList.add("dragging", "dragging-touch");
					// Tactile "pickup" cue where supported.
					try {
						navigator.vibrate?.(15);
					} catch {
						/* vibrate unsupported */
					}
				};

				// Float the clone to follow the finger's Y.
				const moveClone = (clientY: number): void => {
					if (cloneEl) cloneEl.style.top = `${clientY - grabOffsetY}px`;
				};

				const endTouchDrag = (): void => {
					clearLongPress();
					touchDragging = false;
					cloneEl?.remove();
					cloneEl = null;
					itemEl.classList.remove("dragging", "dragging-touch");
				};

				this.plugin.registerDomEvent(
					itemEl,
					"touchstart",
					(e: TouchEvent) => {
						const t = e.touches[0];
						if (e.touches.length !== 1 || !t) return;
						touchStartX = t.clientX;
						touchStartY = t.clientY;
						touchDragging = false;
						longPressTimer = window.setTimeout(() => {
							longPressTimer = null;
							touchDragging = true;
							liftRow();
						}, LONG_PRESS_MS);
					}
				);

				this.plugin.registerDomEvent(
					itemEl,
					"touchmove",
					(e: TouchEvent) => {
						const t = e.touches[0];
						if (!t) return;
						if (!touchDragging) {
							// Moved before the hold engaged → treat as a scroll.
							const moved =
								Math.abs(t.clientX - touchStartX) +
								Math.abs(t.clientY - touchStartY);
							if (
								longPressTimer !== null &&
								moved > TOUCH_THRESHOLD
							) {
								clearLongPress();
							}
							return;
						}
						// Dragging: block list scroll, float the clone, and reflow.
						e.preventDefault();
						moveClone(t.clientY);
						moveDraggedTo(t.clientY);
					},
					{ passive: false }
				);

				this.plugin.registerDomEvent(
					itemEl,
					"touchend",
					async (e: TouchEvent) => {
						if (touchDragging) {
							// Suppress the tap-to-open that would otherwise follow.
							e.preventDefault();
							suppressClick = true;
							endTouchDrag();
							await persistOrder();
						} else {
							endTouchDrag();
						}
					},
					{ passive: false }
				);

				this.plugin.registerDomEvent(
					itemEl,
					"touchcancel",
					endTouchDrag
				);
			});
		} catch (error) {
			console.error("Failed to refresh pinned items:", error);
		}
	}

	private getDragAfterElement(
		container: HTMLElement,
		y: number
	): HTMLElement | null {
		const draggableElements = Array.from(
			container.querySelectorAll(".pinned-item:not(.dragging)")
		) as HTMLElement[];

		return draggableElements.reduce(
			(closest, child) => {
				const box = child.getBoundingClientRect();
				const offset = y - box.top - box.height / 2;
				if (offset < 0 && offset > closest.offset) {
					return { offset, element: child };
				}
				return closest;
			},
			{
				offset: Number.NEGATIVE_INFINITY,
				element: null as HTMLElement | null,
			}
		).element;
	}
}

