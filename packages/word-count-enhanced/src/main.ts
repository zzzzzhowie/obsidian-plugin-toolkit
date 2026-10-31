import { type Editor, type Events, Plugin } from "obsidian";

/** On the word count while it counts the selection, not the whole note. */
const SELECTION_CLS = "yeyan-word-count-selection";

/**
 * Obsidian's word count counts the editor's selection while there is one, else the whole
 * note — the same "5 words" either way. This marks the selection's count as such, following
 * the core plugin's own rule: a selection change with text selected counts it; one without,
 * and opening a note, count the note. Marked as the count it goes with lands, since the count
 * comes off a worker 200ms after the event.
 */
export default class WordCountPlugin extends Plugin {
	onload(): void {
		let selection = false;
		const item = (): HTMLElement | null => document.body.querySelector<HTMLElement>(".status-bar-item.plugin-word-count");
		const observer = new MutationObserver(() => item()?.toggleClass(SELECTION_CLS, selection));
		this.app.workspace.onLayoutReady(() => {
			const el = item();
			if (el) observer.observe(el, { childList: true, subtree: true, characterData: true });
		});
		// Not in Obsidian's typings, but what the word count listens to.
		const workspace = this.app.workspace as unknown as Events;
		this.registerEvent(
			workspace.on("editor-selection-change", (editor: Editor) => {
				selection = editor.getSelection() !== "";
			}),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				selection = false;
			}),
		);
		this.register(() => {
			observer.disconnect();
			item()?.removeClass(SELECTION_CLS);
		});
	}
}
