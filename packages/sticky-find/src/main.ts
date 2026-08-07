import { MarkdownView, Platform, Plugin } from "obsidian";

import { FindBar } from "./find-bar";
import { DEFAULT_SETTINGS, StickyFindSettingTab, type StickyFindSettings } from "./settings";

const MAX_SEED_LENGTH = 100;

export default class StickyFindPlugin extends Plugin {
	settings: StickyFindSettings = { ...DEFAULT_SETTINGS };

	private bar: FindBar | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new StickyFindSettingTab(this.app, this));

		this.addCommand({
			id: "open",
			name: "Find in file (keep tables rendered)",
			checkCallback: (checking) => {
				const view = this.editableView();
				if (!view) return false;
				if (!checking) this.openFind(view);
				return true;
			},
		});

		// Capture phase on the window, so this runs before Obsidian's own keymap handler
		// and can claim the shortcut without rewriting the user's hotkeys.json.
		this.registerDomEvent(window, "keydown", (evt) => this.onKeyDown(evt), { capture: true });

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				if (this.bar && this.bar.view !== this.app.workspace.getActiveViewOfType(MarkdownView)) {
					this.bar.close();
				}
			}),
		);
	}

	onunload(): void {
		this.bar?.close();
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<StickyFindSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** The active Markdown view, but only while it is in an editing mode. */
	private editableView(): MarkdownView | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.getMode() !== "source") return null;
		return view;
	}

	private onKeyDown(evt: KeyboardEvent): void {
		if (this.closeOnEscape(evt)) return;

		if (!this.settings.takeOverFind) return;
		if (evt.key !== "f" && evt.key !== "F") return;
		if (evt.shiftKey || evt.altKey) return;

		// Exactly the platform's own find chord, nothing more exotic.
		const primary = Platform.isMacOS ? evt.metaKey : evt.ctrlKey;
		const secondary = Platform.isMacOS ? evt.ctrlKey : evt.metaKey;
		if (!primary || secondary) return;

		const view = this.editableView();
		if (!view) return;

		if (!this.shouldClaim(evt.target, view)) return;

		evt.preventDefault();
		evt.stopImmediatePropagation();
		this.openFind(view);
	}

	/**
	 * Close the bar on Escape, wherever focus happens to be in the note.
	 *
	 * The bar's own Escape handler sits on its input, so it only fires while the input has
	 * focus — and clicking into the note to read a match, which is the whole point of the
	 * bar, moves focus away. Escape then had nothing listening and the bar stayed up.
	 *
	 * Claimed on the same terms as the find chord itself, so Escape still belongs to
	 * whatever else might want it: another leaf (the chat sidebar cancelling a reply, say)
	 * fails {@link shouldClaim}, and a modal or an open suggester is checked for
	 * separately — those keep targeting the editor underneath, so shouldClaim cannot see
	 * them, and Escape is theirs to dismiss first.
	 *
	 * Returns whether the keystroke was consumed.
	 */
	private closeOnEscape(evt: KeyboardEvent): boolean {
		if (evt.key !== "Escape" || evt.isComposing) return false;
		const bar = this.bar;
		if (!bar) return false;
		if (this.popoverIsOpen()) return false;
		if (!this.shouldClaim(evt.target, bar.view)) return false;

		evt.preventDefault();
		evt.stopImmediatePropagation();
		bar.close();
		return true;
	}

	/** A modal, prompt or suggestion popup is up, and owns Escape. */
	private popoverIsOpen(): boolean {
		const popovers = document.querySelectorAll<HTMLElement>(
			".modal-container, .prompt, .suggestion-container",
		);
		// Laid out, not merely present: Obsidian keeps hidden suggestion containers around,
		// and treating one of those as open would put Escape right back where it was.
		return Array.from(popovers).some((el) => el.offsetParent !== null);
	}

	/**
	 * Whether this keystroke belongs to the active Markdown view.
	 *
	 * Anything with no leaf of its own — `document.body` when nothing in particular holds
	 * focus, say — counts, because that is still the active view's shortcut to claim. Only
	 * bail when the keystroke plainly belongs elsewhere: a modal, a suggestion popup, or
	 * another leaf such as the global search sidebar.
	 */
	private shouldClaim(target: EventTarget | null, view: MarkdownView): boolean {
		if (!(target instanceof HTMLElement)) return true;
		if (view.containerEl.contains(target)) return true;
		if (target.closest(".modal-container, .prompt, .suggestion-container, .menu")) return false;

		const leaf = target.closest(".workspace-leaf");
		return leaf === null;
	}

	private openFind(view: MarkdownView): void {
		const seed = this.seedFrom(view);

		if (this.bar && this.bar.view !== view) this.bar.close();
		if (!this.bar) {
			this.bar = new FindBar(view, this.settings.matchCase, (bar) => this.onBarClosed(bar));
		}
		this.bar.focus(seed);
	}

	/** Prefill with the current selection, the way the built-in find does. */
	private seedFrom(view: MarkdownView): string | undefined {
		const selection = view.editor.getSelection();
		if (!selection || selection.includes("\n") || selection.length > MAX_SEED_LENGTH) return undefined;
		return selection;
	}

	private onBarClosed(bar: FindBar): void {
		if (this.bar !== bar) return;
		if (bar.matchCase !== this.settings.matchCase) {
			this.settings.matchCase = bar.matchCase;
			void this.saveSettings();
		}
		this.bar = null;
	}
}
