import { Plugin, WorkspaceLeaf } from "obsidian";
import { EditorView } from "@codemirror/view";

/** The chat leaf registered by the Claudian plugin (id: realclaudian). */
const CLAUDIAN_VIEW = "claudian-view";
/** The main chat composer inside that leaf (placeholder "How can i help you today?"). */
const CLAUDIAN_INPUT = "textarea.claudian-input";
/** The scrollable message list (overflow-y:auto); one per conversation tab. */
const CLAUDIAN_MESSAGES = ".claudian-messages";
/** A user's own message bubble — appears the moment a prompt is submitted. */
const CLAUDIAN_USER_MESSAGE = ".claudian-message-user";
/**
 * How far above the bottom still counts as "following the stream" (px). Claudian's own
 * autoscroll uses 20px, which is tighter than the height a single render step adds — we
 * measure *after* the mutation, so that would read as detached almost every time. This
 * is loose enough to survive a thinking block appearing, tight enough that scrolling up
 * to read anything real detaches.
 */
const FOLLOW_THRESHOLD_PX = 200;
/** Row above the composer; shows "⌐ Queued: …" for a prompt submitted mid-stream. */
const CLAUDIAN_QUEUE_ROW = ".claudian-input-queue-row";
/** The summary label inside that row (Claudian rebuilds it on every queue update). */
const CLAUDIAN_QUEUE_TEXT = ".claudian-queue-indicator-text";
/**
 * Links inside a Claudian response. It renders vault links as `.internal-link` and
 * stamps its own file mentions with `.claudian-file-link`; both go through the same
 * click handler, which always opens a new tab (see interceptLinkClicks).
 */
const CLAUDIAN_LINK = ".claudian-file-link, .internal-link";
/** Claudian's own command that opens/reveals its view. */
const OPEN_COMMAND = "realclaudian:open-view";
/**
 * Claudian's own command that starts a fresh conversation *in the current tab* (no tab is
 * created or destroyed). Its createNew() resets the conversation, saves the old one to
 * history, and calls autoAttachActiveFile() — so the note we just switched to is attached
 * for us. Used to clear context on a note change; see resetSessionForNoteChange.
 */
const NEW_SESSION_COMMAND = "realclaudian:new-session";
/** View to switch to when Claudian is toggled away inside a sidebar (the sidebar's default). */
const SIDEBAR_DEFAULT_VIEW = "outline";
/** Core Outline plugin's command — used to recreate the outline leaf if its tab was closed. */
const OUTLINE_OPEN_COMMAND = "outline:open";

/** `app.commands` is a stable but undocumented Obsidian API (not in the public typings). */
interface AppWithCommands {
	commands: { executeCommandById(id: string): boolean };
}

/**
 * The bits of Claudian's active *conversation tab* state we read before clearing context.
 * `isStreaming` guards a reply in flight; `messages` tells us whether there's anything worth
 * clearing. Optional all the way down, same contract as {@link ClaudianFileContext}.
 */
interface ClaudianTabState {
	isStreaming?: boolean;
	messages?: unknown[];
}

/**
 * Claudian's per-tab file-context manager (read/write reach into its internals). Property
 * names survive minification, so we address them directly; every hop is optional so a
 * future Claudian build that renames these degrades to a no-op instead of throwing.
 *
 * `setCurrentNote(path)` is the seam we drive: it sets the path, attaches the file, and
 * re-renders the current-note chip — and, unlike `handleFileOpen`, it is NOT gated by
 * `isSessionStarted`, so it updates the chip mid-conversation (where file-open is frozen).
 * `state.currentNoteSent` is Claudian's "already sent the current note this turn" flag; the
 * submit path only embeds the note while it's false, so we clear it after a switch to let
 * the newly-attached note ride the next prompt once (submit re-sets it afterward).
 */
interface ClaudianFileContext {
	currentNotePath?: string | null;
	setCurrentNote?: (path: string) => void;
	state?: {
		detachFile?: (path: string) => void;
		currentNoteSent?: boolean;
	};
}

export default class ClaudianEnhancedPlugin extends Plugin {
	/** Bumped on every toggle; a stale focus loop compares against it and bails. */
	private gen = 0;
	/** Last note path we re-asserted for the chip; guards the sync loop from re-firing. */
	private lastSyncedPath: string | null = null;
	/**
	 * The note the current conversation belongs to — the "last opened file" that decides
	 * whether context should be cleared. Deliberately separate from `lastSyncedPath`, which
	 * is cleared whenever Claudian is hidden: keying off that would wipe the conversation
	 * just for toggling the panel with ⌘L. Only a real note change moves this.
	 */
	private lastOpenedPath: string | null = null;
	/** Debounce handle for the active-note → chip sync. */
	private syncTimer: number | null = null;
	/** Watches for submitted messages to scroll them into view; see setupSubmitScroll. */
	private submitScrollObserver: MutationObserver | null = null;
	/** The view container the observer is bound to; guards against re-binding. */
	private observedContainer: HTMLElement | null = null;
	/** Last queued-message summary we scrolled for; see handleQueueChange. */
	private lastQueueText = "";

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
		// Keep Claudian's "current note" chip fresh without a manual ⌘L. Claudian only
		// refreshes that chip off the `file-open` event; when the active leaf has been
		// sitting on Claudian's sidebar, Obsidian's active *file* stays frozen and no
		// file-open fires, so switching notes leaves the chip stale. Re-asserting the
		// note as the active leaf reproduces the exact transition ⌘L relies on and
		// re-fires file-open. See syncCurrentNoteChip.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.scheduleChipSync();
				// A deferred/collapsed Claudian leaf can swap in a new view (new
				// containerEl) when revealed — re-bind the submit-scroll observer to it.
				this.ensureSubmitScrollObserver();
			}),
		);
		// Keep the conversation pinned to the bottom. Claudian's own autoscroll is too
		// brittle to rely on: it only forces the list down on a new conversation, its
		// submit path doesn't scroll at all, and its streaming follow re-arms only if you
		// are within 20px of the bottom 150ms after a scroll event — which the reply's
		// own first block reliably breaks, stranding the rest of the turn off-screen. We
		// watch the view for submits, replies rendering, and queued prompts instead.
		// See setupSubmitScroll / ensureSubmitScrollObserver.
		this.setupSubmitScroll(Date.now() + 8000);
		// MutationObserver isn't auto-cleaned by Obsidian's register* helpers.
		this.register(() => this.submitScrollObserver?.disconnect());
		// Reuse a tab instead of stacking a new one per clicked link. See
		// interceptLinkClicks.
		this.interceptLinkClicks();
		// Cold-start fix. Claudian restores its last conversation together with *that
		// conversation's* saved note. When that was a started/interrupted session,
		// Claudian deliberately freezes the note (handleFileOpen's isSessionStarted
		// gate), so it stays stuck on the old note even though a different note is open
		// now — no file-open can dislodge it, and the active-leaf sync above is a no-op
		// (the open note is already active, so no file-open fires). When the restored
		// note genuinely mismatches the open note, start a fresh session: its createNew
		// re-attaches the note we actually have open and the chip finally matches. We
		// fire only on a real mismatch so a restart never discards a conversation whose
		// note already matches. See reconcileChipOnStartup.
		this.app.workspace.onLayoutReady(() =>
			this.reconcileChipOnStartup(Date.now() + 8000),
		);
	}

	onunload(): void {
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
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
		// Re-evaluate the current-note chip on every show. Clearing lastSyncedPath forces the
		// sync past its debounce guard even when the open note hasn't changed, so a note
		// frozen by a started/restored session snaps to the tab that's actually open. The
		// sync settles after keepNoteActive stops re-asserting the note (see syncCurrentNoteChip).
		this.lastSyncedPath = null;
		this.scheduleChipSync();
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

	/**
	 * Debounce active-leaf churn (reveals, focus hops, our own re-assert) into a single
	 * chip sync so a burst of events collapses to one setActiveLeaf.
	 */
	private scheduleChipSync(): void {
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = null;
			this.syncCurrentNoteChip();
		}, 150);
	}

	/**
	 * Point Claudian's current-note chip at the note that's actually open. Only runs while
	 * Claudian is visible and the open note changed from the one we last synced —
	 * `lastSyncedPath` just skips redundant work on active-leaf churn (the ⌘L reveal path
	 * clears it to force a re-check). Unlike the old file-open re-fire, this writes the note
	 * through `setCurrentNote` (see attachNoteToClaudian), which is ungated — so it also
	 * refreshes the chip during a started conversation, where Claudian freezes file-open.
	 */
	private syncCurrentNoteChip(): void {
		const claudianLeaf = this.getClaudianLeaf();
		if (!claudianLeaf || !this.isLeafVisible(claudianLeaf)) {
			// Hidden/absent → the ⌘L reveal path refreshes on next open; forget state so
			// the next real switch is treated as a change.
			this.lastSyncedPath = null;
			return;
		}
		const path = this.activeNotePath();
		if (!path || path === this.lastSyncedPath) return;
		this.lastSyncedPath = path;
		this.handleNoteChange(path);
	}

	/**
	 * React to the open note changing. Switching notes means the conversation is about
	 * something else now, so clear the context: start a fresh session in the current tab
	 * (the old one is saved to Claudian's history). When that's declined — a reply is
	 * streaming, or the conversation is empty so there's nothing to clear — fall back to
	 * re-pointing the attached note in place, which is the old behavior.
	 */
	private handleNoteChange(path: string): void {
		const previous = this.lastOpenedPath;
		this.lastOpenedPath = path;
		// First note we've seen (fresh load, or Claudian just appeared): there is no
		// previous conversation to clear, so only attach.
		if (previous !== null && previous !== path && this.resetSessionForNoteChange()) {
			// The fresh session attaches a note itself, but createNew() is async and picks
			// `getActiveFile()` — normally this note, though that isn't guaranteed to agree
			// with the leaf we measured. Re-assert once it settles; attachNoteToClaudian is
			// idempotent and null-safe, so this is a no-op whenever it already matches.
			window.setTimeout(() => this.attachNoteToClaudian(path), 300);
			return;
		}
		this.attachNoteToClaudian(path);
	}

	/**
	 * Clear the conversation context by starting a fresh session in the current tab.
	 * Returns whether it actually happened, so the caller can fall back.
	 *
	 * Declines while a reply is streaming (never cut off a running response) and when the
	 * conversation has no messages (nothing to clear — resetting would only churn the tab
	 * and drop an attached note the user just set up).
	 */
	private resetSessionForNoteChange(): boolean {
		const state = this.getActiveTabState();
		if (!state || state.isStreaming) return false;
		if (!state.messages?.length) return false;
		return (this.app as unknown as AppWithCommands).commands.executeCommandById(
			NEW_SESSION_COMMAND,
		);
	}

	/** Claudian's active conversation-tab state, or null if absent / internals renamed. */
	private getActiveTabState(): ClaudianTabState | null {
		const view = this.getClaudianLeaf()?.view as unknown as {
			getTabManager?: () => {
				getActiveTab?: () => { state?: ClaudianTabState } | null;
			} | null;
		};
		return view?.getTabManager?.()?.getActiveTab?.()?.state ?? null;
	}

	/**
	 * Switch Claudian's attached current note to `path` in place — keeps the running
	 * conversation, only re-points what the next prompt carries. Idempotent: bails when
	 * Claudian is already on this note (so a fresh session Claudian synced itself, and our
	 * own re-runs, cost nothing and never needlessly re-send the note). Detaching the
	 * previously auto-attached note mirrors Claudian's own detach/attach idiom
	 * (handleFileRenamed) so switch pills don't accumulate; files the user attached
	 * mid-conversation are left alone. Clearing currentNoteSent lets the new note ride the
	 * next prompt exactly once. All reaches are optional — missing internals → no-op.
	 */
	private attachNoteToClaudian(path: string): void {
		const fcm = this.getFileContextManager();
		if (!fcm || typeof fcm.setCurrentNote !== "function") return;
		const current = fcm.currentNotePath ?? null;
		if (current === path) return;
		if (current) fcm.state?.detachFile?.(current);
		fcm.setCurrentNote(path);
		if (fcm.state) fcm.state.currentNoteSent = false;
	}

	/**
	 * After a cold start, re-point Claudian's restored note at the note we actually have open.
	 * Claudian restores its last conversation together with *that conversation's* saved note
	 * and, when it was a started session, freezes it — so it stays stuck on the old note even
	 * though a different note is open now. attachNoteToClaudian re-points it in place (keeping
	 * the restored conversation; no fresh session, nothing discarded), and no-ops when the
	 * restored note already matches.
	 *
	 * We poll until Claudian's view has mounted (composer present) *and* its restore has
	 * populated a note — the restore is async and lands around mount, so reading too early
	 * would see no note and act on the wrong (empty) state. If no note ever gets attached
	 * within the window (a conversation that genuinely carries none), we give up.
	 */
	private reconcileChipOnStartup(deadline: number): void {
		const tick = (): void => {
			if (this.claudianMounted()) {
				const attached = this.attachedNotePath();
				if (attached !== null) {
					const notePath = this.activeNotePath();
					if (notePath) {
						// Seed the note-change tracker: the restored conversation belongs to
						// whatever is open now, so a *later* switch is the first thing that
						// clears context — a cold start never wipes the restored session.
						this.lastOpenedPath = notePath;
						this.attachNoteToClaudian(notePath);
					}
					return; // restore settled — done
				}
			}
			if (Date.now() < deadline) window.setTimeout(tick, 150);
		};
		tick();
	}

	/**
	 * Claudian's per-tab file-context manager, or null when Claudian is absent or a future
	 * build has renamed the path we reach through. Every hop is optional so this degrades to
	 * null rather than throwing. Shared by the read-only chip check and the in-place switch.
	 */
	private getFileContextManager(): ClaudianFileContext | null {
		const view = this.getClaudianLeaf()?.view as unknown as {
			getTabManager?: () => {
				getActiveTab?: () => { ui?: { fileContextManager?: ClaudianFileContext } } | null;
			} | null;
		};
		return view?.getTabManager?.()?.getActiveTab?.()?.ui?.fileContextManager ?? null;
	}

	/**
	 * The note Claudian currently has attached (vault-relative, forward slashes — same
	 * shape as TFile.path, so it compares directly), or null when none is attached or the
	 * internal shape has drifted.
	 */
	private attachedNotePath(): string | null {
		return this.getFileContextManager()?.currentNotePath ?? null;
	}

	/** The vault path of the note we're protecting, or null. */
	private activeNotePath(): string | null {
		const noteLeaf = this.getNoteLeaf();
		return noteLeaf
			? ((noteLeaf.view as unknown as { file?: { path?: string } }).file?.path ??
					null)
			: null;
	}

	/** Claudian's view has built its composer → its tab/context manager exists. */
	private claudianMounted(): boolean {
		const container = this.getClaudianLeaf()?.view.containerEl;
		return !!container?.querySelector(CLAUDIAN_INPUT);
	}

	/** Wait out the async view mount, then bind the submit-scroll observer. */
	private setupSubmitScroll(deadline: number): void {
		const tick = (): void => {
			if (this.claudianMounted()) {
				this.ensureSubmitScrollObserver();
				return;
			}
			if (Date.now() < deadline) window.setTimeout(tick, 150);
		};
		tick();
	}

	/**
	 * Bind (once per view container) a MutationObserver that keeps the conversation
	 * pinned to the bottom. Watching the view's containerEl with subtree covers every
	 * conversation tab without re-binding on internal tab switches.
	 *
	 * One batch of mutations can carry all three signals, so each is collected and then
	 * acted on in priority order rather than returning from the loop:
	 *
	 *   submit  — a `.claudian-message-user` bubble appeared: an explicit "show me my
	 *             message", so it always wins and always scrolls.
	 *   stream  — anything else changed inside a message list: the reply rendering. Only
	 *             follows while the reader is still near the bottom (see followToBottom).
	 *   queue   — the queue row changed: a prompt parked mid-stream, which adds no bubble
	 *             at all (see handleQueueChange).
	 */
	private ensureSubmitScrollObserver(): void {
		const container = this.getClaudianLeaf()?.view.containerEl ?? null;
		if (!container || container === this.observedContainer) return;
		this.submitScrollObserver?.disconnect();
		this.observedContainer = container;
		this.submitScrollObserver = new MutationObserver((records) => {
			let submitted: HTMLElement | null = null;
			let streamed: HTMLElement | null = null;
			let queued = false;
			for (const record of records) {
				submitted ??= this.addedUserMessage(record);
				streamed ??= this.messagesListOf(record.target);
				queued ||= this.isInQueueRow(record.target);
			}
			// Both scroll "the list this landed in" — there's one per conversation tab.
			if (submitted) this.scrollToBottom(submitted.closest(CLAUDIAN_MESSAGES));
			else if (streamed) this.followToBottom(streamed);
			if (queued) this.handleQueueChange();
		});
		this.submitScrollObserver.observe(container, {
			childList: true,
			subtree: true,
			// Discarding/dispatching a queued message only toggles the row's visibility
			// class (Claudian leaves the stale summary in the DOM), so childList alone
			// would never tell us the queue emptied. See handleQueueChange.
			attributes: true,
			attributeFilter: ["class"],
		});
	}

	/** The user bubble this mutation added, if any (it can arrive nested in a re-render). */
	private addedUserMessage(record: MutationRecord): HTMLElement | null {
		for (const node of Array.from(record.addedNodes)) {
			if (node.nodeType !== Node.ELEMENT_NODE) continue;
			const el = node as HTMLElement;
			const userMsg = el.matches(CLAUDIAN_USER_MESSAGE)
				? el
				: el.querySelector<HTMLElement>(CLAUDIAN_USER_MESSAGE);
			if (userMsg) return userMsg;
		}
		return null;
	}

	/** The message list a mutation happened in, or null when it happened elsewhere. */
	private messagesListOf(target: Node): HTMLElement | null {
		const el = target instanceof HTMLElement ? target : target.parentElement;
		return el?.closest<HTMLElement>(CLAUDIAN_MESSAGES) ?? null;
	}

	/**
	 * Follow a reply as it renders. Claudian's own autoscroll gives up here: it only
	 * re-arms `autoScrollEnabled` 150ms after a scroll event *and* only if you're still
	 * within 20px of the bottom — the thinking block appearing inside that window pushes
	 * you past 20px, the re-check fails, and since growing content fires no scroll event
	 * nothing ever re-arms it. The rest of the turn then renders off-screen.
	 *
	 * Unlike a submit (an explicit "take me to my message"), this is us following someone
	 * else's output, so it defers to the reader: scrolled up beyond FOLLOW_THRESHOLD_PX
	 * means they detached on purpose and we leave them there.
	 *
	 * Pinned synchronously: measuring the distance already forced layout, so the nodes
	 * this batch added are included and there is nothing for a rAF to wait for — it would
	 * only add a frame of lag, plus a starved frame would strand the pin.
	 */
	private followToBottom(scroller: HTMLElement): void {
		const distance =
			scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		if (distance > FOLLOW_THRESHOLD_PX) return;
		scroller.scrollTop = scroller.scrollHeight;
	}

	/** Did this mutation land inside the queue row (childList targets the row itself)? */
	private isInQueueRow(target: Node): boolean {
		return target instanceof HTMLElement && !!target.closest(CLAUDIAN_QUEUE_ROW);
	}

	/**
	 * Treat "prompt got queued" as a submit and pin the list to the bottom.
	 *
	 * Sending while Claudian is streaming doesn't append a bubble — the prompt is parked
	 * and only the "⌐ Queued: …" row is repainted — so the bubble branch above never
	 * fires and the list stays wherever you had scrolled to, which is exactly the
	 * off-screen case the observer exists to prevent.
	 *
	 * Keyed on the row's summary text because Claudian rebuilds that row on every queue
	 * state change (steer-button state, stream end, …); only a *changed*, currently
	 * visible summary scrolls, so the repaints don't keep yanking you down. A hidden row
	 * reads as empty, which resets the key — re-queueing the same text still counts as a
	 * new submit.
	 */
	private handleQueueChange(): void {
		const row = this.visibleEl<HTMLElement>(CLAUDIAN_QUEUE_ROW);
		const text =
			row && row.offsetParent !== null
				? (row.querySelector(CLAUDIAN_QUEUE_TEXT)?.textContent?.trim() ?? "")
				: "";
		if (text === this.lastQueueText) return;
		this.lastQueueText = text;
		// The queued prompt belongs to the tab on screen, and its composer can be hosted
		// outside that tab's DOM (the view re-parents it), so pin the visible list.
		if (text) this.scrollToBottom(this.visibleEl<HTMLElement>(CLAUDIAN_MESSAGES));
	}

	/**
	 * Pin a message list to the bottom. rAF lets the just-added node lay out first; the
	 * delayed re-assert catches late height (images, rendered code) so we don't stop a
	 * few pixels short. Programmatic scroll fires a `scroll` event, which is what nudges
	 * Claudian to re-enable its streaming autoscroll.
	 */
	private scrollToBottom(scroller: HTMLElement | null): void {
		if (!scroller) return;
		const run = (): void => {
			scroller.scrollTop = scroller.scrollHeight;
		};
		requestAnimationFrame(run);
		window.setTimeout(run, 150);
	}

	/**
	 * Open links from a Claudian response in an existing tab instead of a new one.
	 *
	 * Claudian's own handler is hardcoded to `openLinkText(href, "", "tab")`, so every
	 * click stacks another tab — click the same note three times and you get three
	 * identical tabs. It can't simply pass `false`: Claudian lives in a sidebar, so the
	 * active leaf is its own, and Obsidian would load the note *into the chat panel*.
	 * That's what we fix here — pick a main-area leaf ourselves (the one already showing
	 * the file, else the most recent one), make it active, and only then let Obsidian
	 * resolve the link with `newLeaf: false`, which reuses that leaf and still honors a
	 * `#heading` subpath.
	 *
	 * Capture phase + stopImmediatePropagation so Claudian's own bubble-phase handler
	 * never runs. Cmd/Ctrl-click and middle-click keep their standard "new tab" meaning.
	 */
	private interceptLinkClicks(): void {
		this.registerDomEvent(
			document,
			"click",
			(event: MouseEvent) => {
				const container = this.getClaudianLeaf()?.view.containerEl;
				if (!container) return;
				const target = event.target as HTMLElement | null;
				const link = target?.closest<HTMLElement>(CLAUDIAN_LINK);
				// Only links rendered inside the chat panel; notes keep native behavior.
				if (!link || !container.contains(link)) return;
				const href = link.dataset.href ?? link.getAttribute("href");
				if (!href) return;

				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();

				// Honor the platform convention for an explicit "open elsewhere" click.
				if (event.metaKey || event.ctrlKey || event.button === 1) {
					void this.app.workspace.openLinkText(href, "", "tab");
					return;
				}

				const reuse = this.leafForLink(href);
				if (!reuse) {
					// Nothing in the main area to reuse (e.g. only the sidebar is open).
					void this.app.workspace.openLinkText(href, "", "tab");
					return;
				}
				// Hand "active" to the main-area leaf so newLeaf:false lands there and not
				// in Claudian's sidebar, then let Obsidian do the resolving + anchor jump.
				this.app.workspace.setActiveLeaf(reuse, { focus: true });
				void this.app.workspace.openLinkText(href, "", false);
			},
			{ capture: true },
		);
	}

	/**
	 * The main-area leaf a clicked link should land in: prefer one already showing that
	 * file (so clicking it again just focuses it), otherwise the most recent main-area
	 * markdown leaf. Sidebar leaves are never eligible — loading a note into one would
	 * replace Claudian itself.
	 */
	private leafForLink(href: string): WorkspaceLeaf | null {
		const linkpath = href.split("#")[0] ?? "";
		const file = linkpath
			? this.app.metadataCache.getFirstLinkpathDest(linkpath, "")
			: null;

		const mainLeaves = this.app.workspace
			.getLeavesOfType("markdown")
			.filter((leaf) => this.sidebarOf(leaf) === null);

		if (file) {
			const open = mainLeaves.find(
				(leaf) =>
					(leaf.view as unknown as { file?: { path?: string } }).file?.path ===
					file.path,
			);
			if (open) return open;
		}

		const recent = this.app.workspace.getMostRecentLeaf();
		if (recent && this.sidebarOf(recent) === null) return recent;
		return mainLeaves[0] ?? null;
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
		return this.visibleEl<HTMLTextAreaElement>(CLAUDIAN_INPUT);
	}

	/**
	 * The laid-out instance of `selector` inside Claudian's view. Claudian keeps one copy
	 * per conversation tab and hides the inactive ones, so we pick the element that is
	 * actually rendered; the first match is a last resort when nothing is laid out (a
	 * collapsed dock), which callers that care about visibility re-check themselves.
	 */
	private visibleEl<T extends HTMLElement>(selector: string): T | null {
		const container = this.getClaudianLeaf()?.view.containerEl;
		if (!container) return null;
		const els = Array.from(container.querySelectorAll<T>(selector));
		return els.find((el) => el.offsetParent !== null) ?? els[0] ?? null;
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
