import { Plugin, WorkspaceLeaf } from "obsidian";
import { EditorView } from "@codemirror/view";

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

/** `app.commands` is a stable but undocumented Obsidian API (not in the public typings). */
interface AppWithCommands {
	commands: { executeCommandById(id: string): boolean };
}

export default class ClaudianEnhancedPlugin extends Plugin {
	/** Bumped on every toggle; a stale focus loop compares against it and bails. */
	private gen = 0;

	async onload(): Promise<void> {
		this.addCommand({
			id: "toggle-claudian",
			// "Claudian" is a proper noun (the plugin's name), so it stays capitalized.
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			name: "Toggle Claudian chat",
			callback: () => this.toggle(),
		});
		// Escape cancels a live 划词 (see onEscapeCapture). Listened for on window in
		// the capture phase so it runs regardless of where focus currently sits.
		this.registerDomEvent(window, "keydown", this.onEscapeCapture, {
			capture: true,
		});
	}

	private onEscapeCapture = (e: KeyboardEvent): void => {
		if (e.key !== "Escape" || e.isComposing) return;
		const cm = this.cmOf(this.getNoteLeaf());
		if (!cm) return;
		const main = cm.state.selection.main;
		if (main.empty) return;
		// Collapse the editor's own selection (clears the native highlight)...
		cm.dispatch({ selection: { anchor: main.head }, scrollIntoView: false });
		// ...and pull focus back into the editor. Claudian's selection poll keeps its
		// carried selection alive as long as focus stays inside its sidebar (that's by
		// design — you're using the composer). Moving focus out lets its next poll see
		// "focus outside + no selection" and drop the context, its chip, and the
		// .claudian-selection-highlight. ESC pressed in the editor already satisfies
		// this; pressed in the composer, this is what releases it.
		cm.focus();
	};

	private toggle(): void {
		// Each press starts a new generation; an in-flight focus loop from an earlier
		// press sees the bump and stops, so rapid ⌘L can't stack loops.
		const gen = ++this.gen;
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
	}

	private openClaudian(gen: number): void {
		// Capture the note before opening Claudian steals "active leaf" status.
		const noteLeaf = this.getNoteLeaf();
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
		if (noteLeaf) this.keepNoteActive(noteLeaf, Date.now() + 900, gen);
		this.stickyFocusInput(Date.now() + 1500, gen);
	}

	/**
	 * Keep the note as the active leaf (without stealing DOM focus) for a short
	 * window after opening Claudian.
	 *
	 * Claudian's selection poll only *stores* a selection while the note is the
	 * active MarkdownView. On a cold start its poll starts only once its view
	 * mounts — and the mount repeatedly grabs "active leaf" while we pull focus
	 * into the composer — so a one-shot restore loses the race and the very first
	 * 划词 is never captured. Re-asserting through the mount gives the poll a tick
	 * with the note active + selection intact; once stored, focus sitting in the
	 * sidebar keeps it alive (that's Claudian's isFocusWithinChatSidebar guard).
	 * Focus (DOM) and active-leaf are independent, so this never fights
	 * stickyFocusInput.
	 */
	private keepNoteActive(
		noteLeaf: WorkspaceLeaf,
		deadline: number,
		gen: number,
	): void {
		const tick = (): void => {
			if (gen !== this.gen) return; // superseded by a newer ⌘L
			const active = (
				this.app.workspace as unknown as { activeLeaf: WorkspaceLeaf | null }
			).activeLeaf;
			if (active !== noteLeaf) {
				this.app.workspace.setActiveLeaf(noteLeaf, { focus: false });
			}
			if (Date.now() < deadline) window.setTimeout(tick, 90);
		};
		tick();
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
	 * active means the poll keeps reading the selection (which survives the blur in
	 * EditorState), so the carried context survives the toggle.
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
