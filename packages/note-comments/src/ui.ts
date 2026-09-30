import { Notice, type TFile, setIcon } from "obsidian";

import type { CommentStore } from "./store";

/** Delete a comment, with a notice that can bring it back. */
export function deleteWithUndo(store: CommentStore, file: TFile, id: string): void {
	const removed = store.remove(file.path, id);
	if (!removed) return;
	const message = document.createDocumentFragment();
	message.appendText("Comment deleted. ");
	const undo = message.createEl("a", { text: "Undo", href: "#" });
	const notice = new Notice(message, 8000);
	undo.addEventListener("click", (evt) => {
		evt.preventDefault();
		// `file.path` read now, not captured: the note may have been renamed meanwhile.
		store.restore(file.path, removed);
		notice.hide();
	});
}

export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
	const button = parent.createDiv({ cls: "clickable-icon nc-icon-button", attr: { "aria-label": label } });
	setIcon(button, icon);
	button.addEventListener("click", (evt) => {
		evt.preventDefault();
		evt.stopPropagation();
		onClick();
	});
	return button;
}

export function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatWhen(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
