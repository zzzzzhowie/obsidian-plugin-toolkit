import type { Extension } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { type App, type Component, type Editor, Platform, Scope, type TFile } from "obsidian";

/**
 * A real Obsidian markdown editor, embedded in the comments panel — so a comment is written
 * the way a note is: Live Preview, images and mermaid rendering as you type, and every
 * editor plugin working, including paste handlers such as the image uploader. Obsidian fires
 * `editor-paste` from each editor's own clipboard handling, not from MarkdownView, so an
 * editor built from its own component class gets those for free.
 *
 * There is no public API for this. The class is found the way several community plugins do
 * it: build a throwaway markdown embed, switch it to editing, and take the parent class of its
 * `editMode` — the component every Obsidian markdown editor is made from. Checked against the
 * 1.13.7 bundle: the embed's editMode is `new t1(widget)`, and t1 hands its parent
 * `(app, containerEl, owner)`. If any of that stops being true, `mountInput` falls back to a
 * plain textarea instead of failing.
 */

/** The parts of Obsidian's internal editor component used here. */
interface EditorComponent extends Component {
	editor: Editor & { cm: EditorView };
	/** `clear` rebuilds the editor state from scratch around the new text. */
	set(text: string, clear: boolean): void;
	buildLocalExtensions(): Extension[];
	focus(): void;
}

type EditorComponentClass = new (app: App, containerEl: HTMLElement, owner: unknown) => EditorComponent;

/** Resolved once: undefined = not tried yet, null = not available in this Obsidian. */
let editorClass: EditorComponentClass | null | undefined;

function resolveEditorClass(app: App): EditorComponentClass | null {
	if (editorClass !== undefined) return editorClass;
	editorClass = null;
	try {
		const registry = (app as unknown as {
			embedRegistry?: { embedByExtension?: Record<string, (ctx: unknown, file: null, subpath: string) => unknown> };
		}).embedRegistry;
		const createEmbed = registry?.embedByExtension?.md;
		if (!createEmbed) return null;
		const embed = createEmbed({ app, containerEl: document.createElement("div") }, null, "") as {
			editable: boolean;
			showEditor(): void;
			editMode?: object;
			unload(): void;
		};
		embed.editable = true;
		embed.showEditor();
		const base = embed.editMode ? (Object.getPrototypeOf(Object.getPrototypeOf(embed.editMode)) as { constructor?: unknown }) : null;
		embed.unload();
		if (typeof base?.constructor === "function") editorClass = base.constructor as EditorComponentClass;
	} catch (error) {
		console.error("Note comments: the embedded editor is unavailable, using a plain text box", error);
	}
	return editorClass;
}

/**
 * Marks our own editors. note-comments' editor extension runs in every editor, this one
 * included, and would otherwise read the owner below as the note itself and draw that note's
 * comments inside the comment box. The panel also ignores `editor-change` from these, or
 * typing into the box would re-render the panel and destroy the box being typed into.
 */
export const EMBEDDED_FLAG = "noteCommentsEmbedded";

export function isEmbeddedOwner(owner: unknown): boolean {
	return !!owner && (owner as Record<string, unknown>)[EMBEDDED_FLAG] === true;
}

/**
 * Stands in for the MarkdownView an editor normally belongs to. `file` is the note being
 * commented on, so links resolve relative to it and a pasted file lands in its attachment
 * folder — but every way the editor has of writing back (save, saveImmediately) goes nowhere:
 * the text is the comment, and must never reach the note.
 */
function makeOwner(app: App, file: TFile): Record<string, unknown> {
	const noop = (): void => {};
	return {
		app,
		[EMBEDDED_FLAG]: true,
		get file() {
			return file;
		},
		editMode: null,
		editor: null,
		getMode: () => "source",
		getFoldInfo: () => null,
		onMarkdownScroll: noop,
		onMarkdownFold: noop,
		syncScroll: noop,
		showPreview: noop,
		requestSave: noop,
		save: noop,
		saveImmediately: noop,
	};
}

export interface CommentInput {
	readonly value: string;
	focus(): void;
	destroy(): void;
}

export interface InputOptions {
	value: string;
	placeholder: string;
	/** The note the comment belongs to. */
	file: TFile;
	onSubmit(): void;
	onCancel(): void;
}

/**
 * A comment box in `parent`: the embedded editor when this Obsidian allows it, a textarea
 * otherwise. Either way Enter (or Mod+Enter) submits, Shift+Enter is a new line and Escape
 * cancels — through a scope pushed while the box has focus, because Obsidian handles
 * hotkeys on window in the capture phase, ahead of the editor, and Mod+Enter is already
 * "open link in new tab" there.
 */
export function mountInput(app: App, owner: Component, parent: HTMLElement, options: InputOptions): CommentInput {
	const host = parent.createDiv({ cls: "nc-input" });
	const scope = new Scope(app.scope);
	// An Enter that confirms an IME candidate belongs to the IME. WebKit (Obsidian on iOS)
	// reports that keydown after composition has ended, with only keyCode 229 to show it.
	// eslint-disable-next-line @typescript-eslint/no-deprecated -- nothing newer reports it; CodeMirror checks the same
	const composing = (evt: KeyboardEvent): boolean => evt.isComposing || evt.keyCode === 229;
	const submit = (evt: KeyboardEvent): boolean => {
		if (composing(evt)) return true;
		options.onSubmit();
		return false;
	};
	// Registered without modifiers, so Shift+Enter doesn't match and reaches the editor as a
	// new line. Not on a phone: its keyboard has no Shift+Return, so Return there stays the
	// only way to start a new line, and Save is the button under the box.
	if (!Platform.isMobile) scope.register([], "Enter", submit);
	scope.register(["Mod"], "Enter", submit);
	scope.register([], "Escape", (evt) => {
		if (composing(evt)) return true;
		options.onCancel();
		return false;
	});
	let scoped = false;
	const pushScope = (): void => {
		if (scoped) return;
		app.keymap.pushScope(scope);
		scoped = true;
	};
	const popScope = (): void => {
		if (!scoped) return;
		app.keymap.popScope(scope);
		scoped = false;
	};

	const Base = resolveEditorClass(app);
	if (Base) {
		try {
			return mountEditor(app, owner, host, Base, options, pushScope, popScope);
		} catch (error) {
			console.error("Note comments: could not create the embedded editor, using a plain text box", error);
			host.empty();
		}
	}

	host.addClass("is-plain");
	const textarea = host.createEl("textarea", { cls: "nc-panel-input", attr: { rows: "4", placeholder: options.placeholder } });
	textarea.value = options.value;
	textarea.addEventListener("focus", pushScope);
	textarea.addEventListener("blur", popScope);
	return {
		get value() {
			return textarea.value;
		},
		focus() {
			textarea.focus();
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		},
		destroy() {
			popScope();
			host.remove();
		},
	};
}

function mountEditor(
	app: App,
	parentComponent: Component,
	host: HTMLElement,
	Base: EditorComponentClass,
	options: InputOptions,
	pushScope: () => void,
	popScope: () => void,
): CommentInput {
	host.addClass("nc-embedded-editor");
	const owner = makeOwner(app, options.file);

	class CommentEditor extends Base {
		buildLocalExtensions(): Extension[] {
			return [
				...super.buildLocalExtensions(),
				placeholder(options.placeholder),
				EditorView.editorAttributes.of({ class: "nc-embedded-cm" }),
			];
		}
	}

	const editor = new CommentEditor(app, host, owner);
	// What `editor-paste` hands its listeners as the editor, and what the owner check in
	// note-comments' own extension compares against.
	owner.editMode = editor;
	owner.editor = editor.editor;
	editor.set(options.value, true);
	parentComponent.addChild(editor);

	const cm = editor.editor.cm;
	const workspace = app.workspace as unknown as {
		activeEditor: unknown;
		setActiveLeaf: (...args: unknown[]) => unknown;
	};

	// A click inside a view makes Obsidian activate that view's leaf, which focuses the leaf
	// and takes focus straight back out of this editor. So while the editor has focus,
	// activating *the leaf it lives in* is skipped. Only that leaf: mousedown fires before
	// focus moves, so blocking everything would also swallow a click into another tab.
	const original = workspace.setActiveLeaf;
	const guarded = function (this: unknown, ...args: unknown[]): unknown {
		const leaf = args[0] as { view?: { containerEl?: HTMLElement } } | undefined;
		if (cm.hasFocus && leaf?.view?.containerEl?.contains(host)) return undefined;
		return original.apply(this, args);
	};
	workspace.setActiveLeaf = guarded;

	// Obsidian's editor commands (bold, insert link…) act on `activeEditor`, so it points here
	// while the box has focus — and is handed back on the way out. Clicking back into the note
	// doesn't change the active leaf, so nothing else would reset it, and Cmd+B in the note
	// would then format the comment instead.
	let previousEditor: unknown = null;
	const onFocusIn = (): void => {
		pushScope();
		if (workspace.activeEditor !== owner) previousEditor = workspace.activeEditor;
		workspace.activeEditor = owner;
	};
	const onFocusOut = (): void => {
		popScope();
		if (workspace.activeEditor === owner) workspace.activeEditor = previousEditor;
	};
	cm.contentDOM.addEventListener("focusin", onFocusIn);
	cm.contentDOM.addEventListener("focusout", onFocusOut);

	return {
		get value() {
			return cm.state.doc.toString();
		},
		focus() {
			editor.focus();
			cm.dispatch({ selection: { anchor: cm.state.doc.length } });
		},
		destroy() {
			popScope();
			cm.contentDOM.removeEventListener("focusin", onFocusIn);
			cm.contentDOM.removeEventListener("focusout", onFocusOut);
			// Only unwrap if nothing has wrapped it since; otherwise leave the chain intact —
			// with this editor gone, its guard simply lets every call through.
			if (workspace.setActiveLeaf === guarded) workspace.setActiveLeaf = original;
			if (workspace.activeEditor === owner) workspace.activeEditor = previousEditor;
			parentComponent.removeChild(editor);
			host.remove();
		},
	};
}
