import type { App } from "obsidian";

/** This plugin's Go to File: what ⌘P opens, and what the empty tab's "Go to file" opens too. */
const GO_TO_FILE_COMMAND = "yeyan-quick-open:go-to-file";
const KEYS_CLS = "quick-open-keys";

/** What the commands API looks like at runtime; the public typings leave it out of `App`. */
interface AppInternals {
	commands: { executeCommandById(id: string): boolean };
	hotkeyManager: { printHotkeyForCommand(id: string): string };
}

/**
 * The buttons under an empty tab's search (New note, Go to file, and any a plugin adds), as
 * VS Code's empty editor lists its actions: each with its shortcut in key caps.
 *
 * Obsidian already prints a button's shortcut after its label (`.empty-state-hotkey`), as
 * plain text and only when the command the button runs has a key of its own; a plugin's
 * button can say the same that way (Drafts' does). That text is what's turned into caps.
 *
 * "Go to file" runs Obsidian's own quick switcher, which ⌘P no longer opens and nothing else
 * does either. It opens this plugin's Go to File instead, and shows the key that opens that.
 *
 * The list is watched rather than dressed once: Obsidian rebuilds it whenever the tab is
 * emptied again, and other plugins add their buttons after this runs.
 */
export class NewTabActions {
	private readonly observer: MutationObserver;
	/** How to take the Go to File handler back off each button it's on. */
	private readonly undo = new Map<HTMLElement, () => void>();
	private readonly dressed = new WeakSet<HTMLElement>();

	constructor(
		private readonly app: App,
		private readonly list: HTMLElement,
	) {
		this.observer = new MutationObserver(() => this.dress());
		this.observer.observe(list, { childList: true });
		this.dress();
	}

	destroy(): void {
		this.observer.disconnect();
		for (const undo of this.undo.values()) undo();
		this.undo.clear();
		this.list.querySelectorAll(`.${KEYS_CLS}`).forEach((el) => el.remove());
	}

	private dress(): void {
		// A rebuild throws the old buttons away, handlers and all.
		for (const button of this.undo.keys()) if (!button.isConnected) this.undo.delete(button);
		for (const button of Array.from(this.list.querySelectorAll<HTMLElement>(":scope > .empty-state-action"))) {
			if (this.dressed.has(button)) continue;
			this.dressed.add(button);
			const goToFile = button.querySelector(":scope svg.lucide-search") !== null;
			if (goToFile) this.openGoToFile(button);
			const printed = goToFile
				? this.internals().hotkeyManager.printHotkeyForCommand(GO_TO_FILE_COMMAND)
				: (button.querySelector(":scope > .empty-state-hotkey")?.textContent ?? "");
			const keys = printed.trim().split(/\s*\+\s*|\s+/).filter(Boolean);
			if (keys.length === 0) continue;
			const caps = button.createSpan({ cls: KEYS_CLS });
			for (const key of keys) caps.createEl("kbd", { cls: "quick-open-key", text: key });
		}
	}

	/** Run Go to File from the button, ahead of Obsidian's own handler on it. */
	private openGoToFile(button: HTMLElement): void {
		const run = (evt: Event): void => {
			if (evt instanceof KeyboardEvent && evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			evt.stopImmediatePropagation();
			this.internals().commands.executeCommandById(GO_TO_FILE_COMMAND);
		};
		button.addEventListener("click", run, { capture: true });
		button.addEventListener("keydown", run, { capture: true });
		this.undo.set(button, () => {
			button.removeEventListener("click", run, { capture: true });
			button.removeEventListener("keydown", run, { capture: true });
		});
	}

	private internals(): AppInternals {
		return this.app as unknown as AppInternals;
	}
}
