import {
	type EditorState,
	type Extension,
	type Range,
	StateEffect,
	StateField,
	Transaction,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { editorEditorField, editorInfoField, type TFile } from "obsidian";

import { anchor, captureSelectors, type Selectors, type Span } from "./anchor";
import { isEmbeddedOwner } from "./embedded-editor";
import type { CommentStore, NoteComment, StoreListener } from "./store";

/**
 * Drawing comments in the editor, and keeping them attached while the note changes.
 *
 * How Obsidian drives an editor shapes all of this, so it is worth stating (checked against
 * the 1.13.7 app bundle):
 *
 * - Opening another note in a tab does not dispatch into the existing state. Obsidian builds
 *   a new one with `EditorState.create` and calls `setState`, so every StateField is created
 *   afresh and every ViewPlugin is destroyed and rebuilt. That is why a comment set is bound
 *   to its file once, in `create()`, and never re-detected.
 * - Changes that don't come from typing — the file changed on disk, the same note typed into
 *   in another pane, switching back from reading view — arrive as a single replaced hunk
 *   (userEvent "set"). Every mark inside it is dropped by mapping, so those are looked for
 *   again rather than given up.
 */

/**
 * The passage a new comment is being written for, while its draft is open in the panel. Kept
 * here rather than as numbers in the panel so it maps through edits made meanwhile — the
 * draft saves against wherever that text has moved to by then.
 */
interface Pending {
	from: number;
	to: number;
}

export interface CommentsValue {
	/** The note this editor state belongs to; null for editors that must not carry comments. */
	file: TFile | null;
	/** One mark per comment currently drawn, carrying the comment's id in its spec. */
	decos: DecorationSet;
	/** Comments whose text a user edit deleted. Retried on undo/redo, never reported lost. */
	lost: ReadonlySet<string>;
	pending: Pending | null;
}

export const addCommentEffect = StateEffect.define<{ id: string } & Span>();
export const removeCommentEffect = StateEffect.define<string>();
export const setPendingEffect = StateEffect.define<Pending | null>();

const NONE: ReadonlySet<string> = new Set();
const INERT: CommentsValue = { file: null, decos: Decoration.none, lost: NONE, pending: null };
const PENDING_MARK = Decoration.mark({ class: "nc-pending" });

function markFor(id: string): Decoration {
	return Decoration.mark({ class: "nc-highlight", id, attributes: { "data-nc-id": id } });
}

function idOf(deco: Decoration): string {
	return (deco.spec as { id: string }).id;
}

/** Everything the editor side needs from the plugin. */
export interface EditorHostDeps {
	store: CommentStore;
}

/**
 * The live editors, and the bridge from store changes to what they draw. Split panes,
 * hover previews and canvas cards can all show the same note, each with its own state, so a
 * comment created in one has to appear in the others.
 */
export class EditorHost implements StoreListener {
	readonly editors = new Set<CommentsView>();
	/** Set by any document change, cleared by `reportAll`; keeps the idle flush cheap. */
	dirty = false;
	readonly field: StateField<CommentsValue>;

	constructor(readonly deps: EditorHostDeps) {
		this.field = buildField(this);
	}

	extension(): Extension {
		// The highlight only marks the text. Reading the comment is the plugin's: a card on
		// hover (hover.ts), the panel on a click (its click handling).
		return [this.field, ViewPlugin.define((view) => new CommentsView(view, this))];
	}

	valueOf(state: EditorState): CommentsValue | null {
		return state.field(this.field, false) ?? null;
	}

	/** Where `id` is drawn in `state`, or null when it isn't (not found, or not this note). */
	spanOf(state: EditorState, id: string): Span | null {
		const value = this.valueOf(state);
		if (!value) return null;
		for (const iter = value.decos.iter(); iter.value; iter.next()) {
			if (idOf(iter.value) === id) return { from: iter.from, to: iter.to };
		}
		return null;
	}

	/** Hand the store where every comment drawn in `state` now sits. */
	report(state: EditorState): void {
		const value = this.valueOf(state);
		if (!value?.file || this.deps.store.disposed) return;
		const doc = state.doc.toString();
		const reported = new Map<string, Selectors>();
		value.decos.between(0, doc.length, (from, to, deco) => {
			reported.set(idOf(deco), captureSelectors(doc, from, to));
		});
		this.deps.store.updatePositions(value.file.path, reported);
	}

	reportAll(): void {
		for (const editor of this.editors) this.report(editor.view.state);
		this.dirty = false;
	}

	/** Mark `span` as the passage a new comment is being drafted for (replacing any other). */
	beginDraft(view: EditorView, span: Span): void {
		view.dispatch({ effects: setPendingEffect.of({ from: span.from, to: span.to }) });
	}

	/** The passage still waiting for its comment in `state`, if any. */
	draftSpan(state: EditorState): Span | null {
		const pending = this.valueOf(state)?.pending;
		return pending ? { from: pending.from, to: pending.to } : null;
	}

	endDraft(view: EditorView): void {
		if (this.valueOf(view.state)?.pending) {
			view.dispatch({ effects: setPendingEffect.of(null) });
		}
	}

	/**
	 * Save the draft as a comment. The range is read from the field now, not from when the
	 * draft began — it has been mapped through anything that happened in the meantime.
	 * Returns null when there is nothing to save: the passage was deleted out from under the
	 * draft, the editor moved on to another note, or the text is empty (a cancelled comment).
	 */
	submit(view: EditorView, body: string): NoteComment | null {
		const value = this.valueOf(view.state);
		const pending = value?.pending;
		const text = body.trim();
		if (!value?.file || !pending || !text) return null;
		const doc = view.state.doc.toString();
		const comment = this.deps.store.create(value.file.path, captureSelectors(doc, pending.from, pending.to), text);
		this.endDraft(view);
		return comment;
	}

	added(path: string, comment: NoteComment): void {
		for (const editor of this.editors) {
			const value = this.valueOf(editor.view.state);
			if (value?.file?.path !== path || hasId(value.decos, comment.id)) continue;
			// Each editor finds it in its own document rather than copying offsets from
			// another: a sibling pane can be a few keystrokes behind.
			const span = anchor(editor.view.state.doc.toString(), comment);
			if (span) {
				this.dispatchWhenIdle(editor.view, path, addCommentEffect.of({ id: comment.id, ...span }));
			}
		}
	}

	removed(path: string, id: string): void {
		for (const editor of this.editors) {
			const value = this.valueOf(editor.view.state);
			if (value?.file?.path === path && hasId(value.decos, id)) {
				this.dispatchWhenIdle(editor.view, path, removeCommentEffect.of(id));
			}
		}
	}

	/**
	 * Dispatching into an editor mid-composition breaks the input method's state, so a store
	 * change waits until the candidate is committed. By then the editor may have gone, or be
	 * showing another note — the effect would then plant a mark in the wrong file — so both
	 * are checked again right before it lands.
	 */
	private dispatchWhenIdle(view: EditorView, path: string, effect: StateEffect<unknown>): void {
		if (![...this.editors].some((editor) => editor.view === view)) return;
		if (this.valueOf(view.state)?.file?.path !== path) return;
		if (view.composing) {
			window.setTimeout(() => this.dispatchWhenIdle(view, path, effect), 100);
			return;
		}
		view.dispatch({ effects: effect });
	}

}

/**
 * Tracks the most recent state of one editor, and reports it when the editor goes away.
 *
 * `lastState` rather than `view.state` in `destroy()`: on a plugin disable, the view has
 * already been reconfigured to a state without our field by the time this runs, and on a
 * leaf close or file switch `view.state` is either the old state or an empty one depending on
 * the path taken. The last state this plugin saw is the right one in every case.
 */
class CommentsView implements PluginValue {
	private lastState: EditorState;

	constructor(
		readonly view: EditorView,
		private readonly host: EditorHost,
	) {
		this.lastState = view.state;
		host.editors.add(this);
	}

	update(update: ViewUpdate): void {
		this.lastState = update.state;
		if (update.docChanged) this.host.dirty = true;
	}

	destroy(): void {
		this.host.editors.delete(this);
		this.host.report(this.lastState);
	}
}

function buildField(host: EditorHost): StateField<CommentsValue> {
	const field: StateField<CommentsValue> = StateField.define<CommentsValue>({
		create(state) {
			const file = boundFile(state);
			if (!file || host.deps.store.disposed) return INERT;
			// Anchored here, synchronously, so the highlights are part of the very first
			// render: no second dispatch after load, and no frame without them.
			const doc = state.doc.toString();
			const ranges: Range<Decoration>[] = [];
			for (const comment of host.deps.store.commentsFor(file.path)) {
				const span = anchor(doc, comment);
				if (span) ranges.push(markFor(comment.id).range(span.from, span.to));
			}
			return { file, decos: Decoration.set(ranges, true), lost: NONE, pending: null };
		},

		update(value, tr) {
			const file = value.file;
			if (!file) return value;

			let decos = tr.docChanged ? value.decos.map(tr.changes) : value.decos;
			let lost = value.lost;
			let pending = value.pending;
			if (pending && tr.docChanged) {
				const from = tr.changes.mapPos(pending.from, 1);
				const to = tr.changes.mapPos(pending.to, -1);
				// The text being commented on was deleted out from under the draft.
				pending = from < to ? { ...pending, from, to } : null;
			}

			for (const effect of tr.effects) {
				if (effect.is(addCommentEffect)) {
					const { id, from, to } = effect.value;
					if (!hasId(decos, id)) decos = decos.update({ add: [markFor(id).range(from, to)], sort: true });
				} else if (effect.is(removeCommentEffect)) {
					const id = effect.value;
					decos = decos.update({ filter: (_from, _to, deco) => idOf(deco) !== id });
					if (lost.has(id)) lost = without(lost, id);
				} else if (effect.is(setPendingEffect)) {
					pending = effect.value;
				}
			}

			if (tr.docChanged && decos.size < value.decos.size) {
				const dropped = [...idsOf(value.decos)].filter((id) => !hasId(decos, id));
				if (isSystemEdit(tr)) {
					// Obsidian replaced a whole hunk; the text is most likely still there.
					const result = reanchor(host.deps.store, tr.state, file, dropped, decos);
					decos = result.decos;
					lost = union(lost, result.missing);
				} else {
					// The user deleted it. Keep it in reach of undo, not of the store.
					lost = union(lost, dropped);
				}
			}

			if (lost.size > 0 && (isSystemEdit(tr) || tr.isUserEvent("undo") || tr.isUserEvent("redo"))) {
				const result = reanchor(host.deps.store, tr.state, file, [...lost], decos);
				decos = result.decos;
				lost = new Set(result.missing);
			}

			if (decos === value.decos && lost === value.lost && pending === value.pending) return value;
			return { file, decos, lost, pending };
		},

		provide: (f) => [
			EditorView.decorations.from(f, (value) => value.decos),
			// Focus moving to the draft in the panel always takes the native selection with
			// it, so the text being commented on is painted by us for as long as the draft is open.
			EditorView.decorations.from(f, (value) =>
				value.pending
					? Decoration.set([PENDING_MARK.range(value.pending.from, value.pending.to)])
					: Decoration.none,
			),
		],
	});
	return field;
}

/**
 * The note an editor state belongs to, or null when it must not carry comments.
 *
 * Live Preview renders every table cell with its own small editor whose owner is still the
 * note. Without the second check such a cell would bind to the note and then read and write
 * comment positions in its own cell-local offsets. The note's own editor is the one whose view
 * is the owner's editor.
 */
function boundFile(state: EditorState): TFile | null {
	const info = state.field(editorInfoField, false);
	// A comment box in the panel: its owner stands in for the note (so links and pasted
	// files resolve against it), but the text is a comment and carries none of its own.
	if (isEmbeddedOwner(info)) return null;
	const own = state.field(editorEditorField, false);
	const file = info?.file;
	if (!file || file.extension !== "md" || !own) return null;
	const ownerView = (info as unknown as { editor?: { cm?: EditorView } }).editor?.cm;
	return ownerView === own ? file : null;
}

/**
 * A change that didn't come from the user typing: Obsidian syncing the editor with the file on
 * disk or with another pane (userEvent "set"), or a plugin replacing the text wholesale with
 * `Editor.setValue` (no userEvent at all).
 */
function isSystemEdit(tr: Transaction): boolean {
	return tr.isUserEvent("set") || tr.annotation(Transaction.userEvent) === undefined;
}

function reanchor(
	store: CommentStore,
	state: EditorState,
	file: TFile,
	ids: readonly string[],
	decos: DecorationSet,
): { decos: DecorationSet; missing: string[] } {
	if (ids.length === 0) return { decos, missing: [] };
	const doc = state.doc.toString();
	const add: Range<Decoration>[] = [];
	const missing: string[] = [];
	for (const id of ids) {
		const comment = store.get(file.path, id);
		// Deleted meanwhile: nothing to find, and nothing to keep hold of.
		if (!comment) continue;
		const span = hasId(decos, id) ? null : anchor(doc, comment);
		if (span) add.push(markFor(id).range(span.from, span.to));
		else if (!hasId(decos, id)) missing.push(id);
	}
	return { decos: add.length ? decos.update({ add, sort: true }) : decos, missing };
}

function idsOf(decos: DecorationSet): Set<string> {
	const ids = new Set<string>();
	for (const iter = decos.iter(); iter.value; iter.next()) ids.add(idOf(iter.value));
	return ids;
}

function hasId(decos: DecorationSet, id: string): boolean {
	for (const iter = decos.iter(); iter.value; iter.next()) {
		if (idOf(iter.value) === id) return true;
	}
	return false;
}

function union(a: ReadonlySet<string>, b: Iterable<string>): ReadonlySet<string> {
	const next = new Set(a);
	for (const id of b) next.add(id);
	return next.size === a.size ? a : next;
}

function without(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
	const next = new Set(set);
	next.delete(id);
	return next;
}

