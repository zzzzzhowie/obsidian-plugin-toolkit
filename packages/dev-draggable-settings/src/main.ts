import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";

interface DevDraggableSettings {
	enabled: boolean;
	hideBackdrop: boolean;
}

const DEFAULT_SETTINGS: DevDraggableSettings = {
	enabled: true,
	hideBackdrop: true,
};

// Controls in the drag zone that must keep working — clicking these never drags.
const INTERACTIVE_SELECTOR =
	"input, button, select, textarea, a, [contenteditable], " +
	".clickable-icon, .vertical-tab-nav-item, .checkbox-container, " +
	".dropdown, .slider, .search-input-container";

// Height (px) of the top strip that acts as a title bar for dragging.
const DRAG_TOP_PX = 50;

const HIDE_BG_CLASS = "dev-draggable-hide-bg";

export default class DevDraggableSettingsPlugin extends Plugin {
	settings!: DevDraggableSettings;
	private observer: MutationObserver | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyBackdropClass();

		// Watch for the settings modal being added, then enhance it. Match ANY
		// .modal-container holding a `.modal.mod-settings`, regardless of where
		// `mod-settings` lives, so it is robust across Obsidian versions/layouts.
		this.observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				mutation.addedNodes.forEach((node) => {
					if (!(node instanceof HTMLElement)) return;
					const containers: HTMLElement[] = [];
					if (node.matches(".modal-container")) containers.push(node);
					node
						.querySelectorAll<HTMLElement>(".modal-container")
						.forEach((c) => containers.push(c));
					for (const container of containers) {
						if (container.querySelector(".modal.mod-settings")) {
							this.enhance(container);
						}
					}
				});
			}
		});
		this.observer.observe(document.body, { childList: true });

		this.addCommand({
			id: "toggle-draggable-settings",
			name: "Toggle draggable settings",
			callback: async () => {
				this.settings.enabled = !this.settings.enabled;
				this.applyBackdropClass();
				await this.saveSettings();
				new Notice(
					`Draggable settings: ${this.settings.enabled ? "ON" : "OFF"}`
				);
			},
		});

		this.addSettingTab(new DevDraggableSettingTab(this.app, this));
	}

	onunload(): void {
		this.observer?.disconnect();
		this.observer = null;
		document.body.classList.remove(HIDE_BG_CLASS);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// Global, reactive switch for backdrop removal (see styles.css). Independent
	// of when the settings modal was opened, so toggling takes effect at once.
	applyBackdropClass(): void {
		document.body.classList.toggle(
			HIDE_BG_CLASS,
			this.settings.enabled && this.settings.hideBackdrop
		);
	}

	private enhance(container: HTMLElement): void {
		if (!this.settings.enabled) return;
		const modal = container.querySelector<HTMLElement>(".modal.mod-settings");
		if (!modal || modal.dataset.devDraggable) return;
		modal.dataset.devDraggable = "1";

		// Freeze the modal exactly where/what-size Obsidian rendered it, then
		// switch to fixed positioning so it can be dragged. No width/height
		// changes → looks identical to the native settings window.
		const rect = modal.getBoundingClientRect();
		Object.assign(modal.style, {
			position: "fixed",
			margin: "0",
			transform: "none",
			top: `${Math.round(rect.top)}px`,
			left: `${Math.round(rect.left)}px`,
			pointerEvents: "auto",
		});

		// One AbortController tears down every listener when the modal closes.
		const controller = new AbortController();
		const { signal } = controller;

		let startX = 0;
		let startY = 0;
		let originX = 0;
		let originY = 0;
		let dragging = false;

		// Draggable from the top strip, or Alt+drag anywhere. This layout's
		// `.modal-header` is display:none on desktop, so we don't rely on it.
		const eligible = (e: MouseEvent): boolean => {
			if (!(e.target instanceof HTMLElement)) return false;
			if (e.target.closest(INTERACTIVE_SELECTOR)) return false;
			if (e.altKey) return true;
			return e.clientY - modal.getBoundingClientRect().top <= DRAG_TOP_PX;
		};

		modal.addEventListener(
			"mousedown",
			(e) => {
				if (e.button !== 0 || !eligible(e)) return;
				dragging = true;
				startX = e.clientX;
				startY = e.clientY;
				const b = modal.getBoundingClientRect();
				originX = b.left;
				originY = b.top;
				e.preventDefault();
			},
			{ signal }
		);

		// Cursor feedback over the draggable region (JS-driven so it never
		// depends on a hidden header element).
		modal.addEventListener(
			"mousemove",
			(e) => {
				if (dragging) return;
				modal.style.cursor = eligible(e) ? "move" : "";
			},
			{ signal }
		);

		window.addEventListener(
			"mousemove",
			(e) => {
				if (!dragging) return;
				modal.style.left = `${originX + e.clientX - startX}px`;
				modal.style.top = `${originY + e.clientY - startY}px`;
			},
			{ signal }
		);

		window.addEventListener(
			"mouseup",
			() => {
				dragging = false;
			},
			{ signal }
		);

		// Tear down when this specific modal leaves the DOM.
		const lifecycle = new MutationObserver(() => {
			if (!document.body.contains(modal)) {
				controller.abort();
				// Obsidian reuses the settings modal element across open/close, so
				// clear the marker — otherwise reopening the (same) element hits the
				// `dataset.devDraggable` guard and never re-attaches the drag
				// listeners, leaving it undraggable after the first close.
				delete modal.dataset.devDraggable;
				lifecycle.disconnect();
			}
		});
		lifecycle.observe(document.body, { childList: true, subtree: true });
	}
}

class DevDraggableSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: DevDraggableSettingsPlugin
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Enabled")
			.setDesc(
				"让设置弹窗可拖动（尺寸样式保持 Obsidian 原生）。关掉后恢复原生居中弹窗，需重开设置。"
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
					this.plugin.settings.enabled = value;
					this.plugin.applyBackdropClass();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Hide backdrop")
			.setDesc("去掉半透明蒙层，主界面完整可见且可交互。（即时生效）")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideBackdrop)
					.onChange(async (value) => {
						this.plugin.settings.hideBackdrop = value;
						this.plugin.applyBackdropClass();
						await this.plugin.saveSettings();
					})
			);
	}
}
