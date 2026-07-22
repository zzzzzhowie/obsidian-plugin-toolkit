import { Plugin, WorkspaceLeaf } from "obsidian";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { EditorState, RangeSetBuilder } from "@codemirror/state";

/** The chat leaf registered by the Claudian plugin (id: realclaudian). */
const CLAUDIAN_VIEW = "claudian-view";
/** The main chat composer inside that leaf (placeholder "How can i help you today?"). */
const CLAUDIAN_INPUT = "textarea.claudian-input";
/** Claudian's own command that opens/reveals its view. */
const OPEN_COMMAND = "realclaudian:open-view";
/** View to switch to when Claudian is toggled away inside a sidebar (the sidebar's default). */
const SIDEBAR_DEFAULT_VIEW = "outline";
/** Core Outline plugin's command — used to recreate the outline leaf if its tab was closed. */
const OUTLINE_OPEN_COMMAND = "outline:open";
/**
 * How long after a ⌘L press we keep guarding the editor selection. Slightly longer
 * than the focus-settle deadline so the guard outlives the focus churn it fights.
 */
const SELECTION_KEEP_MS = 1600;

/** CSS class for our own selection highlight (see styles.css). */
const HIGHLIGHT_CLASS = "claudian-enhanced-selection";

/** `app.commands` is a stable but undocumented Obsidian API (not in the public typings). */
interface AppWithCommands {
	commands: { executeCommandById(id: string): boolean };
}

/**
 * Paint the current selection as a mark decoration while the editor is
 * *unfocused*.
 *
 * Obsidian's built-in drawn selection (`.cm-selectionBackground`) is only
 * rendered while the editor has focus — the moment ⌘L moves focus to the
 * Claudian composer the layer empties out, so the 划词 highlight vanishes even
 * though the selection *state* is intact. A content-based mark decoration is
 * focus-independent, so it keeps the selection visibly highlighted the whole
 * time Claudian carries it over. Clamped to the viewport because a ViewPlugin
 * may only decorate the rendered range.
 */
function buildHighlight(view: EditorView): DecorationSet {
	if (view.hasFocus) return Decoration.none;
	const sel = view.state.selection.main;
	const from = Math.max(sel.from, view.viewport.from);
	const to = Math.min(sel.to, view.viewport.to);
	if (from >= to) return Decoration.none;
	const builder = new RangeSetBuilder<Decoration>();
	builder.add(from, to, Decoration.mark({ class: HIGHLIGHT_CLASS }));
	return builder.finish();
}

const unfocusedSelectionHighlighter = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = buildHighlight(view);
		}
		update(u: ViewUpdate): void {
			if (
				u.focusChanged ||
				u.selectionSet ||
				u.docChanged ||
				u.viewportChanged
			) {
				this.decorations = buildHighlight(u.view);
			}
		}
	},
	{ decorations: (v) => v.decorations },
);

/**
 * Range the collapse-blocker is protecting, plus an expiry. Set on every toggle
 * from the snapshot and read by {@link selectionCollapseBlocker}.
 */
let collapseGuard: { until: number; from: number; to: number } | null = null;

/**
 * Veto the *transient* selection collapse that CM6 emits when the editor
 * refocuses with a stale (browser-cleared) DOM selection during a ⌘L toggle.
 *
 * Restoring the range after the fact (see {@link ClaudianEnhancedPlugin.keepSelection})
 * fixes our own state and highlight, but it's too late for Claudian: its
 * selection poll runs on a timer and samples the momentary *empty* selection,
 * then drops the context it was carrying over. A `transactionFilter` rejects the
 * collapsing transaction before it ever commits, so no async reader can observe
 * an empty selection. Scoped tightly — only within the post-toggle window, only
 * a selection-only move, and only when it collapses exactly the guarded range —
 * so genuine edits and unrelated cursor moves pass through untouched.
 *
 * Crucially it also lets pointer-driven collapses through (`select.pointer`): a
 * click in the editor is the user deliberately dismissing the selection and must
 * take effect on the first click. Only the *involuntary* focus-sync collapse
 * (keyboard ⌘L, no pointer) is vetoed.
 */
const selectionCollapseBlocker = EditorState.transactionFilter.of((tr) => {
	const g = collapseGuard;
	if (!g || Date.now() > g.until || tr.docChanged) return tr;
	if (tr.isUserEvent("select.pointer")) return tr;
	const before = tr.startState.selection.main;
	const after = tr.newSelection.main;
	const collapsesGuarded =
		!before.empty &&
		after.empty &&
		before.from === g.from &&
		before.to === g.to;
	return collapsesGuarded ? [] : tr;
});

export default class ClaudianEnhancedPlugin extends Plugin {
	/** Bumped on every toggle; a stale focus/selection loop compares against it and bails. */
	private gen = 0;
	/** The editor selection to protect while ⌘L shuffles focus around. */
	private savedSel: { from: number; to: number } | null = null;
	/** Timestamp of the last toggle — lets us tell a fresh press from a rapid re-press. */
	private lastToggleAt = 0;

	async onload(): Promise<void> {
		this.addCommand({
			id: "toggle-claudian",
			// "Claudian" is a proper noun (the plugin's name), so it stays capitalized.
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			name: "Toggle Claudian chat",
			callback: () => this.toggle(),
		});
		this.registerEditorExtension([
			unfocusedSelectionHighlighter,
			selectionCollapseBlocker,
		]);
	}

	private toggle(): void {
		// Each press starts a new generation; an in-flight focus/selection loop from
		// an earlier press sees the bump and stops, so rapid ⌘L can't stack loops.
		const gen = ++this.gen;
		// Snapshot the selection *before* we move focus. Moving focus to Claudian's
		// composer clears the editor's DOM selection; when the editor later refocuses,
		// CM6 tries to sync state to that collapsed DOM range. Arm the collapse-blocker
		// with the range so that sync is vetoed outright, which keeps both the editor
		// and Claudian's poll from ever seeing an empty selection.
		this.snapshotSelection();
		collapseGuard = this.savedSel
			? {
					until: Date.now() + SELECTION_KEEP_MS,
					from: this.savedSel.from,
					to: this.savedSel.to,
				}
			: null;
		const leaf = this.getClaudianLeaf();
		if (leaf && this.isLeafVisible(leaf)) {
			// Claudian is showing → switch its sidebar back to the default (outline)
			// tab. We never detach: Claudian's tab stays alive so the next ⌘L flips
			// straight back to it and the dock never closes. The note is kept active
			// so Claudian keeps carrying over the selection (see revealSidebarDefault).
			this.revealSidebarDefault(leaf);
		} else {
			this.openClaudian(gen);
		}
		this.lastToggleAt = Date.now();
	}

	/**
	 * Record the note's current selection so the collapse-blocker can protect it.
	 *
	 * A non-empty selection is captured verbatim. An *empty* selection is ambiguous:
	 * on a rapid re-press it's the collapse we're fighting (keep the saved range so
	 * it stays protected), but on a cold press it means the user genuinely has no
	 * selection and must not have a stale one forced back — so we clear it.
	 */
	private snapshotSelection(): void {
		const cm = this.getNoteCM();
		if (!cm) return;
		const main = cm.state.selection.main;
		if (!main.empty) {
			this.savedSel = { from: main.from, to: main.to };
		} else if (Date.now() - this.lastToggleAt >= SELECTION_KEEP_MS) {
			this.savedSel = null;
		}
	}

	private openClaudian(gen: number): void {
		// Reveal the existing tab if present (keeps a single Claudian tab); only let
		// Claudian create one on the very first open. Revealing an in-sidebar leaf
		// just switches the active tab — the dock stays open.
		const existing = this.getClaudianLeaf();
		if (existing) {
			this.ensureSideOpen(this.sidebarOf(existing));
			void this.app.workspace.revealLeaf(existing);
		} else {
			(this.app as unknown as AppWithCommands).commands.executeCommandById(
				OPEN_COMMAND,
			);
		}
		this.stickyFocusInput(Date.now() + 1500, gen);
	}

	private revealSidebarDefault(claudianLeaf: WorkspaceLeaf): void {
		const side = this.sidebarOf(claudianLeaf);
		this.ensureSideOpen(side);
		// Capture the note before revealing Outline steals "active leaf" status.
		const noteLeaf = this.getNoteLeaf();
		const restore = this.findSidebarDefault(side);
		if (restore) {
			this.revealKeepingNoteActive(restore, noteLeaf);
			return;
		}
		// The outline tab was closed, so there's nothing to flip back to — ⌘L would
		// otherwise be a dead key stuck on Claudian. Let the core Outline command
		// (re)create its leaf, then reveal it so the toggle stays symmetric.
		(this.app as unknown as AppWithCommands).commands.executeCommandById(
			OUTLINE_OPEN_COMMAND,
		);
		const created = this.findSidebarDefault(side);
		if (created) this.revealKeepingNoteActive(created, noteLeaf);
	}

	/**
	 * Reveal a sidebar tab, then hand "active leaf" back to the note (without stealing
	 * focus) once the async reveal settles.
	 *
	 * Claudian's selection poll only reads the *active* MarkdownView; if Outline stays
	 * active it sees no note and drops the carried-over selection. Keeping the note
	 * active means the poll keeps reading the (collapse-guarded) selection, so the
	 * context survives the toggle — without Claudian's grace window, which used to
	 * make its highlight linger ~1s after a later click in the editor.
	 */
	private revealKeepingNoteActive(
		tab: WorkspaceLeaf,
		noteLeaf: WorkspaceLeaf | null,
	): void {
		void this.app.workspace.revealLeaf(tab).then(() => {
			if (noteLeaf) this.app.workspace.setActiveLeaf(noteLeaf, { focus: false });
		});
	}

	private findSidebarDefault(
		side: "right" | "left" | null,
	): WorkspaceLeaf | undefined {
		return this.app.workspace
			.getLeavesOfType(SIDEBAR_DEFAULT_VIEW)
			.find((candidate) => this.sidebarOf(candidate) === side);
	}

	/**
	 * Land and keep the caret in Claudian's composer.
	 *
	 * Claudian focuses its own tab root (`rootEl`) inside a rAF after every render,
	 * yanking focus off the composer, so a single focus() loses the race. We
	 * re-assert focus until it holds for a short settle window or the deadline
	 * passes. The tab is already revealed by the caller, so this never re-reveals
	 * it (which would flicker the dock).
	 */
	private stickyFocusInput(deadline: number, gen: number): void {
		const settleMs = 150;
		let heldSince = 0;

		const tick = (): void => {
			if (gen !== this.gen) return; // superseded by a newer ⌘L
			const input = this.visibleInput();
			if (input) {
				if (document.activeElement === input) {
					if (!heldSince) heldSince = Date.now();
					if (Date.now() - heldSince >= settleMs) return; // focus held
				} else {
					heldSince = 0;
					input.focus({ preventScroll: true });
				}
			}
			if (Date.now() < deadline) window.setTimeout(tick, 30);
		};

		tick();
	}

	private getClaudianLeaf(): WorkspaceLeaf | null {
		return this.app.workspace.getLeavesOfType(CLAUDIAN_VIEW)[0] ?? null;
	}

	/**
	 * The note leaf we're protecting. Prefer the most recently active leaf (still the
	 * note while Claudian sits in a sidebar); fall back to any open Markdown leaf.
	 */
	private getNoteLeaf(): WorkspaceLeaf | null {
		const recent = this.app.workspace.getMostRecentLeaf();
		if (recent && this.cmOf(recent)) return recent;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (this.cmOf(leaf)) return leaf;
		}
		return null;
	}

	/** The CM6 view of {@link getNoteLeaf}. */
	private getNoteCM(): EditorView | null {
		return this.cmOf(this.getNoteLeaf());
	}

	private cmOf(leaf: WorkspaceLeaf | null): EditorView | null {
		if (!leaf) return null;
		return (
			(leaf.view as unknown as { editor?: { cm?: EditorView } }).editor?.cm ??
			null
		);
	}

	/** The visible composer textarea — Claudian keeps hidden ones for background tabs. */
	private visibleInput(): HTMLTextAreaElement | null {
		const container = this.getClaudianLeaf()?.view.containerEl;
		if (!container) return null;
		const inputs = Array.from(
			container.querySelectorAll<HTMLTextAreaElement>(CLAUDIAN_INPUT),
		);
		return inputs.find((el) => el.offsetParent !== null) ?? inputs[0] ?? null;
	}

	/** A sidebar leaf is showing only when its container is laid out (not a hidden tab / collapsed dock). */
	private isLeafVisible(leaf: WorkspaceLeaf): boolean {
		return leaf.view.containerEl.offsetParent !== null;
	}

	private sidebarOf(leaf: WorkspaceLeaf): "right" | "left" | null {
		const root = leaf.getRoot();
		if (root === this.app.workspace.rightSplit) return "right";
		if (root === this.app.workspace.leftSplit) return "left";
		return null;
	}

	/** Guarantee the dock that hosts Claudian stays open — expand() is a no-op if already open. */
	private ensureSideOpen(side: "right" | "left" | null): void {
		if (side === "right") this.app.workspace.rightSplit.expand();
		else if (side === "left") this.app.workspace.leftSplit.expand();
	}
}
