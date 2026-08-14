import { Platform, Plugin } from "obsidian";
import { Extension } from "@codemirror/state";
import { highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import {
	DEFAULT_SETTINGS,
	LineNumbersSettings,
	LineNumbersSettingTab,
} from "./settings";

export default class LineNumbersPlugin extends Plugin {
	settings: LineNumbersSettings;

	/**
	 * A stable array reference handed to Obsidian once via
	 * `registerEditorExtension`. We mutate its contents and call
	 * `workspace.updateOptions()` to reconfigure every open editor without
	 * re-registering — the standard Obsidian pattern for dynamic CM6 extensions.
	 */
	private editorExtensions: Extension[] = [];

	/** Whether the reveal class is currently on the body — see setPeekActive. */
	private peekActive = false;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new LineNumbersSettingTab(this.app, this));

		this.registerEditorExtension(this.editorExtensions);
		this.refreshExtensions();

		// Peek mode: reveal numbers only while ⌘ (macOS) / Ctrl is held. The
		// handlers just toggle a body class; the base `line-numbers-peek` class
		// (set in refreshExtensions) gates whether it has any effect, so these
		// stay cheap no-ops when peek mode is off.
		//
		// Nothing here trusts the modifier's own keyup to arrive. It is the only
		// event that says "released", and it goes missing whenever something eats
		// the rest of the chord — switching tabs with ⌘+number, a menu accelerator
		// firing, focus moving into a leaf that is being rebuilt — which left the
		// numbers showing until the next time the modifier was pressed and released
		// cleanly. So every input event that carries modifier state is allowed to
		// end peek mode: they all report the modifier as up, whatever happened to
		// the keyup we never got.
		this.registerDomEvent(document, "keydown", (e) => {
			if (e.key === "Meta" || e.key === "Control") this.setPeekActive(true);
			else if (!e.metaKey && !e.ctrlKey) this.setPeekActive(false);
		});
		this.registerDomEvent(document, "keyup", (e) => {
			if (e.key === "Meta" || e.key === "Control" || !(e.metaKey || e.ctrlKey)) {
				this.setPeekActive(false);
			}
		});
		// Covers releasing the modifier while the window is unfocused (⌘+Tab), where
		// no key event of any kind reaches us.
		this.registerDomEvent(window, "blur", () => this.setPeekActive(false));
		// The reliable catch-all: the first mouse move after the modifier is gone.
		// setPeekActive returns immediately when the state is unchanged, so this
		// costs one boolean compare per event.
		this.registerDomEvent(document, "mousemove", (e) => {
			if (!e.metaKey && !e.ctrlKey) this.setPeekActive(false);
		});

		this.addCommand({
			id: "toggle-line-numbers",
			name: "Toggle line numbers",
			callback: async () => {
				this.settings.enabled = !this.settings.enabled;
				await this.saveSettings();
				this.refreshExtensions();
			},
		});
	}

	onunload() {
		// Clearing the array + updateOptions removes the gutter from open editors.
		this.editorExtensions.length = 0;
		this.app.workspace.updateOptions();
		document.body.classList.remove(
			"line-numbers-overlay",
			"line-numbers-peek",
			"line-numbers-peek-active"
		);
		this.peekActive = false;
	}

	/**
	 * Toggle the "numbers currently revealed" state (only meaningful in peek mode).
	 * Tracked in a field and returned from early when unchanged, so the handlers that
	 * fire continuously — mousemove above — never touch the DOM for nothing.
	 */
	private setPeekActive(active: boolean): void {
		const peek = this.settings.enabled && this.settings.revealOnModifier;
		const next = peek && active;
		if (next === this.peekActive) return;
		this.peekActive = next;
		document.body.classList.toggle("line-numbers-peek-active", next);
	}

	/** Rebuilds the editor extension from current settings and applies it live. */
	refreshExtensions(): void {
		// Off on mobile regardless of the (Sync-shared) setting: the gutter eats
		// scarce horizontal space and peek mode needs a ⌘/Ctrl key that phones
		// don't have. The setting still drives desktop; this just forces mobile.
		const active = this.settings.enabled && !Platform.isMobile;

		this.editorExtensions.length = 0;
		if (active) {
			this.editorExtensions.push(lineNumbers());
			if (this.settings.highlightActiveLine) {
				this.editorExtensions.push(highlightActiveLineGutter());
			}
		}
		this.app.workspace.updateOptions();

		// The overlay layout (numbers float in the left margin, gutter reserves
		// no width) is now the default whenever the plugin is enabled. Pure CSS,
		// gated by a body class.
		document.body.classList.toggle("line-numbers-overlay", active);

		// Peek mode is also pure CSS: `line-numbers-peek` hides the numbers, and
		// the key handlers add `line-numbers-peek-active` to reveal them.
		const peek = active && this.settings.revealOnModifier;
		document.body.classList.toggle("line-numbers-peek", peek);
		if (!peek) {
			document.body.classList.remove("line-numbers-peek-active");
			this.peekActive = false;
		}
	}

	async loadSettings() {
		// Only carry over known keys, so stale fields from older versions
		// (e.g. a removed `mode` option) get dropped on the next save.
		const saved = (await this.loadData()) ?? {};
		this.settings = {
			enabled: saved.enabled ?? DEFAULT_SETTINGS.enabled,
			highlightActiveLine:
				saved.highlightActiveLine ?? DEFAULT_SETTINGS.highlightActiveLine,
			revealOnModifier:
				saved.revealOnModifier ?? DEFAULT_SETTINGS.revealOnModifier,
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
