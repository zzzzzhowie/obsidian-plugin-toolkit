import { Plugin, WorkspaceLeaf } from "obsidian";

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
	}

	private toggle(): void {
		// Each press starts a new generation; an in-flight focus loop from an
		// earlier press sees the bump and stops, so rapid ⌘L can't stack loops.
		const gen = ++this.gen;
		const leaf = this.getClaudianLeaf();
		if (leaf && this.isLeafVisible(leaf)) {
			// Claudian is showing → switch its sidebar back to the default (outline)
			// tab. We never detach: Claudian's tab stays alive so the next ⌘L flips
			// straight back to it and the dock never closes.
			this.revealSidebarDefault(leaf);
		} else {
			this.openClaudian(gen);
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
		const restore = this.findSidebarDefault(side);
		if (restore) {
			void this.app.workspace.revealLeaf(restore);
			return;
		}
		// The outline tab was closed, so there's nothing to flip back to — ⌘L would
		// otherwise be a dead key stuck on Claudian. Let the core Outline command
		// (re)create its leaf, then reveal it so the toggle stays symmetric.
		(this.app as unknown as AppWithCommands).commands.executeCommandById(
			OUTLINE_OPEN_COMMAND,
		);
		const created = this.findSidebarDefault(side);
		if (created) void this.app.workspace.revealLeaf(created);
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
