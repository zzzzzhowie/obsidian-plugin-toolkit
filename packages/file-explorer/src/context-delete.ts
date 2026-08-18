import {
	App,
	Editor,
	EditorChange,
	MarkdownView,
	Notice,
	Plugin,
	TAbstractFile,
} from "obsidian";

// VSCode-style contextual delete.
//
// In VSCode, Cmd/Ctrl+Backspace means "delete the thing in front of me": the
// selected files when the explorer has focus, the current line when the editor
// does. Obsidian can't express that in a single hotkey — a hotkey bound in
// Settings → Hotkeys is global, and `Keymap.onKeyEvent` consumes the event as
// soon as one bound command matches (a command declining via `checkCallback`
// does NOT hand the key back). So the dispatch has to happen inside one command.
//
// Note that Obsidian DOES scope keys per pane, just not through the hotkey
// table: `workspace.scope` delegates to `activeLeaf.view.scope` before bubbling
// up to `app.scope` (where the hotkey manager lives). The file explorer uses
// that to bind Mod+Backspace (macOS) / Delete (elsewhere) to its own
// "delete selected items" handler. So when the explorer is the active leaf, the
// native binding wins and this command never even runs from the keyboard — the
// explorer branch below exists for the command palette, and for when the
// command is bound to a key the explorer doesn't claim.
//
// Deciding *where* the keystroke happened is the subtle part — see
// `isExplorerContext` below. Neither `document.activeElement` nor `activeLeaf`
// is trustworthy on its own.

const FILE_EXPLORER_VIEW_TYPE = "file-explorer";

/** Minimal shape of the internal file explorer view we rely on. */
interface FileExplorerInternals {
	onDeleteSelectedFiles?: () => void;
	tree?: {
		focusedItem?: { file?: TAbstractFile } | null;
		selectedDoms?: Set<{ file?: TAbstractFile }>;
	};
}

export function registerContextDelete(plugin: Plugin): void {
	plugin.addCommand({
		id: "context-delete",
		name: "Delete (line in editor, selected items in file explorer)",
		callback: () => contextDelete(plugin.app),
	});
}

function contextDelete(app: App): void {
	if (isExplorerContext(app)) {
		deleteExplorerSelection(app);
		return;
	}

	const editor = app.workspace.getActiveViewOfType(MarkdownView)?.editor;
	if (editor) {
		deleteLines(editor);
	}
}

/**
 * Whether the keystroke belongs to the file explorer rather than the editor.
 *
 * DOM focus decides first, and `activeLeaf` is only a fallback: clicking a note
 * in the tree opens it but leaves the *explorer* as the active leaf (so arrow
 * keys keep navigating the tree), which means `activeLeaf` still says
 * "file-explorer" while you type in the editor. Trusting it alone deletes the
 * note instead of the line — and with "Confirm file deletion" off, silently.
 *
 * Obsidian gives commands no access to the triggering event
 * (`HotkeyManager.onTrigger` calls `executeCommand` without it, so
 * `app.lastEvent` is null), hence `document.activeElement`.
 */
export function isExplorerContext(app: App): boolean {
	const active = document.activeElement;

	// Anything editable wins outright and keeps its own behaviour: the editor,
	// inline titles, property fields, search and rename boxes.
	if (
		active?.closest(".cm-editor, input, textarea, [contenteditable='true']")
	) {
		return false;
	}

	if (
		active?.closest(
			`.workspace-leaf-content[data-type="${FILE_EXPLORER_VIEW_TYPE}"]`,
		)
	) {
		return true;
	}

	// The tree keeps DOM focus on <body>, so a keystroke there is only ours if
	// the explorer is also the active pane. `activeLeaf` is deprecated but it is
	// the only way to ask; `getActiveViewOfType` can't reach non-markdown views.
	return app.workspace.activeLeaf?.view.getViewType() === FILE_EXPLORER_VIEW_TYPE;
}

/**
 * Delete whatever the file explorer has selected, preferring Obsidian's own
 * handler so multi-selection and the confirmation prompt behave natively.
 */
function deleteExplorerSelection(app: App): void {
	const view = app.workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE)[0]
		?.view as (FileExplorerInternals & object) | undefined;

	if (typeof view?.onDeleteSelectedFiles === "function") {
		view.onDeleteSelectedFiles();
		return;
	}

	// Fallbacks for when the internal handler moves or disappears: delete the
	// focused item, then the selection, then the open file.
	const tree = view?.tree;
	const files: TAbstractFile[] = [];
	const focused = tree?.focusedItem?.file;
	if (focused) {
		files.push(focused);
	} else if (tree?.selectedDoms) {
		for (const dom of tree.selectedDoms) {
			if (dom.file) files.push(dom.file);
		}
	}
	if (files.length === 0) {
		const active = app.workspace.getActiveFile();
		if (active) files.push(active);
	}

	if (files.length === 0) {
		new Notice("Nothing selected in the file explorer");
		return;
	}

	// `promptForDeletion` honours Settings → Files and links → Deleted files,
	// so this respects the user's system-trash / .trash choice.
	void (async () => {
		for (const file of files) {
			await app.fileManager.promptForDeletion(file);
		}
	})();
}

/**
 * Delete every line touched by a cursor or selection, as one undo step.
 * Multiple cursors are supported; overlapping cursors collapse to one line.
 */
export function deleteLines(editor: Editor): void {
	const touched = new Set<number>();
	for (const selection of editor.listSelections()) {
		const from = Math.min(selection.anchor.line, selection.head.line);
		const to = Math.max(selection.anchor.line, selection.head.line);
		for (let line = from; line <= to; line++) {
			touched.add(line);
		}
	}
	if (touched.size === 0) {
		touched.add(editor.getCursor().line);
	}

	const lastLine = editor.lastLine();
	const cursor = editor.getCursor();
	const changes: EditorChange[] = [];

	// All changes in one transaction are mapped against the *original* document,
	// so their order doesn't matter — but they must not overlap. Merging
	// contiguous lines into a single range is what guarantees that.
	for (const [start, end] of contiguousRanges(touched)) {
		if (end < lastLine) {
			// Swallow the trailing newline.
			changes.push({
				from: { line: start, ch: 0 },
				to: { line: end + 1, ch: 0 },
				text: "",
			});
		} else if (start > 0) {
			// Last line of the document: swallow the *leading* newline instead,
			// otherwise an empty line is left behind.
			changes.push({
				from: {
					line: start - 1,
					ch: editor.getLine(start - 1).length,
				},
				to: { line: end, ch: editor.getLine(end).length },
				text: "",
			});
		} else {
			// Whole document selected: just empty it.
			changes.push({
				from: { line: 0, ch: 0 },
				to: { line: end, ch: editor.getLine(end).length },
				text: "",
			});
		}
	}

	editor.transaction({ changes });

	// Land on the first deleted line, keeping the column where possible — the
	// same place VSCode leaves the caret.
	const target = Math.min(Math.min(...touched), editor.lastLine());
	editor.setCursor({
		line: target,
		ch: Math.min(cursor.ch, editor.getLine(target).length),
	});
}

/** [1,2,3,7,8] -> [[1,3],[7,8]] */
function contiguousRanges(lines: Set<number>): [number, number][] {
	const sorted = [...lines].sort((a, b) => a - b);
	const ranges: [number, number][] = [];
	for (const line of sorted) {
		const last = ranges[ranges.length - 1];
		if (last && line === last[1] + 1) {
			last[1] = line;
		} else {
			ranges.push([line, line]);
		}
	}
	return ranges;
}
