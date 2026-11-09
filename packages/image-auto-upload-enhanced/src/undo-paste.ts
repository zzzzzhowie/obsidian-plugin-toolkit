import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";

/** Steps taken at most for one Cmd+Z, so a placeholder that won't go can't loop. */
const MAX_STEPS = 5;

/**
 * One Cmd+Z takes back a whole paste. A paste is two edits — the "Uploading image..."
 * placeholder, then the image put in its place once the upload is done — so undoing it
 * stopped halfway, at the placeholder of an upload long finished. When an undo brings one
 * back, the undo goes on until it's gone; a redo that brings one back goes on to the image.
 *
 * `placeholders` gives the placeholder texts of the uploads that have finished (or failed).
 */
export function undoWholePaste(placeholders: () => Iterable<string>) {
	const steps = new WeakMap<EditorView, number>();
	return EditorView.updateListener.of((update) => {
		const back = update.transactions.some((tr) => tr.isUserEvent("undo"));
		const forward = update.transactions.some((tr) => tr.isUserEvent("redo"));
		if (!back && !forward) return;
		const doc = update.state.doc.toString();
		let left = false;
		for (const text of placeholders()) if (doc.includes(text)) left = true;
		const taken = steps.get(update.view) ?? 0;
		if (!left || taken >= MAX_STEPS) {
			steps.delete(update.view);
			return;
		}
		steps.set(update.view, taken + 1);
		// Not from inside the update: a view can't be dispatched to while it's applying one.
		window.setTimeout(() => (back ? undo : redo)(update.view), 0);
	});
}
