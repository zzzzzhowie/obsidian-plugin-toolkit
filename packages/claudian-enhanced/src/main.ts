import { FileSystemAdapter, MarkdownView, Platform, Plugin, Scope, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { EditorView } from "@codemirror/view";

/** The chat leaf registered by the Claudian plugin (id: realclaudian). */
const CLAUDIAN_VIEW = "claudian-view";
/**
 * The main chat composer inside that leaf, one per conversation tab. Since Claudian 2.3 it is
 * a CodeMirror host `<div>`, not a `<textarea>`: focusing the host hands focus on to the
 * editor's own `.cm-content` inside it, so "focused" means focus is *within* this element.
 */
const CLAUDIAN_INPUT = ".claudian-input";
/** The scrollable message list (overflow-y:auto); one per conversation tab. */
const CLAUDIAN_MESSAGES = ".claudian-messages";
/**
 * A user's own message — appears the moment a prompt is submitted. Since Claudian 2.3 this is
 * a wrapper: the bubble (its background) is the `.claudian-message-content` inside it, and the
 * action toolbar sits below the bubble in normal flow.
 */
const CLAUDIAN_USER_MESSAGE = ".claudian-message-user";
/** The rendered prompt text inside the bubble — what a fold measures and clips. */
const CLAUDIAN_PROMPT_TEXT = ".claudian-message-content > .claudian-text-block";
/**
 * Marks the prompt currently pinned to the top of the list. Only while it's actually
 * pinned may the header styling paint outside the bubble — see markPinnedPrompt.
 */
const PINNED_CLS = "claudian-enhanced-pinned";
/**
 * Marks a prompt that is stuck to the top but sits *behind* a later one. Every prompt
 * sticks at the same offset, so without this they pile up — and because they're
 * right-aligned and only as wide as their text, a shorter newer prompt leaves the left
 * end of an older one showing, which reads as two titles overlapping.
 */
const BURIED_CLS = "claudian-enhanced-buried";
/** Marks a prompt long enough to fold; it carries the fold toggle. See foldLongPrompts. */
const FOLDABLE_CLS = "claudian-enhanced-foldable";
/** Marks a foldable prompt that is currently collapsed. */
const FOLDED_CLS = "claudian-enhanced-folded";
/** The expand/collapse button in a long prompt's bubble, at its bottom-right corner. */
const FOLD_TOGGLE_CLS = "claudian-enhanced-fold-toggle";
/** Lines a folded prompt keeps — styles.css says `3lh`; keep the two together. */
const FOLD_LINES = 3;
/**
 * Only fold when more than this many lines would disappear. Folding a prompt that is one
 * line over the limit hides a single line behind a button, which costs more than it saves.
 */
const FOLD_SLACK_LINES = 1;
/**
 * How far above the bottom still counts as "following the stream" (px). Claudian's own
 * autoscroll uses 20px, which is tighter than the height a single render step adds — we
 * measure *after* the mutation, so that would read as detached almost every time. This
 * is loose enough to survive a thinking block appearing, tight enough that scrolling up
 * to read anything real detaches.
 */
const FOLLOW_THRESHOLD_PX = 200;
/**
 * How close to the bottom the reader has to come back before streaming starts following
 * again (px). Deliberately much tighter than FOLLOW_THRESHOLD_PX: that one only decides
 * whether an *undisturbed* view still counts as pinned, whereas re-following after someone
 * deliberately scrolled up should need them to actually return to the end.
 */
const REATTACH_PX = 24;
/** The jump-to-latest button, over the bottom of a conversation; see syncJumpButton. */
const JUMP_BTN_CLS = "claudian-enhanced-jump-latest";
/** How far from the end the conversation has to be before that button shows (px). */
const JUMP_SHOW_PX = 160;
/**
 * Strip on top of the composer showing a prompt submitted mid-stream (queued, or a pending
 * steer). Claudian shows/hides it by toggling `claudian-hidden` / `claudian-visible-flex`.
 */
const CLAUDIAN_QUEUE_ROW = ".claudian-input-queue-strip";
/** The summary label inside that strip (Claudian rebuilds it on every queue update). */
const CLAUDIAN_QUEUE_TEXT = ".claudian-queue-indicator-text";
/**
 * Links inside a Claudian response. It renders vault links as `.internal-link` and
 * stamps its own file mentions with `.claudian-file-link`; both go through the same
 * click handler, which reveals a leaf already showing the file but otherwise opens a
 * new tab (see interceptLinkClicks).
 */
const CLAUDIAN_LINK = ".claudian-file-link, .internal-link";
/**
 * Claudian's own per-prompt toolbar (copy / rewind / fork / timestamp). It is created *inside*
 * the user message, so a click there has to keep its own meaning — see
 * interceptPinnedPromptClicks.
 */
const CLAUDIAN_USER_ACTIONS = ".claudian-user-msg-actions";
/** Claudian's own command that opens/reveals its view. */
const OPEN_COMMAND = "realclaudian:open-view";
/**
 * Claudian's own "Replace current conversation" command: a fresh conversation *in the current
 * tab* (no tab is created or destroyed). The old one stays in history, and the new one starts
 * as a Linked content draft that follows the active note — so the note we just switched to is
 * linked for us. Used to clear context on a note change; see resetSessionForNoteChange.
 * Claudian disables it in its wide dual-pane layout, where this reports false.
 */
const NEW_SESSION_COMMAND = "realclaudian:new-session";
/**
 * What clear-tab's hotkey does when the pointer isn't over Claudian: a new draft (the Drafts
 * plugin, VS Code's ⌘N), or core "New tab" (⌘T) without it.
 */
const NEW_DRAFT_COMMAND = "yeyan-drafts:new-draft";
const NEW_TAB_COMMAND = "workspace:new-tab";
/**
 * How many notes keep a conversation on file. Beyond this the least recently visited note
 * is forgotten — its conversation still exists in Claudian's own history, it just stops
 * coming back on its own.
 */
const REMEMBERED_NOTES = 5;
/** The tag under a prompt naming the lines it was sent with; see tagSentSelections. */
const SELECTION_TAG_CLS = "claudian-enhanced-selection-tag";
/** Claudian's replies. Prompts are left out on purpose: they're sticky (see styles.css), so
 *  where one is drawn says where it's pinned, not where it sits in the conversation. */
const CLAUDIAN_REPLY = ".claudian-message[data-message-id]:not(.claudian-message-user)";
/**
 * On Claudian's view while it is brought out for a note: its conversation is hidden until
 * the note's own is in place and scrolled to its spot (see matchSidebarToNote).
 */
const VEILED_CLS = "claudian-enhanced-veiled";
/** Longest the view stays veiled, should the note's conversation never arrive (ms). */
const VEIL_MAX_MS = 1500;
/** On a message list while a returning conversation is rebuilt behind it; see settleScroll. */
const RESTORING_CLS = "claudian-enhanced-restoring";
/** Longest a rebuilt conversation stays hidden waiting for its height to settle (ms). */
const REVEAL_MAX_MS = 600;
/** How long the reading spot is held after a restore, against late-rendering content (ms). */
const HOLD_SPOT_MS = 1500;
/**
 * Where Claudian stores one `<conversationId>.meta.json` per conversation. The folder is a
 * hardcoded constant in its bundle (not a setting), and each meta already records the note
 * the conversation belongs to — which is what we seed our own memory from on first run, so
 * the feature works against conversations that predate it. See seedFromClaudianHistory.
 * Since 2.3 the note is `linkedContentPath` and the recency `lastActivityAt`; older metas
 * said `currentNote` / `updatedAt`, and both spellings are read.
 */
const CLAUDIAN_SESSIONS_DIR = ".claudian/sessions";
const SESSION_META_SUFFIX = ".meta.json";
/**
 * The decoration Claudian marks a carried 划词 with, inside the note's editor. Present
 * only while Claudian is painting the selection; the native editor highlight takes over
 * whenever the editor itself has focus.
 */
const SELECTION_HIGHLIGHT = ".claudian-selection-highlight";
/**
 * The CSS Custom Highlight that paints a carried 划词 made inside a table cell, where
 * Claudian's own decoration can't reach; see syncCellHighlight.
 */
const CELL_HIGHLIGHT = "claudian-enhanced-cell-selection";
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
 * clearing. Optional all the way down, same contract as {@link ClaudianLinkedContent}.
 */
interface ClaudianTabState {
	isStreaming?: boolean;
	messages?: unknown[];
}

/**
 * Claudian's per-tab Linked content controller — the note chip under the composer. Property
 * names survive minification, so we address them directly; every hop is optional so a
 * future Claudian build that renames these degrades to a no-op instead of throwing.
 *
 * A conversation's note is no longer something we can move. While the tab is an unsent draft
 * (`mode: "auto-draft"`) the chip follows the active note by itself; the first prompt locks
 * it (`"locked"`) to that note for good, and Claudian throws if anything tries to change a
 * locked one. So we only read the snapshot, plus `handleActiveFileChanged` — Claudian's own
 * file-open hook, which re-points a draft and ignores anything else — and `resetAutoDraft`,
 * which puts a draft back to following (see followNoteInDraft).
 */
interface ClaudianLinkedContent {
	getSnapshot?: () => { mode?: string; path?: string | null };
	handleActiveFileChanged?: (file: TFile | null, isActiveOwner: boolean) => void;
	resetAutoDraft?: () => void;
}

/**
 * Claudian's per-tab controller for the editor 划词. `hasSelection()` reports the carried
 * selection; `showHighlight()` paints it (and correctly paints *nothing* while the editor
 * has focus, where the native highlight is the visible one). Both only read the stored
 * selection, which is what makes re-asserting them a UI-only act. See restoreHighlight.
 */
interface ClaudianSelectionController {
	hasSelection?: () => boolean;
	showHighlight?: () => void;
	/** The selection it carries into the next prompt. Public on the controller, as is the rest. */
	storedSelection?: ClaudianStoredSelection | null;
	/**
	 * Until when its 250ms poll keeps a selection the editor no longer shows — its own grace
	 * period for the reader moving to the composer. See syncBlockSelection.
	 */
	inputHandoffGraceUntil?: number | null;
	updateIndicator?: () => void;
	onUserSelectionChanged?: (() => void) | null;
}

/**
 * A selection as Claudian carries it, in the shape it uses for reading mode: DOM ranges
 * rather than an editor range. `startLine` is optional there; given, the prompt says which
 * lines of the note the text is from.
 */
interface ClaudianStoredSelection {
	notePath: string;
	selectedText: string;
	lineCount: number;
	startLine?: number;
	domRanges?: Range[];
}

/**
 * One of Claudian's conversation tabs — the object every reach-in below starts from.
 * `conversationId` is null until the first prompt is sent (an untouched tab has no
 * conversation yet), which is exactly the case we decline to remember.
 */
interface ClaudianTab {
	id?: string;
	conversationId?: string | null;
	/**
	 * How far Claudian has got loading this tab's conversation history: "loading", then
	 * "ready" or "failed" (absent until it starts). The id and the note are in place before
	 * any of that, so this is the only way to tell a conversation that is genuinely empty
	 * from one whose messages simply haven't arrived yet. See restoredTabSettled.
	 */
	hydrationState?: string;
	state?: ClaudianTabState;
	ui?: { linkedContentController?: ClaudianLinkedContent };
	controllers?: { selectionController?: ClaudianSelectionController };
	/** The composer; Claudian gives its CodeMirror host a `value` that reads the text in it. */
	dom?: { inputEl?: { value?: unknown } };
}

/**
 * Claudian's per-view tab manager, reached through the view's own `getTabManager()`.
 *
 * `openConversation` is the seam that makes returning to a note cheap: it first switches to
 * a tab already holding that conversation, then to another Claudian view holding it, and
 * only otherwise loads it — into the *current* tab given `preferNewTab: false`, so that path
 * creates no tab: this plugin keeps Claudian to the one tab it is already on. The one
 * exception is a reply still running when the note changes, which keeps its tab in the
 * background while the note's conversation opens in another (see openBesideRunningReply);
 * that is what `preferNewTab: true`, `createTab` and `closeTab` are for.
 */
interface ClaudianTabManager {
	getActiveTab?: () => ClaudianTab | null;
	getAllTabs?: () => ClaudianTab[];
	openConversation?: (
		id: string,
		options: { preferNewTab: boolean },
	) => Promise<void>;
	/** A fresh tab: a draft without a conversation id, made the active one. */
	createTab?: (
		conversationId?: string,
		tabId?: string,
		options?: { activate?: boolean },
	) => Promise<ClaudianTab | null>;
	/** Saves the conversation and closes the tab; refuses one still streaming. */
	closeTab?: (id: string) => Promise<boolean>;
	/** Streaming, or anything else still running for it — subagents, background work. */
	isTabWorking?: (id: string) => boolean;
}

/**
 * The Claudian plugin instance, hanging off its view. Only used to ask whether a
 * conversation id is still real — its repository keeps every conversation in memory, so
 * the lookup is synchronous and covers ones never opened this session.
 */
interface ClaudianPluginApi {
	getCachedConversation?: (id: string) => unknown;
	/** Every conversation it knows, newest first; the fields we read are below. */
	getConversationList?: () => ClaudianConversationSummary[];
}

interface ClaudianConversationSummary {
	id?: string;
	linkedContentPath?: string | null;
	lastActivityAt?: number;
	createdAt?: number;
	messageCount?: number;
	isArchived?: boolean;
}

/**
 * Where the reader was in a conversation: the reply at the top of the view and how far
 * past its top they had scrolled. A reply rather than a pixel offset, because the list is
 * rebuilt on the way back and its content renders in stages — a plain scrollTop lands
 * somewhere else until everything above it has caught up. `scrollTop` is the fallback for
 * a conversation with no replies yet.
 */
interface ScrollSpot {
	atBottom: boolean;
	replyId: string | null;
	offset: number;
	scrollTop: number;
}

/**
 * A message list a conversation is being put back into. "armed": the switch has been asked
 * for and the old conversation is still on screen; "hidden": Claudian has emptied the list
 * and is rebuilding it out of sight; "holding": shown again, and kept on the reading spot
 * while late content settles.
 */
interface Restore {
	token: number;
	phase: "armed" | "hidden" | "holding";
}

/** The note lines a prompt was sent with, as Claude got them. */
interface SentSelection {
	path: string;
	start: number;
	end: number;
}

/**
 * The bits of a Claudian message we read for its selection. A prompt sent this session still
 * has what it was sent with in `executionInput.context`; one restored from history has no
 * `executionInput`, or one without it (see loadSessionSelections).
 */
interface ClaudianMessage {
	id?: string;
	/** The id Claude Code's session file knows the prompt by; a fresh prompt's `id` is Claudian's own. */
	userMessageId?: string;
	role?: string;
	executionInput?: {
		context?: {
			editorSelection?: ClaudianSelectionContext;
			selections?: { kind?: string; selection?: ClaudianSelectionContext }[];
		} | null;
	};
}

interface ClaudianSelectionContext {
	notePath?: string;
	mode?: string;
	startLine?: number;
	lineCount?: number;
}

/** A note and the conversation it was last discussed in. */
interface RememberedNote {
	path: string;
	conversationId: string;
}

/**
 * The fields we read from one of Claudian's session metas. Both spellings of the note and of
 * recency are listed — see CLAUDIAN_SESSIONS_DIR.
 */
interface SessionMeta {
	id?: string;
	linkedContentPath?: string;
	currentNote?: string;
	lastActivityAt?: number;
	updatedAt?: number;
	createdAt?: number;
}

/** Our own data.json. Most recently visited note first; at most REMEMBERED_NOTES entries. */
interface StoredData {
	recentNotes?: RememberedNote[];
	/**
	 * Notes whose conversation was cleared by hand, and when: Claudian's history only stands in
	 * for the memory with conversations newer than that (see conversationFor).
	 */
	clearedNotes?: Record<string, number>;
	/** The reading spot in each conversation (see ScrollSpot), so a restart comes back to it. */
	scrollSpots?: Record<string, ScrollSpot>;
}

/**
 * The selection a prompt sent this session went with: what it was, null for none, or
 * undefined when the message doesn't say — one restored from history, whose context comes
 * back empty however it was sent.
 */
function liveSelection(message: ClaudianMessage | undefined): SentSelection | null | undefined {
	const context = message?.executionInput?.context;
	if (!context || Object.keys(context).length === 0) return undefined;
	const selection =
		context.editorSelection ?? context.selections?.find((item) => item.kind === "editor")?.selection;
	if (selection?.mode !== "selection" || !selection.notePath || !selection.startLine) return null;
	return {
		path: selection.notePath,
		start: selection.startLine,
		end: selection.startLine + Math.max(1, selection.lineCount ?? 1) - 1,
	};
}

/** An attribute value as Claudian writes one into a prompt (`&amp;` and the like). */
function decodeAttribute(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function nodeRequire<T>(id: string): T {
	return (window as unknown as { require: (id: string) => T }).require(id);
}

/**
 * Text from a table cell, spelled one way. A line break in a cell is `<br>` in the note, and
 * that is how Claudian carries it; the cell's own editor holds a real one.
 */
function cellText(text: string): string {
	return text.replace(/<br\s*\/?>/gi, "\n").replace(/\s+/g, " ").trim();
}

/** The page's CSS Custom Highlight registry, where the browser has one. */
function highlightRegistry(): { set(name: string, highlight: object): void; delete(name: string): void } | null {
	return (CSS as unknown as { highlights?: { set(name: string, highlight: object): void; delete(name: string): void } })
		.highlights ?? null;
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
	/** The note whose conversation a veiled view is waiting for (see veilUntilSettled). */
	private veiledFor: string | null = null;
	/** The note the sidebar was last matched to (see matchSidebarToNote): once per visit. */
	private sidebarNotePath: string | null = null;
	/** Debounce handle for the active-note → chip sync. */
	private syncTimer: number | null = null;
	/** Watches for submitted messages to scroll them into view; see setupSubmitScroll. */
	private submitScrollObserver: MutationObserver | null = null;
	/** The view container the observer is bound to; guards against re-binding. */
	private observedContainer: HTMLElement | null = null;
	/** Last queued-message summary we scrolled for; see handleQueueChange. */
	private lastQueueText = "";
	/**
	 * Message lists the reader has scrolled up in. Streaming stops following these until
	 * they come back to the bottom (or submit again). Keyed by element so each conversation
	 * tab keeps its own answer, and held weakly so a closed tab's list can be collected.
	 */
	private detached = new WeakSet<HTMLElement>();
	/** Each message list's jump-to-latest button, made the first time it's needed. */
	private jumpButtons = new WeakMap<HTMLElement, HTMLElement>();
	/** Last scrollTop seen per list, to tell an upward move from a downward one. */
	private lastScrollTop = new WeakMap<HTMLElement, number>();
	/** Set while we move a list ourselves, so our own pin isn't read as the reader scrolling. */
	private selfScrolling = false;
	/** The prompt currently marked as pinned; re-marking the same one writes nothing. */
	private pinnedPrompt: HTMLElement | null = null;
	/** How far the pinned prompt is pushed up by the next one arriving; see markPinnedPrompt. */
	private pinnedPush = 0;
	/** Pending frame for the pinned-prompt pass, so scrolling schedules at most one. */
	private pinnedFrame: number | null = null;
	/** rAF handle for the next fold pass; see scheduleFold. */
	private foldFrame: number | null = null;
	/** Prompts the reader expanded by hand, which a later pass must not fold back up. */
	private expandedPrompts = new WeakSet<HTMLElement>();
	/** Re-runs the fold pass when the panel resizes, since width changes how text wraps. */
	private foldResizeObserver: ResizeObserver | null = null;
	/**
	 * Notes we can put a conversation back for, most recently visited first. Written when
	 * leaving a note, read when arriving at one; see rememberConversation / restoreConversationFor.
	 */
	private remembered: RememberedNote[] = [];
	/** The reading spot in each conversation, by conversation id; kept across restarts. */
	private spots = new Map<string, ScrollSpot>();
	/** Conversations put on their reading spot this session; see positionOnFirstShow. */
	private positioned = new Set<string>();
	/**
	 * The note lines prompts restored from history were sent with, by the session file's id
	 * for them; null for one sent with none. See tagSentSelections.
	 */
	private sentSelections = new Map<string, SentSelection | null>();
	/** Passes in a row that found a prompt not filled in yet; see tagSentSelections. */
	private tagRetries = 0;
	/** Claude Code session files already read for sentSelections, with the mtime read. */
	private readSessions = new Map<string, number>();
	private tagFrame: number | null = null;
	/** See StoredData.clearedNotes. */
	private clearedNotes: Record<string, number> = {};
	/** Message lists a conversation is being restored into; our own scrolling leaves these alone. */
	private restores = new Map<HTMLElement, Restore>();
	private restoreSeq = 0;
	/** The selection we handed Claudian for text inside a rendered block; see syncBlockSelection. */
	private blockSelection: ClaudianStoredSelection | null = null;
	private blockSelectionFrame: number | null = null;
	/** Selection controllers whose change callback holdCellSelection has wrapped. */
	private readonly heldControllers = new WeakSet<ClaudianSelectionController>();
	/** Pushed while Claudian's image preview is open, so Escape closes it; see watchImagePreview. */
	private previewScope: Scope | null = null;
	/** Whether the pointer last rested over Claudian's view; decides what clear-tab's key does. */
	private pointerOverClaudian = false;

	async onload(): Promise<void> {
		// Awaited rather than backgrounded: a restore that lost a race with this would
		// silently start a fresh session instead, which is the behavior we're replacing.
		// It reads one small file, plus Claudian's conversation metas on first run only.
		await this.loadMemory();
		this.addCommand({
			id: "toggle-claudian",
			// "Claudian" is a proper noun (the plugin's name), so it stays capitalized.
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			name: "Toggle Claudian chat",
			callback: () => this.toggle(),
		});
		// Claudian's own "New session (in current tab)" already clears the tab, but on its
		// own it half-clears: this note keeps pointing at the conversation that was just
		// thrown away (we only write the pairing down on the way out, and a tab that has
		// never been prompted has no id to write), so leaving and coming back would restore
		// exactly what the user cleared. Drive its command and drop the note in one act, so
		// one key means the note genuinely starts over.
		//
		// One key, two meanings, picked by where the pointer is: over Claudian it clears the
		// tab, anywhere else it opens a new draft (Drafts), or a new tab like ⌘T without it.
		// Both live here rather than as two bindings of ⌘N because Obsidian runs only the first
		// command bound to a key, whether or not it applies. The
		// pointer rather than focus, because clicking a sidebar never moves DOM focus off
		// <body>. Core "Create new note" (file-explorer:new-file) must stay unbound in
		// hotkeys.json so it doesn't race us for ⌘N.
		this.addCommand({
			id: "clear-tab",
			// "Claudian" is a proper noun (the plugin's name), so it stays capitalized.
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			name: "New draft, or clear Claudian's tab when the pointer is over it",
			checkCallback: (checking: boolean) => {
				if (!this.pointerOverClaudian) {
					if (!checking) {
						const { commands } = this.app as unknown as AppWithCommands;
						if (!commands.executeCommandById(NEW_DRAFT_COMMAND)) {
							commands.executeCommandById(NEW_TAB_COMMAND);
						}
					}
					return true;
				}
				const tab = this.getActiveTab();
				if (!tab || tab.state?.isStreaming) return false;
				if (checking) return true;
				this.clearCurrentTab();
				return true;
			},
		});
		this.registerDomEvent(
			document,
			"pointerover",
			(e) => {
				const target = e.target instanceof Element ? e.target : null;
				this.pointerOverClaudian = !!target?.closest(
					`.workspace-leaf-content[data-type="${CLAUDIAN_VIEW}"]`,
				);
			},
			{ capture: true },
		);
		// Escape cancels a live 划词 (see onEscapeCapture). Listened for on window in
		// the capture phase so it runs regardless of where focus currently sits.
		this.registerDomEvent(window, "keydown", this.onEscapeCapture, {
			capture: true,
		});
		// Keep Claudian's conversation in step with the open note without a manual ⌘L:
		// switching notes brings that note's conversation back or starts a fresh one. A
		// file-open alone isn't enough to notice the switch — when the active leaf has been
		// sitting on Claudian's sidebar, Obsidian's active *file* stays frozen and no
		// file-open fires — so leaf changes are watched too. See syncCurrentNoteChip.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.scheduleChipSync();
				// A deferred/collapsed Claudian leaf can swap in a new view (new
				// containerEl) when revealed — re-bind the submit-scroll observer to it.
				this.ensureSubmitScrollObserver();
			}),
		);
		// Opening a note fires this immediately and exactly once, so it needs none of the
		// debounce above — that exists to absorb active-leaf churn, and paying it here just
		// delayed every conversation restore by the full window. This is the path a normal
		// note switch takes; the debounced one stays as the fallback for switches Obsidian
		// reports as leaf changes only (Claudian's sidebar holding the active leaf, where
		// the active *file* never changes and no file-open fires).
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.syncCurrentNoteChip()),
		);
		// Notes are remembered by path, so a rename would otherwise strand a conversation
		// under a path that no longer exists — and, worse, make the next sync read the new
		// path as a note change and clear the session. Both trackers move with the file.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) =>
				this.handleNoteRenamed(file.path, oldPath),
			),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => this.forgetNote(file.path)),
		);
		// Where the reader is when Obsidian closes is what the next start comes back to.
		this.registerEvent(
			this.app.workspace.on("quit", (tasks) => {
				this.saveScrollSpot();
				tasks.add(() => this.persistMemory());
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
		// Notice when the reader scrolls away from the bottom, so streaming stops dragging
		// them back. `scroll` doesn't bubble, so this listens in the capture phase.
		this.registerDomEvent(document, "scroll", this.onScrollCapture, {
			capture: true,
		});
		// MutationObserver isn't auto-cleaned by Obsidian's register* helpers.
		this.register(() => this.submitScrollObserver?.disconnect());
		this.watchImagePreview();
		// Text selected inside a block Live Preview renders (a callout, a table), or a table's
		// cells; see syncBlockSelection. Once a frame at most — a drag fires this on every move.
		const syncSoon = (): void => {
			if (this.blockSelectionFrame !== null) return;
			this.blockSelectionFrame = requestAnimationFrame(() => {
				this.blockSelectionFrame = null;
				this.syncBlockSelection();
				this.syncCellHighlight();
			});
		};
		this.registerDomEvent(document, "selectionchange", syncSoon);
		// Cells are selected by class, not as text, so the page selection doesn't move when
		// they are: look again once the pointer or a key is let go. After a tick — four clicks
		// select the whole table in a timeout of Obsidian's own.
		this.registerDomEvent(document, "pointerup", () => window.setTimeout(syncSoon), { capture: true });
		this.registerDomEvent(document, "keyup", () => window.setTimeout(syncSoon), { capture: true });
		this.register(() => {
			if (this.blockSelectionFrame !== null) cancelAnimationFrame(this.blockSelectionFrame);
			highlightRegistry()?.delete(CELL_HIGHLIGHT);
		});
		this.register(() => this.foldResizeObserver?.disconnect());
		// Reuse a tab instead of stacking a new one per clicked link. See
		// interceptLinkClicks.
		this.interceptLinkClicks();
		// Click the pinned prompt to go back to where its turn begins. Registered after
		// the link interception above so a link inside the bubble is still claimed by it
		// first (it stops immediate propagation), and this never sees that click.
		this.interceptPinnedPromptClicks();
		// Cold-start fix. Claudian restores its last conversation together with *that
		// conversation's* note, and a sent conversation is locked to it — so it stays on the
		// old note even though a different note is open now, and the active-leaf sync above
		// is a no-op (the open note is already active, so nothing changes). When the restored
		// note genuinely mismatches the open note, treat it as arriving from that note: this
		// note gets its own conversation back, or a fresh one that links the note we
		// actually have open. We fire only on a real mismatch so a restart never discards a
		// conversation whose note already matches. See reconcileChipOnStartup.
		this.app.workspace.onLayoutReady(() => {
			this.reconcileChipOnStartup(Date.now() + 8000);
		});
	}

	onunload(): void {
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		if (this.pinnedFrame !== null) cancelAnimationFrame(this.pinnedFrame);
		this.pinnedPrompt?.removeClass(PINNED_CLS);
		this.pinnedPrompt?.style.removeProperty("transform");
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
			this.saveScrollSpot();
			this.revealSidebarDefault(leaf);
		} else {
			this.openClaudian(gen);
		}
		// Either direction re-parks focus, which is the only thing that makes Claudian
		// paint the 划词 (see restoreHighlight).
		this.restoreHighlight(Date.now() + 1500, gen);
	}

	/**
	 * Keep the 划词 painted across a ⌘L.
	 *
	 * Claudian paints `.claudian-selection-highlight` from exactly one place: a focusin
	 * handler that runs when focus enters its sidebar from outside. Flipping the sidebar
	 * tab never satisfies that — toggling *away* hands focus to the outline (or drops it
	 * to `body` when the hidden composer leaves the layout), and the editor's own
	 * highlight is invisible while the editor is unfocused. The selection itself survives
	 * (Claudian's poll still stores it, its composer still shows the "N lines selected"
	 * chip), so the state and the UI disagree until something re-focuses the sidebar.
	 * Asking Claudian to paint again is UI-only — showHighlight reads the stored
	 * selection and nothing else.
	 *
	 * Re-asserted across the reveal window because the reveal, Claudian's post-render
	 * focus grab and stickyFocusInput all land asynchronously, and each focus hop can
	 * take the decoration back off.
	 */
	private restoreHighlight(deadline: number, gen: number): void {
		const tick = (): void => {
			if (gen !== this.gen) return; // superseded by a newer ⌘L
			const controller = this.getSelectionController();
			if (controller?.hasSelection?.() && this.highlightMissing()) {
				controller.showHighlight?.();
			}
			if (Date.now() < deadline) window.setTimeout(tick, 120);
		};
		tick();
	}

	/**
	 * Whether the note is showing a carried selection with nothing painting it. Focus
	 * inside the editor doesn't count as missing: there the native highlight is the
	 * visible one and Claudian deliberately keeps its own decoration off.
	 */
	private highlightMissing(): boolean {
		const cm = this.cmOf(this.getNoteLeaf());
		if (!cm) return false;
		if (cm.dom.contains(cm.dom.ownerDocument.activeElement)) return false;
		return !cm.dom.querySelector(SELECTION_HIGHLIGHT);
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
			void this.app.workspace.revealLeaf(existing).then(() => this.returnToSpot(false));
		} else {
			(this.app as unknown as AppWithCommands).commands.executeCommandById(
				OPEN_COMMAND,
			);
		}
		if (noteLeaf) this.keepNoteActive(noteLeaf, Date.now() + 900, gen);
		this.stickyFocusInput(Date.now() + 1500, gen);
		// Re-evaluate the note on every show. Clearing lastSyncedPath forces the sync past its
		// debounce guard even when the open note hasn't changed, so a note switched while
		// Claudian was hidden is caught up now. The sync settles after keepNoteActive stops
		// re-asserting the note (see syncCurrentNoteChip).
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
	 *
	 * Held means focus is anywhere *inside* the composer host: focusing the host makes
	 * Claudian move focus on to its CodeMirror content, so the host itself is never the
	 * active element. Comparing for equality would see focus as lost on every tick and
	 * keep yanking it back for the whole window, fighting whatever is being typed.
	 */
	private stickyFocusInput(deadline: number, gen: number): void {
		const settleMs = 150;
		let heldSince = 0;

		const tick = (): void => {
			if (gen !== this.gen) return; // superseded by a newer ⌘L
			const input = this.visibleInput();
			if (input) {
				if (input.contains(document.activeElement)) {
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
	 * Bring Claudian's conversation in line with the note that's actually open. Only runs
	 * while Claudian is visible and the open note changed from the one we last synced —
	 * `lastSyncedPath` just skips redundant work on active-leaf churn (the ⌘L reveal path
	 * clears it to force a re-check).
	 */
	private syncCurrentNoteChip(): void {
		// The sidebar flips first; a flip settles asynchronously and re-runs this when it does.
		if (this.matchSidebarToNote()) {
			this.lastSyncedPath = null;
			return;
		}
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
	 * Show in the sidebar what goes with the note just switched to: Claudian when the note
	 * has a conversation, Outline when it doesn't. Reports whether it flipped the sidebar —
	 * the flip lands asynchronously, so the caller stops there and the conversation is
	 * brought in line once Claudian is on screen.
	 *
	 * A note "has a conversation" if one is on file for it, or one of Claudian's tabs is
	 * holding it — a reply still running counts. Leaving a note while Claudian shows, its
	 * conversation is written down first: hiding Claudian skips the note change that would
	 * otherwise have recorded it, and coming back has to find it.
	 *
	 * Once per note visit, so moving focus into the sidebar and back doesn't re-flip it, and
	 * ⌘L still decides for the note you're on. A collapsed sidebar stays collapsed, Claudian
	 * open in the main area is left alone, and so is mobile, where the sidebar is a drawer.
	 * Hidden behind Outline, Claudian keeps running whatever it was running.
	 */
	private matchSidebarToNote(): boolean {
		if (Platform.isMobile) return false;
		const path = this.activeNotePath();
		if (!path || path === this.sidebarNotePath) return false;
		this.sidebarNotePath = path;
		const leaf = this.getClaudianLeaf();
		const side = leaf ? this.sidebarOf(leaf) : null;
		if (!leaf || !side) return false;
		const split = side === "right" ? this.app.workspace.rightSplit : this.app.workspace.leftSplit;
		if (split.collapsed) return false;
		const visible = this.isLeafVisible(leaf);
		if (visible && this.lastOpenedPath && this.lastOpenedPath !== path) {
			this.rememberConversation(this.lastOpenedPath);
		}
		const wanted = this.noteHasConversation(path);
		if (wanted === visible) return false;
		if (!wanted) {
			// Its reading spot too, while it is still laid out to be read.
			this.saveScrollSpot();
			this.revealSidebarDefault(leaf);
			return true;
		}
		// Claudian still holds the conversation of the note it was last shown for; revealed
		// as it is, that one showed first and was then swapped. Veiled from before the reveal.
		const noteLeaf = this.getNoteLeaf();
		this.veilUntilSettled(path, false);
		void this.app.workspace.revealLeaf(leaf).then(() => {
			if (noteLeaf) this.app.workspace.setActiveLeaf(noteLeaf, { focus: false });
			this.lastSyncedPath = null;
			this.syncCurrentNoteChip();
			this.returnToSpot(false);
			this.liftVeilWhenSettled(leaf.view.containerEl);
		});
		return true;
	}

	/**
	 * Hide Claudian's conversation until `notePath`'s is the one on screen. Switching notes
	 * swaps the conversation asynchronously — Claudian loads the next one before it replaces
	 * the list — so the note left behind kept showing its conversation through the load and
	 * then jumped to the new one. Veiled, the switch goes straight from one to the other.
	 * `watch: false` leaves starting the watch to the caller, for a veil put on before the
	 * view is even revealed.
	 */
	private veilUntilSettled(notePath: string, watch = true): void {
		const container = this.getClaudianLeaf()?.view.containerEl;
		if (!container) return;
		const already = container.hasClass(VEILED_CLS);
		container.addClass(VEILED_CLS);
		this.veiledFor = notePath;
		if (watch && !already) this.liftVeilWhenSettled(container);
	}

	/**
	 * Lift the veil once the note's conversation is the one on screen and no restore is
	 * still hiding or positioning it — or after VEIL_MAX_MS, so the view is never left blank.
	 */
	private liftVeilWhenSettled(container: HTMLElement): void {
		const start = performance.now();
		const settle = (): void => {
			if (!container.hasClass(VEILED_CLS)) return;
			const want = this.veiledFor ? this.conversationFor(this.veiledFor) : null;
			const showing = this.getActiveTab()?.conversationId ?? null;
			const restoring = Array.from(this.restores.values()).some((restore) => restore.phase !== "holding");
			if ((showing === want && !restoring) || performance.now() - start > VEIL_MAX_MS) {
				container.removeClass(VEILED_CLS);
				return;
			}
			requestAnimationFrame(settle);
		};
		requestAnimationFrame(settle);
	}

	/** Whether there is a conversation to show for this note; see matchSidebarToNote. */
	private noteHasConversation(notePath: string): boolean {
		if (this.conversationFor(notePath)) return true;
		const tabs = this.getTabManager()?.getAllTabs?.() ?? [];
		return tabs.some(
			(tab) => !!tab.conversationId && this.conversationBelongsTo(tab.conversationId, notePath),
		);
	}

	/**
	 * React to the open note changing.
	 *
	 * The conversation is about something else now, so it has to give way — but which way
	 * depends on whether we've been here before. A note we have a conversation on file for
	 * gets it put back; any other note falls through to clearing the context, which is what
	 * this always did. Either way the outgoing note's conversation is written down first, so
	 * the note we're leaving can be returned to later.
	 *
	 * Both settle the note themselves: a restored conversation is locked to its own note, and
	 * a fresh one starts as a draft that links the active note. A reply still running can't
	 * be swapped out of its tab, so then the note's conversation opens in a tab of its own and
	 * the reply finishes in the background. When none of that takes (the conversation is
	 * empty and there's nothing to clear, or Claudian's internals have drifted) all that's
	 * left is nudging a draft onto this note — a sent conversation's note can't be moved.
	 */
	private handleNoteChange(path: string): void {
		const previous = this.lastOpenedPath;
		this.lastOpenedPath = path;
		// First note we've seen (fresh load, or Claudian just appeared): there is no
		// previous conversation to clear.
		if (previous !== null && previous !== path) {
			this.saveScrollSpot();
			this.rememberConversation(previous);
			this.closeExtraTabs(path);
			if (this.activeTabWorking()) {
				if (this.openBesideRunningReply(path)) return;
			} else if (this.restoreConversationFor(path) || this.resetSessionForNoteChange()) {
				return;
			}
		}
		this.followNoteInDraft(path);
	}

	/** Whether the active tab has a reply (or anything else) still running. */
	private activeTabWorking(): boolean {
		const manager = this.getTabManager();
		const tab = manager?.getActiveTab?.() ?? null;
		return tab ? this.tabWorking(manager, tab) : false;
	}

	private tabWorking(manager: ClaudianTabManager | null, tab: ClaudianTab): boolean {
		if (tab.id && typeof manager?.isTabWorking === "function") return manager.isTabWorking(tab.id);
		return Boolean(tab.state?.isStreaming);
	}

	/**
	 * Move to `notePath`'s conversation while the active tab's reply is still running.
	 *
	 * Claudian won't swap a conversation out of a tab mid-reply, and stopping it is not what
	 * changing notes means. So the running tab is left where it is, still going, and the
	 * note's conversation opens in another tab — the one already holding it, if any, else a
	 * new one; a note with nothing on file gets a fresh draft there. Coming back to the
	 * first note finds its conversation in the running tab (openConversation switches to a
	 * tab holding it), carrying on, or finished, where the reply left off.
	 *
	 * Reports whether it took, so the caller can fall back to the single-tab behaviour.
	 */
	private openBesideRunningReply(notePath: string): boolean {
		const manager = this.getTabManager();
		const running = manager?.getActiveTab?.() ?? null;
		if (!manager || !running?.id) return false;
		const conversationId = this.conversationFor(notePath);
		let opened: Promise<unknown>;
		if (conversationId && typeof manager.openConversation === "function") {
			// The running tab shows until the other one takes over; see veilUntilSettled.
			this.veilUntilSettled(notePath);
			opened = manager.openConversation(conversationId, { preferNewTab: true });
		} else if (typeof manager.createTab === "function") {
			opened = manager.createTab(undefined, undefined, { activate: true });
		} else {
			return false;
		}
		void opened.then(
			() => {
				// A fresh tab is a draft; point it at the note it was opened for.
				if (!conversationId && this.lastOpenedPath === notePath) this.followNoteInDraft(notePath);
			},
			(error: unknown) => console.warn("Claudian (Enhanced): couldn't open a tab beside the running reply", error),
		);
		return true;
	}

	/**
	 * The conversation on file for this note, if it still exists and is still the note's —
	 * the checks restoreConversationFor makes, without its clean-up.
	 */
	private conversationFor(notePath: string): string | null {
		const entry = this.remembered.find((note) => note.path === notePath);
		if (entry) {
			const id = entry.conversationId;
			if (this.conversationExists(id) && this.conversationBelongsTo(id, notePath)) return id;
			// Gone, or not this note's after all — a pairing written down before the check in
			// rememberConversation existed. Dropped, and Claudian's history asked instead.
			this.remembered = this.remembered.filter((note) => note !== entry);
			void this.persistMemory();
		}
		return this.latestLinkedConversation(notePath);
	}

	/**
	 * The note's most recent conversation in Claudian's own history: linked to the note, not
	 * archived, not empty, and newer than a clear by hand. The memory above only holds the
	 * last few notes, and only learns a pairing when the note is left with its conversation on
	 * screen — a note left while its conversation sat in a background tab, or one visited
	 * before more recent ones pushed it out, was otherwise met with a fresh conversation
	 * although Claudian had one linked to it all along.
	 */
	private latestLinkedConversation(notePath: string): string | null {
		const view = this.getClaudianLeaf()?.view as unknown as { plugin?: ClaudianPluginApi };
		const list = view?.plugin?.getConversationList;
		if (typeof list !== "function") return null;
		const clearedAt = this.clearedNotes[notePath] ?? 0;
		let best: { id: string; at: number } | null = null;
		for (const conversation of list.call(view.plugin) ?? []) {
			if (!conversation.id || conversation.linkedContentPath !== notePath) continue;
			if (conversation.isArchived || conversation.messageCount === 0) continue;
			const at = conversation.lastActivityAt ?? conversation.createdAt ?? 0;
			if (at <= clearedAt) continue;
			if (!best || at > best.at) best = { id: conversation.id, at };
		}
		return best?.id ?? null;
	}

	/**
	 * Keep Claudian to one session on screen: close every tab but the one showing, once it is
	 * idle and has nothing typed into its composer. Claudian's tab strip is hidden (see
	 * styles.css), so a tab behind the one showing can't be reached anyway — it is there
	 * only because a reply was running when the note changed (openBesideRunningReply), or
	 * because Claudian opened one itself (restoring its tabs on startup, opening a
	 * conversation from history). Their conversations are saved as they close and come back
	 * with their notes. Kept: a tab still working, and the one holding the conversation of
	 * the note being switched to, which is about to be switched to.
	 */
	private closeExtraTabs(nextNotePath: string): void {
		const manager = this.getTabManager();
		if (!manager || typeof manager.getAllTabs !== "function" || typeof manager.closeTab !== "function") return;
		const active = manager.getActiveTab?.() ?? null;
		const keep = this.conversationFor(nextNotePath);
		for (const tab of manager.getAllTabs()) {
			if (!tab.id || tab === active) continue;
			if (this.tabWorking(manager, tab) || (keep && tab.conversationId === keep)) continue;
			const typed = tab.dom?.inputEl?.value;
			if (typeof typed === "string" && typed.trim()) continue;
			void manager.closeTab(tab.id);
		}
	}

	/**
	 * Write down which conversation the tab is on as we leave `notePath`.
	 *
	 * Recorded on the way out rather than on the way in because that's the only moment the
	 * pairing is certainly true: the tab has been sitting on this note for the whole
	 * conversation, and any switch Claudian makes next would blur it. A tab with no
	 * conversation id has never been prompted, so there is nothing worth coming back to.
	 */
	private rememberConversation(notePath: string): void {
		const conversationId = this.getActiveTab()?.conversationId;
		if (!conversationId) return;
		// A conversation belongs to the note it was started on, and only that one.
		// Browsing on without prompting carries the same conversation from note to note,
		// and writing it down at each departure paired one conversation with every note
		// visited since — after which arriving at any of them found "the conversation is
		// already open", counted that as a restore, and so never cleared the tab. The
		// first note to claim a conversation keeps it.
		const owner = this.remembered.find(
			(note) => note.conversationId === conversationId,
		);
		if (owner && owner.path !== notePath) return;
		// Nor is a conversation written down for a note it isn't linked to. One started with
		// no note — from the graph view — was otherwise filed under whichever note was left
		// next, and coming back to that note brought the graph conversation back instead.
		if (!this.conversationBelongsTo(conversationId, notePath)) return;
		const existing = this.remembered.find((note) => note.path === notePath);
		if (existing?.conversationId === conversationId && this.remembered[0] === existing) {
			return; // already on file, already newest — nothing to write
		}
		this.remembered = [
			{ path: notePath, conversationId },
			...this.remembered.filter((note) => note.path !== notePath),
		].slice(0, REMEMBERED_NOTES);
		delete this.clearedNotes[notePath];
		void this.persistMemory();
	}

	/**
	 * Put this note's conversation back in the tab we're already in, and report whether that
	 * happened so the caller can fall through to a fresh session. The note's conversation is
	 * the one on file for it, else its latest in Claudian's history (see conversationFor).
	 *
	 * Declines while a reply is streaming for the same reason resetSessionForNoteChange does
	 * — Claudian's own switchTo refuses mid-stream anyway, so acting would report a restore
	 * that never occurred and skip the fallback. A conversation the user has since deleted is
	 * dropped from memory rather than handed to Claudian, which would only raise its own
	 * "failed to load" notice.
	 */
	private restoreConversationFor(notePath: string): boolean {
		const manager = this.getTabManager();
		const tab = manager?.getActiveTab?.() ?? null;
		if (!manager || typeof manager.openConversation !== "function" || !tab) {
			return false;
		}
		if (tab.state?.isStreaming) return false;
		// Checked before "already showing it": a wrong pairing is just as wrong when its
		// conversation happens to be the one on screen (conversationFor drops it).
		const conversationId = this.conversationFor(notePath);
		if (!conversationId) return false;
		// Already showing it (came back without ever leaving the conversation) — count it as
		// restored so the caller doesn't clear the very thing we wanted to keep.
		if (tab.conversationId === conversationId) return true;
		// Reported as restored synchronously, so a hydration that fails afterwards would
		// otherwise leave the previous note's conversation sitting under this note with the
		// fallback already skipped. Clear it then instead — but only if we're still on the
		// note that asked, since another switch may have landed while it was loading.
		const scroller = this.visibleEl<HTMLElement>(CLAUDIAN_MESSAGES);
		const token = scroller ? this.beginRestore(scroller) : 0;
		this.veilUntilSettled(notePath);
		manager.openConversation(conversationId, { preferNewTab: false }).then(
			() => {
				if (scroller) this.settleScroll(scroller, conversationId, token);
				// It may have switched to another tab holding the conversation; the one left
				// behind is closed now rather than at the next switch.
				if (this.lastOpenedPath === notePath) this.closeExtraTabs(notePath);
			},
			() => {
				if (scroller) this.endRestore(scroller, token);
				if (this.lastOpenedPath === notePath) this.resetSessionForNoteChange();
			},
		);
		return true;
	}

	/**
	 * Whether Claudian still has this conversation. Its repository holds every conversation
	 * in memory, so this also answers for ones never opened in this session.
	 *
	 * A build that renamed the lookup answers "yes": the point of this check is to catch a
	 * deleted conversation, and treating an unreachable lookup as "gone" would disable
	 * restoring altogether rather than degrade it.
	 */
	private conversationExists(id: string): boolean {
		const view = this.getClaudianLeaf()?.view as unknown as {
			plugin?: ClaudianPluginApi;
		};
		const lookup = view?.plugin?.getCachedConversation;
		if (typeof lookup !== "function") return true;
		return lookup.call(view.plugin, id) != null;
	}

	/**
	 * Whether a conversation belongs to this note, as Claudian records it: the note it is
	 * linked to. A conversation started with no note (from the graph view, say) is linked to
	 * none and belongs to no note. Answers "yes" when the lookup or the record isn't there to
	 * ask, for the same reason as conversationExists: this exists to catch a wrong pairing,
	 * not to switch the feature off when Claudian's internals move.
	 */
	private conversationBelongsTo(id: string, notePath: string): boolean {
		const view = this.getClaudianLeaf()?.view as unknown as {
			plugin?: ClaudianPluginApi;
		};
		const lookup = view?.plugin?.getCachedConversation;
		if (typeof lookup !== "function") return true;
		const conversation = lookup.call(view.plugin, id) as { linkedContentPath?: string | null } | null;
		if (!conversation) return true;
		return (conversation.linkedContentPath ?? null) === notePath;
	}

	/**
	 * Load the note→conversation memory, seeding it from Claudian's own history the first
	 * time. Claudian records the linked note on every conversation, so the pairings we want
	 * already exist on disk — without this the feature would sit idle until you'd switched
	 * notes enough times to rebuild what was already known.
	 *
	 * Seeding runs once: an empty result is still stored, so a vault with no history doesn't
	 * re-scan on every load.
	 */
	private async loadMemory(): Promise<void> {
		const stored = (await this.loadData()) as StoredData | null;
		this.clearedNotes = { ...stored?.clearedNotes };
		this.spots = new Map(Object.entries(stored?.scrollSpots ?? {}));
		if (stored?.recentNotes) {
			const notes = stored.recentNotes.slice(0, REMEMBERED_NOTES);
			this.remembered = await this.dropSharedConversations(notes);
			if (this.remembered.length !== notes.length) await this.persistMemory();
			return;
		}
		this.remembered = await this.seedFromClaudianHistory();
		await this.persistMemory();
	}

	/**
	 * Keep one note per conversation, healing memory written before a conversation could
	 * only be claimed once (see rememberConversation).
	 *
	 * Which note keeps it is Claudian's own answer: each conversation's meta records the
	 * note it belongs to, so that pairing wins over ours. Only when the meta is gone or
	 * names none of the candidates does recency decide, which is the best guess left.
	 */
	private async dropSharedConversations(
		notes: RememberedNote[],
	): Promise<RememberedNote[]> {
		const byConversation = new Map<string, RememberedNote[]>();
		for (const note of notes) {
			const group = byConversation.get(note.conversationId);
			if (group) group.push(note);
			else byConversation.set(note.conversationId, [note]);
		}

		const keep = new Set<RememberedNote>();
		for (const [conversationId, group] of byConversation) {
			if (group.length === 1) {
				keep.add(group[0]!);
				continue;
			}
			const owner = await this.claudianNoteFor(conversationId);
			keep.add(group.find((note) => note.path === owner) ?? group[0]!);
		}

		return notes.filter((note) => keep.has(note));
	}

	/** The note Claudian itself records for a conversation, or null if it can't be read. */
	private async claudianNoteFor(conversationId: string): Promise<string | null> {
		const path = `${CLAUDIAN_SESSIONS_DIR}/${conversationId}${SESSION_META_SUFFIX}`;
		try {
			const meta = JSON.parse(await this.app.vault.adapter.read(path)) as SessionMeta;
			return meta.linkedContentPath ?? meta.currentNote ?? null;
		} catch {
			return null;
		}
	}

	private async persistMemory(): Promise<void> {
		await this.saveData({
			recentNotes: this.remembered,
			clearedNotes: this.clearedNotes,
			scrollSpots: Object.fromEntries(this.spots),
		} satisfies StoredData);
	}

	/**
	 * The most recent conversation for each of the last {@link REMEMBERED_NOTES} notes, read
	 * out of Claudian's session metas. Anything unreadable or missing a note is skipped —
	 * this is a convenience, so a single malformed file must not cost the whole seed.
	 */
	private async seedFromClaudianHistory(): Promise<RememberedNote[]> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(CLAUDIAN_SESSIONS_DIR))) return [];
		const metas: Array<RememberedNote & { updatedAt: number }> = [];
		for (const file of (await adapter.list(CLAUDIAN_SESSIONS_DIR)).files) {
			if (!file.endsWith(SESSION_META_SUFFIX)) continue;
			try {
				const meta = JSON.parse(await adapter.read(file)) as SessionMeta;
				const note = meta.linkedContentPath ?? meta.currentNote;
				if (!meta.id || !note) continue;
				metas.push({
					path: note,
					conversationId: meta.id,
					updatedAt: meta.lastActivityAt ?? meta.updatedAt ?? meta.createdAt ?? 0,
				});
			} catch {
				continue;
			}
		}
		metas.sort((a, b) => b.updatedAt - a.updatedAt);
		const seeded: RememberedNote[] = [];
		for (const meta of metas) {
			if (seeded.some((note) => note.path === meta.path)) continue;
			seeded.push({ path: meta.path, conversationId: meta.conversationId });
			if (seeded.length === REMEMBERED_NOTES) break;
		}
		return seeded;
	}

	/**
	 * Follow a renamed or moved note. A folder rename fires once for the folder itself, so
	 * paths underneath it are rewritten by prefix rather than waiting for events that never
	 * come.
	 *
	 * The two note trackers move too. `lastOpenedPath` especially: leaving it on the old path
	 * would make the next sync compare the same note under two names, read that as a switch,
	 * and clear a conversation purely because the file was renamed.
	 */
	private handleNoteRenamed(newPath: string, oldPath: string): void {
		const moved = (path: string): string | null => {
			if (path === oldPath) return newPath;
			const prefix = `${oldPath}/`;
			return path.startsWith(prefix)
				? `${newPath}/${path.slice(prefix.length)}`
				: null;
		};
		if (this.lastOpenedPath) {
			this.lastOpenedPath = moved(this.lastOpenedPath) ?? this.lastOpenedPath;
		}
		if (this.lastSyncedPath) {
			this.lastSyncedPath = moved(this.lastSyncedPath) ?? this.lastSyncedPath;
		}
		if (this.sidebarNotePath) {
			this.sidebarNotePath = moved(this.sidebarNotePath) ?? this.sidebarNotePath;
		}
		let changed = false;
		this.remembered = this.remembered.map((note) => {
			const path = moved(note.path);
			if (path === null) return note;
			changed = true;
			return { ...note, path };
		});
		for (const [path, at] of Object.entries(this.clearedNotes)) {
			const next = moved(path);
			if (next === null) continue;
			delete this.clearedNotes[path];
			this.clearedNotes[next] = at;
			changed = true;
		}
		if (changed) void this.persistMemory();
	}

	/**
	 * Start a fresh conversation in the current tab and stop associating the open note with
	 * the one being left behind.
	 *
	 * The order matters: the note is forgotten first, because Claudian's command settles
	 * asynchronously and a sync landing in between would otherwise see the note still on
	 * file and restore the conversation we are in the middle of clearing. Nothing is lost
	 * either way — the old conversation stays in Claudian's own history, it just stops
	 * coming back on its own.
	 */
	private clearCurrentTab(): void {
		const path = this.activeNotePath();
		if (path) {
			this.forgetNote(path);
			// Claudian's history still links the old conversation to this note; without this,
			// conversationFor would bring it straight back on the next visit.
			this.clearedNotes[path] = Date.now();
			void this.persistMemory();
		}
		// An untouched tab already is the fresh start being asked for. Claudian's command
		// would start a new conversation regardless — filing the empty one into history and
		// re-linking the note — so reuse what's there and only spend a reset on a tab
		// that actually holds something.
		if (this.tabHasContent()) {
			(this.app as unknown as AppWithCommands).commands.executeCommandById(
				NEW_SESSION_COMMAND,
			);
		}

		// Land in the composer, so an emptied tab can be typed into straight away. Claudian
		// re-focuses its own tab root after every render, which is why this needs the same
		// sticky loop ⌘L uses rather than a single focus() — and the generation bump makes
		// any loop still running from an earlier press stand down.
		const gen = ++this.gen;
		const leaf = this.getClaudianLeaf();
		if (leaf && !this.isLeafVisible(leaf)) {
			// Hidden: there is nothing to focus until it is on screen, and revealing is
			// exactly what ⌘L does — including the focus loop.
			this.openClaudian(gen);
			return;
		}
		this.stickyFocusInput(Date.now() + 1500, gen);
	}

	/**
	 * Whether the active tab holds anything a clear would throw away.
	 *
	 * An unreadable tab counts as holding something: the point of the check is to skip
	 * pointless churn, and guessing "empty" on a build whose internals drifted would turn
	 * the command into a no-op instead of degrading it to always resetting.
	 */
	private tabHasContent(): boolean {
		return this.conversationStarted() || !Array.isArray(this.getActiveTabState()?.messages);
	}

	/**
	 * Whether the active tab's conversation has been started — sent at least once, so it's
	 * locked to its note and a note switch has to replace it.
	 *
	 * The messages on screen don't settle it. Claude Code keeps a conversation's history in
	 * ~/.claude on the machine that ran it, and only Claudian's record of it is in the vault,
	 * so a conversation from another Mac opens here with nothing in it: an empty pane, still
	 * locked to its note. Counted as empty, it was left in place and its note's chip stayed
	 * under every note opened after it. Claudian gives a tab a conversation id at its first
	 * prompt and not before, so that is the test, with the messages as a fallback.
	 */
	private conversationStarted(): boolean {
		const tab = this.getActiveTab();
		return Boolean(tab?.conversationId) || Boolean(tab?.state?.messages?.length);
	}

	/** Drop a deleted note (and, for a folder, everything under it) from the memory. */
	private forgetNote(path: string): void {
		const prefix = `${path}/`;
		const under = (notePath: string): boolean => notePath === path || notePath.startsWith(prefix);
		const kept = this.remembered.filter((note) => !under(note.path));
		const cleared = Object.keys(this.clearedNotes).filter(under);
		if (kept.length === this.remembered.length && cleared.length === 0) return;
		this.remembered = kept;
		for (const notePath of cleared) delete this.clearedNotes[notePath];
		void this.persistMemory();
	}

	/**
	 * Clear the conversation context by starting a fresh session in the current tab.
	 * Returns whether it actually happened, so the caller can fall back.
	 *
	 * Declines while a reply is streaming (never cut off a running response) and when the
	 * conversation hasn't been started (nothing to clear — resetting would only churn the
	 * tab and drop an attached note the user just set up).
	 */
	private resetSessionForNoteChange(): boolean {
		const state = this.getActiveTabState();
		if (!state || state.isStreaming) return false;
		if (!this.conversationStarted()) return false;
		return (this.app as unknown as AppWithCommands).commands.executeCommandById(
			NEW_SESSION_COMMAND,
		);
	}

	/**
	 * Claudian's active conversation tab, or null when Claudian is absent or a future build
	 * has renamed the path we reach through. Every hop is optional so this degrades to null
	 * rather than throwing; the accessors below narrow it to the one piece they need.
	 */
	private getActiveTab(): ClaudianTab | null {
		return this.getTabManager()?.getActiveTab?.() ?? null;
	}

	/** Claudian's tab manager for its view, or null when absent / internals renamed. */
	private getTabManager(): ClaudianTabManager | null {
		const view = this.getClaudianLeaf()?.view as unknown as {
			getTabManager?: () => ClaudianTabManager | null;
		};
		return view?.getTabManager?.() ?? null;
	}

	/** Claudian's active conversation-tab state, or null if absent / internals renamed. */
	private getActiveTabState(): ClaudianTabState | null {
		return this.getActiveTab()?.state ?? null;
	}

	/** Claudian's 划词 controller for the active tab, or null if absent / internals renamed. */
	private getSelectionController(): ClaudianSelectionController | null {
		return this.getActiveTab()?.controllers?.selectionController ?? null;
	}

	/**
	 * Point an unsent draft's Linked content at `path`, for a note switch that Claudian's own
	 * file-open hook missed. Goes through that same hook, so it inherits its rules: only a
	 * draft that is still following the active note moves (a locked or hand-picked one stays
	 * put), and an excluded or non-Markdown note links nothing. Idempotent; missing internals
	 * → no-op.
	 */
	private followNoteInDraft(path: string): void {
		const linked = this.getLinkedContent();
		if (typeof linked?.handleActiveFileChanged !== "function") return;
		const snapshot = linked.getSnapshot?.();
		if (snapshot?.path === path) return;
		// A draft linked to no note at all stops following for good: Claudian makes it a
		// hand-picked "none" when the note it followed is deleted (or its chip's × is clicked),
		// and a hand-picked draft never moves again — so after a new note was made and deleted,
		// every note opened since showed "Linked content: None". Arriving at a note is a fresh
		// start here (a conversation with messages is replaced outright), so an empty draft
		// follows the note again. A note picked by hand is still left where it was put.
		if (snapshot?.mode === "explicit-draft" && snapshot.path === null) linked.resetAutoDraft?.();
		const file = this.app.vault.getFileByPath(path);
		if (file) linked.handleActiveFileChanged(file, true);
	}

	/**
	 * After a cold start, square Claudian's restored conversation with the note we actually
	 * have open. Claudian restores its last conversation together with *that conversation's*
	 * note, locked — so it stays on the old note even though a different note is open now.
	 *
	 * We poll until Claudian's view has mounted (composer present) *and* its restore has
	 * populated a note — the restore is async and lands around mount, so reading too early
	 * would see no note and act on the wrong (empty) state. If no note ever gets linked
	 * within the window (a conversation that genuinely carries none), we give up.
	 */
	private reconcileChipOnStartup(deadline: number): void {
		const tick = (): void => {
			if (this.claudianMounted() && this.restoredTabSettled()) {
				const attached = this.linkedNotePath();
				if (attached !== null) {
					const notePath = this.activeNotePath();
					if (notePath) {
						if (attached === notePath) {
							// Already agree — seed the tracker so a *later* switch is the first
							// thing that clears context, and leave the conversation alone.
							this.lastOpenedPath = notePath;
						} else {
							// The restored conversation belongs to a different note. Dragging it
							// onto this one (what this used to do) rewrote the conversation's own
							// note in Claudian's meta, so a conversation merely *held* while some
							// note happened to be open looked like it was about that note from
							// then on — and the memory, which trusts that meta, inherited the lie.
							// Arrive from the note it actually belongs to instead: the restored
							// conversation is recorded where it can be found again, and this note
							// gets its own conversation back, or a fresh one.
							this.lastOpenedPath = attached;
							this.handleNoteChange(notePath);
						}
					}
					return; // restore settled — done
				}
			}
			if (Date.now() < deadline) window.setTimeout(tick, 150);
		};
		tick();
	}

	/**
	 * Whether the tab is done being restored, so its state can be judged.
	 *
	 * Claudian populates a restored tab in two steps: the conversation id and its note first,
	 * the message history afterwards. Reading it in between is what broke the cold start —
	 * resetSessionForNoteChange asks "is there anything to clear?" by counting messages, saw
	 * none yet, decided the conversation was empty and left it in place, so the chip moved to
	 * the open note while the tab kept a conversation about a different one.
	 *
	 * Messages arriving is the signal in the normal case; the hydration marker covers a
	 * conversation that legitimately loads to nothing, and a failed load, so this can't wait
	 * forever on either.
	 */
	private restoredTabSettled(): boolean {
		const tab = this.getActiveTab();
		// A tab with no conversation has nothing to wait for (it's already the empty state).
		if (!tab?.conversationId) return true;
		if (tab.state?.messages?.length) return true;
		return tab.hydrationState === "ready" || tab.hydrationState === "failed";
	}

	/** Claudian's Linked content controller for the active tab, or null if absent / renamed. */
	private getLinkedContent(): ClaudianLinkedContent | null {
		return this.getActiveTab()?.ui?.linkedContentController ?? null;
	}

	/**
	 * The note the active tab's conversation is linked to (vault-relative, forward slashes —
	 * same shape as TFile.path, so it compares directly), or null when none is linked or the
	 * internal shape has drifted.
	 */
	private linkedNotePath(): string | null {
		return this.getLinkedContent()?.getSnapshot?.().path ?? null;
	}

	/**
	 * The vault path of the open note, or null.
	 *
	 * Deliberately not {@link getNoteLeaf}: that one insists on a leaf with a live
	 * CodeMirror editor, and when the front leaf hasn't got one — reading view, a leaf
	 * Obsidian still has deferred, the split second a leaf is swapping views as a link
	 * opens — it scans `getLeavesOfType("markdown")`, which is in *creation* order. With
	 * more than one tab open that hands back some unrelated tab, and the caller reads it
	 * as "the user switched notes": the conversation gets cleared for a note change that
	 * never happened, which is what following a link into the note you were already
	 * reading used to do.
	 *
	 * So: the front leaf when it really is a note, else Obsidian's own active file, which
	 * stays parked on the last note while Claudian's sidebar holds focus — exactly the
	 * answer we want. Never a guess at a different tab.
	 */
	private activeNotePath(): string | null {
		const recent = this.app.workspace.getMostRecentLeaf();
		if (recent && this.isNoteLeaf(recent)) {
			const path = (recent.view as unknown as { file?: { path?: string } }).file
				?.path;
			if (path) return path;
		}
		return this.app.workspace.getActiveFile()?.path ?? null;
	}

	/** A Markdown leaf in the main area — not a sidebar, not another view type. */
	private isNoteLeaf(leaf: WorkspaceLeaf): boolean {
		return leaf.view.getViewType() === "markdown" && this.sidebarOf(leaf) === null;
	}

	private scheduleSelectionTags(): void {
		if (this.tagFrame !== null) return;
		this.tagFrame = requestAnimationFrame(() => {
			this.tagFrame = null;
			this.tagSentSelections();
		});
	}

	/**
	 * Show under each prompt the note lines it was sent with.
	 *
	 * Claudian sends a 划词 to Claude as an `<editor_selection path=… lines=…>` block after the
	 * prompt, and strips that block from the bubble, so once sent there was no telling which
	 * lines a question was about. A prompt sent this session still carries the selection in
	 * its message; one restored from history doesn't, and is read from the Claude Code session
	 * file instead, where the prompt is kept as sent (loadSessionSelections). A prompt
	 * neither knows of gets no tag.
	 */
	private tagSentSelections(): void {
		const container = this.getClaudianLeaf()?.view.containerEl;
		if (!container) return;
		const bubbles = Array.from(container.querySelectorAll<HTMLElement>(`${CLAUDIAN_USER_MESSAGE}[data-message-id]`));
		if (bubbles.length === 0) return;
		const messages = new Map<string, ClaudianMessage>();
		for (const tab of this.getTabManager()?.getAllTabs?.() ?? []) {
			for (const message of (tab.state?.messages ?? []) as ClaudianMessage[]) {
				if (message?.id) messages.set(message.id, message);
			}
		}
		const lookups: string[] = [];
		let unfilled = false;
		for (const bubble of bubbles) {
			const message = messages.get(bubble.dataset.messageId ?? "");
			// Drawn before Claudian has put the message in its list: a fresh prompt, a moment old.
			if (!message) {
				unfilled = true;
				continue;
			}
			const live = liveSelection(message);
			if (live !== undefined) {
				this.renderSelectionTag(bubble, live);
				continue;
			}
			const key = message.userMessageId ?? message.id ?? "";
			if (this.sentSelections.has(key)) this.renderSelectionTag(bubble, this.sentSelections.get(key) ?? null);
			else lookups.push(key);
		}
		if (unfilled && this.tagRetries < 10) {
			this.tagRetries++;
			window.setTimeout(() => this.scheduleSelectionTags(), 400);
		} else if (!unfilled) {
			this.tagRetries = 0;
		}
		if (lookups.length === 0) return;
		void this.loadSessionSelections().then(
			() => {
				// A restored prompt the session file has no selection for was sent with none.
				for (const key of lookups) if (!this.sentSelections.has(key)) this.sentSelections.set(key, null);
				this.scheduleSelectionTags();
			},
			(error: unknown) => console.warn("Claudian (Enhanced): couldn't read the prompts' selections", error),
		);
	}

	/**
	 * Read the selections the open conversations' prompts were sent with out of their Claude
	 * Code session files — `<config>/projects/<vault path, every other character a dash>/
	 * <session id>.jsonl`, as Claudian itself locates them. Only lines naming a selection are
	 * parsed, and a file is read again only once it has changed.
	 */
	private async loadSessionSelections(): Promise<void> {
		if (!Platform.isDesktopApp) return;
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return;
		const view = this.getClaudianLeaf()?.view as unknown as { plugin?: ClaudianPluginApi };
		const lookup = view?.plugin?.getCachedConversation;
		if (typeof lookup !== "function") return;
		const { promises: fs } = nodeRequire<typeof import("fs")>("fs");
		const path = nodeRequire<typeof import("path")>("path");
		const os = nodeRequire<typeof import("os")>("os");
		const { env } = nodeRequire<typeof import("process")>("process");
		const config = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
		const dir = path.join(config, "projects", path.resolve(adapter.getBasePath()).replace(/[^a-zA-Z0-9]/g, "-"));
		for (const tab of this.getTabManager()?.getAllTabs?.() ?? []) {
			if (!tab.conversationId) continue;
			const conversation = lookup.call(view.plugin, tab.conversationId) as {
				sessionId?: string | null;
				providerState?: { providerSessionId?: string | null };
			} | null;
			const sessionId = conversation?.providerState?.providerSessionId ?? conversation?.sessionId;
			if (!sessionId || !/^[\w-]+$/.test(sessionId)) continue;
			const file = path.join(dir, `${sessionId}.jsonl`);
			let mtime: number;
			try {
				mtime = (await fs.stat(file)).mtimeMs;
			} catch {
				continue; // never run on this machine
			}
			if (this.readSessions.get(file) === mtime) continue;
			this.readSessions.set(file, mtime);
			const text = await fs.readFile(file, "utf8");
			for (const line of text.split("\n")) {
				if (!line.includes("editor_selection")) continue;
				let entry: { type?: string; uuid?: string; message?: { content?: unknown } };
				try {
					entry = JSON.parse(line) as typeof entry;
				} catch {
					continue;
				}
				if (entry.type !== "user" || !entry.uuid) continue;
				const content = entry.message?.content;
				const prompt =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? (content as { type?: string; text?: string }[])
									.filter((block) => block.type === "text")
									.map((block) => block.text ?? "")
									.join("\n")
							: "";
				const found = /<editor_selection path="([^"]*)" lines="(\d+)-(\d+)"/.exec(prompt);
				if (!found) continue;
				this.sentSelections.set(entry.uuid, {
					path: decodeAttribute(found[1] ?? ""),
					start: Number(found[2]),
					end: Number(found[3]),
				});
			}
		}
	}

	/** Put the tag under a prompt, or take it away — touching the DOM only when it changes. */
	private renderSelectionTag(bubble: HTMLElement, selection: SentSelection | null): void {
		const content = bubble.querySelector<HTMLElement>(".claudian-message-content");
		if (!content) return;
		const existing = content.querySelector<HTMLElement>(`:scope > .${SELECTION_TAG_CLS}`);
		if (!selection) {
			existing?.remove();
			return;
		}
		const lines = selection.start === selection.end ? `L${selection.start}` : `L${selection.start}–${selection.end}`;
		const linked = this.linkedNotePath();
		const note = selection.path === linked ? "" : `${selection.path.split("/").pop()?.replace(/\.md$/, "")} · `;
		const label = `${note}${lines}`;
		if (existing?.dataset.label === label) return;
		existing?.remove();
		const tag = content.createDiv({ cls: SELECTION_TAG_CLS, attr: { "aria-label": selection.path, "data-label": label } });
		setIcon(tag.createSpan({ cls: `${SELECTION_TAG_CLS}-icon` }), "text-select");
		tag.createSpan({ text: label });
		// To those lines in the note, as the selection was made there.
		tag.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.app.workspace.openLinkText(selection.path, "", false, {
				eState: { line: selection.start - 1 },
			});
		});
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
			let promptsChanged = false;
			for (const record of records) {
				this.hideIfRebuilding(record);
				submitted ??= this.addedUserMessage(record);
				streamed ??= this.messagesListOf(record.target);
				queued ||= this.isInQueueRow(record.target);
				promptsChanged ||= this.changesPromptContent(record);
			}
			if (promptsChanged) {
				this.scheduleFold(container);
				this.scheduleSelectionTags();
			}
			this.returnToSpot(true);
			// Both scroll "the list this landed in" — there's one per conversation tab. Not a
			// conversation being put back, though: settleScroll positions that, its re-rendered
			// prompts aren't submits, and pinning it here is what used to move it.
			const submittedList = submitted?.closest<HTMLElement>(CLAUDIAN_MESSAGES) ?? null;
			if (submittedList) {
				if (!this.restores.has(submittedList)) this.scrollToBottom(submittedList);
			} else if (streamed && !this.restores.has(streamed)) {
				this.followToBottom(streamed);
				// A reply growing below a reader who scrolled up moves the end further away
				// without a scroll event; one following it is pinned, so this hides nothing.
				this.syncJumpButton(streamed);
			}
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
		// Width decides how many lines a prompt wraps to, so a panel resize can move a
		// prompt across the fold limit in either direction.
		this.foldResizeObserver?.disconnect();
		this.foldResizeObserver = new ResizeObserver(() => this.scheduleFold(container));
		this.foldResizeObserver.observe(container);
		// Prompts already on screen when we bind never produce a mutation of their own.
		this.scheduleFold(container);
	}

	/**
	 * Whether a mutation can change how tall a prompt is: one added, or its content
	 * re-rendered (Claudian empties and refills it on edit). Class changes are ignored on
	 * purpose — pinning, burying and folding all write classes onto prompts, and none of
	 * them change what the content measures.
	 */
	private changesPromptContent(record: MutationRecord): boolean {
		if (record.type !== "childList") return false;
		if (this.addedUserMessage(record)) return true;
		const el =
			record.target instanceof HTMLElement ? record.target : record.target.parentElement;
		return !!el?.closest(CLAUDIAN_USER_MESSAGE);
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
	/**
	 * Track whether the reader is still following the stream.
	 *
	 * Geometry alone can't answer this. Measuring the distance from the bottom after each
	 * streamed chunk means a small scroll — one wheel notch is about 100px — sits inside the
	 * slack we need for the chunk itself, so the next chunk snapped the reader straight back
	 * and scrolling up felt like it did nothing. What matters isn't where the view is, it's
	 * whether the person moved it, so record the direction they moved instead. Any upward
	 * move detaches; only returning to the end re-attaches. Reading scrollTop covers the
	 * wheel, trackpad, scrollbar dragging and the keyboard alike, and the selfScrolling flag
	 * keeps our own pinning from being mistaken for either.
	 */
	private onScrollCapture = (event: Event): void => {
		const scroller = event.target as HTMLElement | null;
		if (!scroller?.matches?.(CLAUDIAN_MESSAGES)) return;
		this.schedulePinnedPrompt(scroller);
		this.syncJumpButton(scroller);
		const top = scroller.scrollTop;
		const previous = this.lastScrollTop.get(scroller) ?? top;
		this.lastScrollTop.set(scroller, top);
		if (!this.selfScrolling && top < previous - 1) {
			this.detached.add(scroller);
			return;
		}
		const distance = scroller.scrollHeight - top - scroller.clientHeight;
		if (distance <= REATTACH_PX) this.detached.delete(scroller);
	};

	/**
	 * Flag the prompt currently stuck to the top of `scroller`, at most once a frame.
	 *
	 * The sticky prompt has to paint over the strip above it or the reply scrolls through
	 * the gap; CSS alone can't, because a box-shadow is drawn whether or not the element is
	 * stuck, so a fill wide enough for the strip would cover the previous message too.
	 * Knowing which prompt is pinned is the missing piece.
	 *
	 * Getting there costs a forced layout, so this is throttled to one pass per frame —
	 * scroll events fire far faster than that, and an intermediate answer is never shown.
	 */
	private schedulePinnedPrompt(scroller: HTMLElement): void {
		if (this.pinnedFrame !== null) return;
		this.pinnedFrame = requestAnimationFrame(() => {
			this.pinnedFrame = null;
			this.markPinnedPrompt(scroller);
		});
	}

	/**
	 * Every rect is read before anything is written, and no class is written at all unless
	 * the pinned prompt actually changed (the push below is a style, and only moves while
	 * one prompt hands over to the next). Both matter:
	 *
	 * - interleaving reads and writes makes the browser re-run layout between each one, so
	 *   a long conversation paid O(n) forced reflows per scroll — enough on its own to make
	 *   scrolling stutter.
	 * - writing a class here feeds the MutationObserver in ensureSubmitScrollObserver,
	 *   which watches `class` on this subtree. Touching the DOM on every pass turned that
	 *   into a loop that hung the app. In the steady state — scrolling inside one answer —
	 *   the pinned prompt doesn't change, so now nothing is written and the observer stays
	 *   quiet. It only fires on a real section change, where it settles immediately because
	 *   the next pass finds the same prompt and writes nothing.
	 */
	private markPinnedPrompt(scroller: HTMLElement): void {
		if (!scroller.isConnected) return;
		// Where a pinned prompt actually comes to rest. `top: 0` is measured from the
		// scrollport, and the list carries a top padding, so a stuck prompt sits that far
		// below the list's own top edge — not flush with it. Comparing against the bare
		// edge therefore matched nothing, no prompt was ever marked, and both the strip
		// above the prompt and the stacking of older prompts went unhandled. Reading the
		// padding keeps this correct whether the engine insets the scrollport by it or not,
		// since a prompt that hasn't reached the top is still well below either line.
		const listRect = scroller.getBoundingClientRect();
		const padding = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
		const listTop = listRect.top + padding;
		const prompts = Array.from(
			scroller.querySelectorAll<HTMLElement>(CLAUDIAN_USER_MESSAGE),
		);
		let pinned: HTMLElement | null = null;
		let pinnedIndex = -1;
		for (const [index, prompt] of prompts.entries()) {
			// Sticky holds it at the edge, so "reached the top" means at or just past it.
			if (prompt.getBoundingClientRect().top <= listTop + 1) {
				pinned = prompt;
				pinnedIndex = index;
			} else break;
		}
		// The next prompt, on its way up, pushes the pinned one out ahead of it instead of
		// sliding over it — as a list's section headers do. Every prompt sticks to the same
		// edge of the same list, so CSS alone can only stack them: a header is pushed out by
		// the end of its own section, and Claudian has no element per turn to be that
		// section. So the pinned prompt is moved up by however far the next one has eaten
		// into its height, which keeps its bottom edge on the next one's top. The rect's
		// height rather than offsetHeight, which rounds and so pushed half a pixel early;
		// a translate doesn't change the height. Under half a pixel counts as none.
		const next = pinned ? prompts[pinnedIndex + 1] : undefined;
		const eaten =
			pinned && next
				? pinned.getBoundingClientRect().height - (next.getBoundingClientRect().top - listTop)
				: 0;
		const push = eaten >= 0.5 ? eaten : 0;
		if (this.pinnedPrompt !== pinned) {
			this.pinnedPrompt?.removeClass(PINNED_CLS);
			this.pinnedPrompt?.style.removeProperty("transform");
			pinned?.addClass(PINNED_CLS);
			this.pinnedPrompt = pinned;
			this.pinnedPush = 0;
			// Everything before the pinned prompt is stuck underneath it. Hiding rather than
			// unsticking keeps this free of jitter: visibility takes the buried prompts out of
			// sight without touching layout, so nothing below them moves and the pinned one
			// never has to be re-positioned. Re-adding a class the element already has is not
			// an attribute change, so these passes stay quiet for the MutationObserver too.
			for (const [index, prompt] of prompts.entries()) {
				if (index < pinnedIndex) prompt.addClass(BURIED_CLS);
				else prompt.removeClass(BURIED_CLS);
			}
		}
		// A style write, which the observer doesn't watch (it filters on `class`), and only
		// while the hand-over is under way: in the steady state the push is 0 and stays 0.
		if (pinned && push !== this.pinnedPush) {
			if (push > 0) pinned.style.transform = `translateY(${-push}px)`;
			else pinned.style.removeProperty("transform");
			this.pinnedPush = push;
		}
	}

	/** Run a fold pass on the next frame, coalescing a burst of mutations into one. */
	private scheduleFold(container: HTMLElement): void {
		if (this.foldFrame !== null) return;
		this.foldFrame = requestAnimationFrame(() => {
			this.foldFrame = null;
			this.foldLongPrompts(container);
		});
	}

	/**
	 * Fold prompts too long to be a readable header down to FOLD_LINES, with a toggle.
	 *
	 * A pinned prompt is only useful as a header: a long one — a pasted diagram, a file's
	 * worth of context — covered the whole panel while its reply scrolled underneath. It is
	 * folded wherever it is, not only while pinned, because a sticky element's box is its
	 * slot in the list: shrinking it at the moment it pins would pull the reply being read
	 * up by however much was cut, every time the pin changed hands.
	 *
	 * Reads before writes, and writes only on change — the same discipline as
	 * markPinnedPrompt, for the same reasons: interleaving forces a reflow per prompt, and
	 * every class write here is a mutation the observer above sees. A prompt that isn't laid
	 * out (in a hidden tab) measures zero and is left exactly as it was.
	 */
	private foldLongPrompts(container: HTMLElement): void {
		if (!container.isConnected) return;
		const measured: Array<{ prompt: HTMLElement; long: boolean }> = [];
		for (const prompt of Array.from(
			container.querySelectorAll<HTMLElement>(CLAUDIAN_USER_MESSAGE),
		)) {
			// The text, not the bubble around it: the bubble carries its own padding and
			// background, and clipping or fading it would cut the bubble rather than the text.
			const text = prompt.querySelector<HTMLElement>(CLAUDIAN_PROMPT_TEXT);
			if (!text || text.scrollHeight === 0) continue;
			const style = getComputedStyle(text);
			const line =
				parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 20;
			// scrollHeight is the full content even while folded, so this is stable.
			const long = text.scrollHeight > line * (FOLD_LINES + FOLD_SLACK_LINES);
			measured.push({ prompt, long });
		}
		for (const { prompt, long } of measured) {
			const folded = long && !this.expandedPrompts.has(prompt);
			if (prompt.hasClass(FOLDABLE_CLS) !== long) prompt.toggleClass(FOLDABLE_CLS, long);
			if (prompt.hasClass(FOLDED_CLS) !== folded) prompt.toggleClass(FOLDED_CLS, folded);
			if (long) this.syncFoldToggle(prompt, folded);
			else prompt.querySelector(`.${FOLD_TOGGLE_CLS}`)?.remove();
		}
	}

	/**
	 * The expand/collapse control: a small round button in the bubble's bottom-right
	 * corner, over the end of the last line it keeps, with a chevron — always shown, since
	 * it is the only sign there is more. Not a <button>: the theme pads every button, which
	 * is what made the toolbar's icons shake; and the pinned-prompt click handler stands
	 * aside for it, so expanding never doubles as a jump to the turn. Claudian refills the
	 * bubble when a prompt is edited, which takes this with it; the fold pass that follows
	 * puts it back. The icon is only rewritten when the state flips.
	 */
	private syncFoldToggle(prompt: HTMLElement, folded: boolean): void {
		const bubble = prompt.querySelector<HTMLElement>(":scope > .claudian-message-content");
		if (!bubble) return;
		let toggle = bubble.querySelector<HTMLElement>(`:scope > .${FOLD_TOGGLE_CLS}`);
		if (!toggle) {
			const flip = (event: Event): void => {
				event.preventDefault();
				event.stopPropagation();
				const collapse = !prompt.hasClass(FOLDED_CLS);
				if (collapse) this.expandedPrompts.delete(prompt);
				else this.expandedPrompts.add(prompt);
				prompt.toggleClass(FOLDED_CLS, collapse);
				this.syncFoldToggle(prompt, collapse);
			};
			toggle = bubble.createDiv({ cls: FOLD_TOGGLE_CLS, attr: { role: "button", tabindex: "0" } });
			toggle.addEventListener("click", flip);
			toggle.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") flip(event);
			});
		}
		const state = folded ? "folded" : "expanded";
		if (toggle.dataset.state === state) return;
		toggle.dataset.state = state;
		setIcon(toggle, folded ? "chevron-down" : "chevron-up");
		toggle.setAttribute("aria-label", folded ? "Expand prompt" : "Collapse prompt");
	}

	/** Pin a list to the bottom, marking the move as ours. */
	private pinToBottom(scroller: HTMLElement): void {
		this.selfScrolling = true;
		scroller.scrollTop = scroller.scrollHeight;
		this.lastScrollTop.set(scroller, scroller.scrollTop);
		// The scroll event lands asynchronously, so hold the flag past this frame.
		requestAnimationFrame(() => {
			this.selfScrolling = false;
		});
	}

	/**
	 * Let Claudian see text selected inside a block that Live Preview renders — a callout, a
	 * table. In the editor Claudian only asks the editor for its selection, and a selection
	 * inside a rendered block isn't one: it's the page's own, inside an element the editor
	 * stands in for its source, so the editor reports nothing and the 划词 went unnoticed.
	 * Reading mode works because there Claudian reads the page selection instead, so this
	 * hands it the same shape — plus the note lines the block's source covers. Cells selected
	 * in a table go the same way (see tableCellSelection).
	 *
	 * Claudian re-checks every 250ms, finds the editor selection empty and would drop it
	 * again; its grace period, meant for the reader moving to the composer, holds it while it
	 * is still selected. When it no longer is, the grace is lifted and Claudian's own rules
	 * apply again — which keep it if the reader went to the composer.
	 */
	private syncBlockSelection(): void {
		const controller = this.getSelectionController();
		if (!controller || !("storedSelection" in controller)) return; // internals drifted
		this.holdCellSelection(controller);
		const found = this.tableCellSelection() ?? this.selectionInRenderedBlock();
		const ours = this.blockSelection !== null && controller.storedSelection === this.blockSelection;
		if (!found) {
			if (ours) controller.inputHandoffGraceUntil = null;
			this.blockSelection = null;
			return;
		}
		const current = ours ? controller.storedSelection : null;
		if (
			current &&
			current.selectedText === found.selectedText &&
			current.startLine === found.startLine &&
			current.lineCount === found.lineCount
		) {
			return;
		}
		this.adoptSelection(controller, found);
		controller.onUserSelectionChanged?.();
	}

	/** Make `found` the selection Claudian carries, held past its poll's checks. */
	private adoptSelection(controller: ClaudianSelectionController, found: ClaudianStoredSelection): void {
		this.blockSelection = found;
		controller.storedSelection = found;
		controller.inputHandoffGraceUntil = Number.MAX_SAFE_INTEGER;
		controller.updateIndicator?.();
	}

	/**
	 * Keep selected cells Claudian's selection against its own poll. Clicking a cell four
	 * times, or dragging out of the cell being edited, leaves text selected in that cell's
	 * editor too — hidden while the cells are selected, but the editor reports it, so every
	 * 250ms Claudian took it over the cells and then said so through onUserSelectionChanged.
	 * That is where the cells are put back, in the same task, before anything is drawn.
	 */
	private holdCellSelection(controller: ClaudianSelectionController): void {
		if (this.heldControllers.has(controller)) return;
		this.heldControllers.add(controller);
		const notify = controller.onUserSelectionChanged;
		controller.onUserSelectionChanged = () => {
			if (controller.storedSelection !== this.blockSelection) {
				const cells = this.tableCellSelection();
				if (cells) this.adoptSelection(controller, cells);
			}
			notify?.call(controller);
			// Claudian dropping or replacing the selection takes its painting with it.
			this.syncCellHighlight();
		};
		this.register(() => {
			controller.onUserSelectionChanged = notify;
		});
	}

	/**
	 * The cells selected in a Live Preview table of the note being edited. Dragging across
	 * cells, or clicking one four times, selects them by class, so the page has nothing to
	 * report and the editor at most the text left selected in one cell (see
	 * holdCellSelection). The text is the selected columns of the selected rows as the note's
	 * source has them — a Dataview cell as its query, not its result — and the lines are
	 * those rows' lines.
	 */
	private tableCellSelection(): ClaudianStoredSelection | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file || view.getMode() !== "source") return null;
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		// Not a table the editor's own selection takes in whole (`is-selected`): that one is
		// Claudian's business, like any other text the editor holds.
		const table = cm?.contentDOM.querySelector<HTMLElement>(".cm-table-widget.has-selection:not(.is-selected)");
		if (!cm || !table) return null;
		const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>("th.is-selected, td.is-selected"));
		if (cells.length === 0) return null;
		const rowsOf = cells.map((cell) => (cell.parentElement as HTMLTableRowElement).rowIndex);
		const colsOf = cells.map((cell) => cell.cellIndex);
		const [minCol, maxCol] = [Math.min(...colsOf), Math.max(...colsOf)];
		let pos: number;
		try {
			pos = cm.posAtDOM(table);
		} catch {
			return null;
		}
		const doc = cm.state.doc;
		const first = doc.lineAt(pos).number;
		// Row 0 is the header; the delimiter line under it isn't a row of the table.
		const lineOf = (row: number): number => Math.min(first + (row === 0 ? 0 : row + 1), doc.lines);
		const start = lineOf(Math.min(...rowsOf));
		const end = lineOf(Math.max(...rowsOf));
		const width = table.querySelector("tr")?.cells.length ?? 0;
		const whole = minCol === 0 && maxCol >= width - 1;
		const lines: string[] = [];
		for (let n = start; n <= end; n++) {
			const text = doc.line(n).text;
			lines.push(whole ? text : `| ${tableRowCells(text).slice(minCol, maxCol + 1).join(" | ")} |`);
		}
		return {
			notePath: view.file.path,
			selectedText: lines.join("\n"),
			lineCount: end - start + 1,
			startLine: start,
			domRanges: [],
		};
	}

	/**
	 * Paint a carried 划词 that was made inside a table cell.
	 *
	 * Live Preview edits a table cell in an editor of its own, nested in the table widget.
	 * Claudian takes the selection from it correctly, but paints it as a decoration in the
	 * note's editor — and a decoration can't draw inside a widget, so once focus left the
	 * cell (⌘L, a click into the composer) the selection vanished from the table while
	 * Claudian still carried it. It is painted here with the CSS Custom Highlight API, which
	 * reaches inside the widget without touching its DOM, styled as Claudian's own is
	 * (styles.css). Only while the cell is unfocused: focused, its native selection shows.
	 */
	private syncCellHighlight(): void {
		const registry = highlightRegistry();
		const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => object }).Highlight;
		if (!registry || !Highlight) return;
		const range = this.carriedCellRange();
		if (range) registry.set(CELL_HIGHLIGHT, new Highlight(range));
		else registry.delete(CELL_HIGHLIGHT);
	}

	/**
	 * The carried selection as a range in the table cell editor holding it, or null: no
	 * selection carried, none of the open cell editors has it selected, or the one that does
	 * has focus. Matched on the text, so a cell editor left with some other selection in it
	 * isn't painted — compared as cellText has it, since the two spell a line break apart.
	 */
	private carriedCellRange(): Range | null {
		const selected = this.getSelectionController()?.storedSelection?.selectedText;
		const carried = selected ? cellText(selected) : "";
		const cm = this.cmOf(this.getNoteLeaf());
		if (!carried || !cm) return null;
		for (const el of Array.from(cm.contentDOM.querySelectorAll<HTMLElement>(".cm-table-widget .cm-editor"))) {
			const cell = EditorView.findFromDOM(el);
			if (!cell || cell.hasFocus) continue;
			const { from, to, empty } = cell.state.selection.main;
			if (empty || cellText(cell.state.sliceDoc(from, to)) !== carried) continue;
			try {
				const start = cell.domAtPos(from);
				const end = cell.domAtPos(to);
				const range = el.ownerDocument.createRange();
				range.setStart(start.node, start.offset);
				range.setEnd(end.node, end.offset);
				return range;
			} catch {
				return null;
			}
		}
		return null;
	}

	/** The page selection, when it lies inside a rendered block of the note being edited. */
	private selectionInRenderedBlock(): ClaudianStoredSelection | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file || view.getMode() !== "source") return null;
		// Text the editor holds itself is Claudian's own business.
		if (view.editor.getSelection().trim()) return null;
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		const selection = cm?.dom.ownerDocument.getSelection();
		const text = selection?.toString().trim();
		if (!cm || !selection || !text || selection.rangeCount === 0) return null;
		const { anchorNode, focusNode } = selection;
		if (!anchorNode || !focusNode) return null;
		if (!cm.contentDOM.contains(anchorNode) || !cm.contentDOM.contains(focusNode)) return null;
		// Inside something the editor drew in place of its source.
		const element = anchorNode instanceof Element ? anchorNode : anchorNode.parentElement;
		const block = element?.closest<HTMLElement>('[contenteditable="false"]');
		if (!block || !cm.contentDOM.contains(block)) return null;
		const domRanges: Range[] = [];
		for (let i = 0; i < selection.rangeCount; i++) domRanges.push(selection.getRangeAt(i).cloneRange());
		const lines = this.sourceLinesOf(cm, block, text);
		return {
			notePath: view.file.path,
			selectedText: text,
			lineCount: lines?.count ?? text.split(/\r?\n/).length,
			...(lines ? { startLine: lines.start } : {}),
			domRanges,
		};
	}

	/**
	 * The note lines (1-based) that selected text inside a rendered block came from. The
	 * block's source runs from the line the editor puts it at to the next blank line — where
	 * a callout or a table ends. Within it, the first and last selected lines are matched
	 * against the source with markup and spacing left out, since the rendered text has
	 * neither; if the first can't be matched, the whole block is the honest answer.
	 */
	private sourceLinesOf(cm: EditorView, block: HTMLElement, text: string): { start: number; count: number } | null {
		let pos: number;
		try {
			pos = cm.posAtDOM(block);
		} catch {
			return null;
		}
		const doc = cm.state.doc;
		const first = doc.lineAt(pos).number;
		let last = first;
		while (last < doc.lines && doc.line(last + 1).text.trim() !== "") last++;
		const bare = (s: string): string => s.replace(/[\s>*_`~=|#[\]]/g, "");
		const selected = text.split(/\r?\n/).map(bare).filter(Boolean);
		const head = selected[0]?.slice(0, 8);
		const tail = selected[selected.length - 1]?.slice(-8);
		const lineWith = (probe: string, from: number): number | null => {
			for (let n = from; n <= last; n++) if (bare(doc.line(n).text).includes(probe)) return n;
			return null;
		};
		const start = head ? lineWith(head, first) : null;
		if (start === null) return { start: first, count: last - first + 1 };
		const end = (tail ? lineWith(tail, start) : start) ?? last;
		return { start, count: end - start + 1 };
	}

	/**
	 * Let Escape close Claudian's image preview.
	 *
	 * The preview listens for Escape on the document, in the bubble phase. Obsidian's keymap
	 * gets the key first, on the window in the capture phase, and asks the active view's
	 * scope — Claudian's, after a click on the image — whose Escape handler closes its
	 * menus or interrupts a running reply and reports the key handled whatever it did. Obsidian
	 * then stops the event there: the preview never heard it, and a reply in progress was
	 * cut off instead. While a preview is open, a scope of ours sits on top and takes Escape
	 * to close it, through the preview's own close button so Claudian tidies up as usual.
	 */
	private watchImagePreview(): void {
		const body = document.body;
		const sync = (): void => {
			const open = body.querySelector(":scope > .claudian-image-modal-overlay") !== null;
			if (open && !this.previewScope) {
				const scope = new Scope(this.app.scope);
				scope.register([], "Escape", () => {
					body.querySelector<HTMLElement>(".claudian-image-modal-overlay .claudian-image-modal-close")?.click();
					return false;
				});
				this.app.keymap.pushScope(scope);
				this.previewScope = scope;
			} else if (!open && this.previewScope) {
				this.app.keymap.popScope(this.previewScope);
				this.previewScope = null;
			}
		};
		const observer = new MutationObserver(sync);
		observer.observe(body, { childList: true });
		this.register(() => {
			observer.disconnect();
			if (this.previewScope) this.app.keymap.popScope(this.previewScope);
			this.previewScope = null;
		});
	}

	/** Write down where the reader is in the conversation on screen, before it's swapped out. */
	private saveScrollSpot(): void {
		const id = this.getActiveTab()?.conversationId;
		const scroller = this.visibleEl<HTMLElement>(CLAUDIAN_MESSAGES);
		// A list still being restored hasn't reached its spot yet; what it shows isn't news.
		if (!id || !scroller || this.restores.has(scroller)) return;
		// Nor does one out of sight: it has no layout, so every measure reads 0.
		if (scroller.offsetParent === null) return;
		const top = scroller.getBoundingClientRect().top;
		const reply = Array.from(scroller.querySelectorAll<HTMLElement>(CLAUDIAN_REPLY)).find(
			(el) => el.getBoundingClientRect().bottom > top,
		);
		const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		this.spots.delete(id); // re-inserted last, so the oldest is first in line to go
		this.spots.set(id, {
			atBottom: distance <= REATTACH_PX,
			replyId: reply?.dataset.messageId ?? null,
			offset: reply ? reply.getBoundingClientRect().top - top : 0,
			scrollTop: scroller.scrollTop,
		});
		// Oldest first; a Map tolerates deleting the key it is iterating on.
		for (const oldest of this.spots.keys()) {
			if (this.spots.size <= 20) break;
			this.spots.delete(oldest);
		}
		void this.persistMemory();
	}

	/**
	 * Put the conversation on screen back on its reading spot — or at its end, where the
	 * latest reply is, if it has none yet.
	 *
	 * The spot is applied when a conversation is swapped in (restoreConversationFor), but two
	 * other ways of showing one skipped it. Opening Obsidian: Claudian rebuilds the
	 * conversation into a list that starts at its top, and following its growth stops as soon
	 * as the list is a screen taller than the view — so a cold start left it at the top, and
	 * the spot was only kept in memory anyway. And bringing Claudian back out (⌘L, the sidebar
	 * following the note): a list hidden in a sidebar tab comes back at its top.
	 *
	 * `onlyFirst` is the cold-start case, run on every change to the list: only a conversation
	 * not yet put on its spot this session, once Claudian has finished loading it.
	 */
	private returnToSpot(onlyFirst: boolean): void {
		const id = this.getActiveTab()?.conversationId;
		if (!id || (onlyFirst && this.positioned.has(id))) return;
		if (!this.restoredTabSettled()) return;
		const scroller = this.visibleEl<HTMLElement>(CLAUDIAN_MESSAGES);
		if (!scroller || scroller.offsetParent === null || this.restores.has(scroller)) return;
		if (!scroller.querySelector(`${CLAUDIAN_REPLY}, ${CLAUDIAN_USER_MESSAGE}`)) return; // nothing drawn yet
		this.settleScroll(scroller, id, this.beginRestore(scroller, false));
	}

	/**
	 * `hide: false` positions without ever hiding the list: for a conversation that is
	 * already on screen rather than being swapped in, whose re-renders (a reply streaming)
	 * would otherwise read as a rebuild and blank it.
	 */
	private beginRestore(scroller: HTMLElement, hide = true): number {
		const token = ++this.restoreSeq;
		scroller.removeClass(RESTORING_CLS);
		this.restores.set(scroller, { token, phase: hide ? "armed" : "holding" });
		// Never leave a list invisible: if the switch is swallowed somewhere along the way.
		window.setTimeout(() => this.endRestore(scroller, token), 5000);
		return token;
	}

	private endRestore(scroller: HTMLElement, token: number): void {
		if (this.restores.get(scroller)?.token !== token) return;
		this.restores.delete(scroller);
		scroller.removeClass(RESTORING_CLS);
	}

	/**
	 * Hide a list the moment Claudian empties it to rebuild a returning conversation. Mutation
	 * callbacks run before the next paint and Claudian rebuilds in one go, so the old
	 * conversation stays on screen until then and the half-built one is never shown — no
	 * jump to the top, no scrolling into place.
	 */
	private hideIfRebuilding(record: MutationRecord): void {
		if (record.type !== "childList" || record.removedNodes.length === 0) return;
		const scroller = record.target as HTMLElement;
		const restore = this.restores.get(scroller);
		if (restore?.phase !== "armed") return;
		restore.phase = "hidden";
		scroller.addClass(RESTORING_CLS);
	}

	/**
	 * Put the reader back where they were once the returning conversation is in the list.
	 *
	 * Rendering doesn't end when Claudian's switch resolves: message content fills in over
	 * the next frames, growing the list above and below the spot. So the spot is re-applied
	 * every frame, the list stays hidden until its height has held still for a frame,
	 * and the spot is held a while after that against anything that renders late — until
	 * the reader touches the list, which hands it back to them.
	 */
	private settleScroll(scroller: HTMLElement, conversationId: string, token: number): void {
		this.positioned.add(conversationId);
		const spot = this.spots.get(conversationId) ?? null;
		const start = performance.now();
		let lastHeight = -1;
		let steady = 0;
		let touched = false;
		const onInput = (): void => {
			touched = true;
		};
		const doc = scroller.ownerDocument;
		scroller.addEventListener("wheel", onInput, { passive: true });
		scroller.addEventListener("touchstart", onInput, { passive: true });
		scroller.addEventListener("pointerdown", onInput);
		doc.addEventListener("keydown", onInput, true);
		const finish = (): void => {
			scroller.removeEventListener("wheel", onInput);
			scroller.removeEventListener("touchstart", onInput);
			scroller.removeEventListener("pointerdown", onInput);
			doc.removeEventListener("keydown", onInput, true);
			const ours = this.restores.get(scroller)?.token === token;
			this.endRestore(scroller, token);
			if (!ours) return;
			// Streaming follows a list only while the reader is at its end.
			const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
			if (distance <= REATTACH_PX) this.detached.delete(scroller);
			else this.detached.add(scroller);
		};
		const step = (): void => {
			const restore = this.restores.get(scroller);
			// Superseded by a newer switch, or the tab moved on to something else.
			if (restore?.token !== token || this.getActiveTab()?.conversationId !== conversationId) {
				finish();
				return;
			}
			if (!touched) this.applySpot(scroller, spot);
			const height = scroller.scrollHeight;
			steady = height === lastHeight ? steady + 1 : 0;
			lastHeight = height;
			const elapsed = performance.now() - start;
			if (restore.phase !== "holding" && (steady >= 1 || elapsed > REVEAL_MAX_MS)) {
				restore.phase = "holding";
				scroller.removeClass(RESTORING_CLS);
			}
			if (touched || elapsed > HOLD_SPOT_MS) {
				finish();
				return;
			}
			requestAnimationFrame(step);
		};
		step();
	}

	private applySpot(scroller: HTMLElement, spot: ScrollSpot | null): void {
		this.selfScrolling = true;
		if (!spot || spot.atBottom) {
			scroller.scrollTop = scroller.scrollHeight;
		} else {
			const reply = spot.replyId
				? scroller.querySelector<HTMLElement>(
						`.claudian-message[data-message-id="${CSS.escape(spot.replyId)}"]`,
					)
				: null;
			if (reply) {
				const drawnAt = reply.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
				scroller.scrollTop += drawnAt - spot.offset;
			} else {
				scroller.scrollTop = spot.scrollTop;
			}
		}
		this.lastScrollTop.set(scroller, scroller.scrollTop);
		requestAnimationFrame(() => {
			this.selfScrolling = false;
		});
	}

	/** Scroll to a saved spot; with none (not read here this session), to the end. */

	/**
	 * Show the jump-to-latest button while the conversation is scrolled away from its end,
	 * as chat apps do: a round arrow over the bottom of the list, which takes the reader back
	 * down and puts them back on a reply that's still streaming. Made on first need, in the
	 * list's wrapper (Claudian's positioned box around it) rather than the list, so it stays
	 * put while the list scrolls. Written only when it changes — scroll events come fast.
	 * Not a <button>: the theme pads those, which is what made the toolbar icons shake.
	 */
	private syncJumpButton(scroller: HTMLElement): void {
		const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		const show = distance > JUMP_SHOW_PX;
		let button = this.jumpButtons.get(scroller);
		if (!button) {
			const wrapper = scroller.parentElement;
			if (!show || !wrapper) return;
			const jump = (event: Event): void => {
				event.preventDefault();
				this.detached.delete(scroller);
				scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
			};
			button = wrapper.createDiv({
				cls: JUMP_BTN_CLS,
				attr: { role: "button", tabindex: "0", "aria-label": "Jump to latest" },
			});
			setIcon(button, "arrow-down");
			button.addEventListener("click", jump);
			button.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") jump(event);
			});
			this.jumpButtons.set(scroller, button);
		}
		if (button.hasClass("is-shown") !== show) button.toggleClass("is-shown", show);
	}

	private followToBottom(scroller: HTMLElement): void {
		// The reader took over; leave them where they are until they come back down.
		if (this.detached.has(scroller)) return;
		const distance =
			scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		if (distance > FOLLOW_THRESHOLD_PX) return;
		this.pinToBottom(scroller);
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
		// Sending a prompt (or queueing one) is a request to see it, so it cancels an
		// earlier scroll-up and puts the reader back on the stream.
		this.detached.delete(scroller);
		const run = (): void => {
			this.pinToBottom(scroller);
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
	/**
	 * Click the prompt that's stuck to the top of the conversation to scroll back to where
	 * that turn actually begins.
	 *
	 * A pinned prompt reads as a heading for the answer being scrolled through, and the thing
	 * you want from a heading is to be taken back to the start of its section — the reply is
	 * the long part, so once you are deep in it the question is the only way back up.
	 *
	 * Only the pinned prompt answers to this. An unpinned one is already sitting at its own
	 * position, so there would be nowhere to go.
	 */
	private interceptPinnedPromptClicks(): void {
		this.registerDomEvent(
			document,
			"click",
			(event: MouseEvent) => {
				if (event.button !== 0 || event.defaultPrevented) return;
				// A modified click asks for something else entirely (open elsewhere,
				// extend a selection); none of them mean "scroll".
				if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
					return;
				}
				const pinned = this.pinnedPrompt;
				const target = event.target as HTMLElement | null;
				if (!pinned || !target || !pinned.contains(target)) return;
				// The bubble hosts Claudian's copy / rewind / fork toolbar and can hold
				// links, all of which keep their own meaning.
				if (
					target.closest(CLAUDIAN_USER_ACTIONS) ??
					target.closest(CLAUDIAN_LINK) ??
					target.closest(`button, .${FOLD_TOGGLE_CLS}`)
				) {
					return;
				}
				// Selecting text inside the prompt ends in a click as well. The live
				// selection is what tells a drag from a tap — checking the event alone
				// can't, since both arrive as a plain left click.
				const selection = pinned.ownerDocument.defaultView?.getSelection();
				if (
					selection &&
					!selection.isCollapsed &&
					selection.anchorNode &&
					pinned.contains(selection.anchorNode)
				) {
					return;
				}
				const scroller = pinned.closest<HTMLElement>(CLAUDIAN_MESSAGES);
				if (scroller) this.scrollTurnIntoView(scroller, pinned);
			},
			{ capture: true },
		);
	}

	/**
	 * Scroll `scroller` until `prompt` sits where it belongs rather than where sticky is
	 * holding it.
	 *
	 * While stuck, the prompt's own rect reports the *stuck* position — that's the whole
	 * point of sticky — so it can't say where its turn starts. Dropping the offset for the
	 * length of one measurement gives the honest answer. An inline style is used rather than
	 * a class, for two reasons: it beats our own stylesheet rule without needing to out-
	 * specify it, and the MutationObserver in ensureSubmitScrollObserver watches `class` on
	 * this subtree, where a write would wake it for nothing. Sticky elements sit in normal
	 * flow, so taking the offset away moves nothing else and the pair of writes never paints.
	 *
	 * The scroll is left to read as the reader's own upward move, which is what it is: that
	 * detaches the list, so a reply still streaming stops dragging them back down to it.
	 */
	private scrollTurnIntoView(scroller: HTMLElement, prompt: HTMLElement): void {
		const inline = prompt.style.position;
		// Not a style being applied to the element — it is set and put back inside one
		// synchronous block, purely so the rect below can be read without the sticky
		// offset, and nothing paints in between. A class would be the usual answer and is
		// the wrong one here: it would wake the MutationObserver for nothing.
		// eslint-disable-next-line obsidianmd/no-static-styles-assignment
		prompt.style.position = "static";
		const naturalTop = prompt.getBoundingClientRect().top;
		prompt.style.position = inline;
		// The same rest position markPinnedPrompt measures against: `top: 0` is relative to
		// the scrollport, which the list's own top padding sits inside.
		const padding = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
		const listTop = scroller.getBoundingClientRect().top + padding;
		const delta = naturalTop - listTop;
		// Already there — clicking again shouldn't emit a scroll that only serves to mark
		// the list detached.
		if (Math.abs(delta) < 1) return;
		scroller.scrollTop += delta;
	}

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
	 * The note leaf we're protecting — the one whose *editor* we touch (collapsing a
	 * selection, repainting the 划词). Prefer the most recently active leaf (still the
	 * note while Claudian sits in a sidebar); fall back to an open Markdown leaf.
	 *
	 * The fallback skips sidebar leaves: a note opened in a dock is not the note the
	 * user is working in, and writing to its editor would be visible in the wrong place.
	 * For the *path* of the open note, use {@link activeNotePath} instead — the fallback
	 * here can still land on a tab other than the front one, which is harmless for
	 * editor work but not for deciding that the user switched notes.
	 */
	private getNoteLeaf(): WorkspaceLeaf | null {
		const recent = this.app.workspace.getMostRecentLeaf();
		if (recent && this.cmOf(recent)) return recent;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (this.sidebarOf(leaf) === null && this.cmOf(leaf)) return leaf;
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

	/** The visible composer — Claudian keeps hidden ones for background tabs. */
	private visibleInput(): HTMLElement | null {
		return this.visibleEl<HTMLElement>(CLAUDIAN_INPUT);
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

/**
 * A Markdown table row's cells, trimmed. A `|` splits cells unless it's escaped — as it is
 * in a link's alias inside a table — and the pipes at either end bound the row rather than
 * add an empty cell.
 */
function tableRowCells(row: string): string[] {
	const cells: string[] = [];
	let cell = "";
	for (let i = 0; i < row.length; i++) {
		const ch = row.charAt(i);
		if (ch === "\\" && i + 1 < row.length) {
			cell += ch + row.charAt(++i);
		} else if (ch === "|") {
			cells.push(cell);
			cell = "";
		} else {
			cell += ch;
		}
	}
	cells.push(cell);
	if (cells.length > 1 && cells[0]?.trim() === "") cells.shift();
	if (cells.length > 1 && cells[cells.length - 1]?.trim() === "") cells.pop();
	return cells.map((c) => c.trim());
}
