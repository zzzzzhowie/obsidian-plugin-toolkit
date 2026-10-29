import { FileSystemAdapter, MarkdownView, Notice, parseLinktext, Platform, Plugin, Scope, type SectionCache, setIcon, TextFileView, TFile, WorkspaceLeaf } from "obsidian";
import { EditorView } from "@codemirror/view";

import { CommentSelection, type CommentSelectionTab } from "./comment-selection";
import { ConversationFind } from "./conversation-find";
import { type ClaudianStatusSource, NoteTabStatus } from "./tab-status";
import { type PeekSelection, SelectionPeek } from "./selection-peek";
import { PromptNav } from "./prompt-nav";
import {
	columnAt,
	columnsOf,
	describe,
	flatten,
	linesLabel,
	locateText,
	MARKUP,
	type NoteReference,
	readReference,
	REFERENCE,
	referenceLabel,
	referenceText,
	selectionReference,
	tableRowCells,
} from "./note-reference";

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
/** The expand/collapse control in a long prompt's bubble: a strip along its bottom edge. */
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
 * linked for us. Run by clear-tab (⌘N in Claudian); see clearCurrentTab.
 * Claudian disables it in its wide dual-pane layout, where this reports false.
 */
const NEW_SESSION_COMMAND = "realclaudian:new-session";
/** Claudian's settings file, which it reads only at startup; see followSharedPrompt. */
const CLAUDIAN_SETTINGS_FILE = ".claudian/claudian-settings.json";
/** How often that file is looked at for a prompt changed from outside. */
const SETTINGS_POLL_MS = 3000;
/**
 * What clear-tab's hotkey does outside Claudian (see inClaudian): a new draft (the Drafts
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
/**
 * A reference to note lines — put in a prompt by ⌥K, or in a reply's change list (the
 * system prompt asks for one per change) — shown as a link to its lines; see linkReferences.
 */
const REFERENCE_CLS = "claudian-enhanced-reference";
/** The table cells a reference goes to, lit until a click in the note (lightTable). */
const LIT_CELL_CLS = "claudian-enhanced-lit-cell";
/** The text in them a reference quotes, lit the same way as a CSS Custom Highlight. */
const LIT_TEXT = "claudian-enhanced-lit-text";
/** Behind the text a reference quotes in a diagram's label, which a highlight doesn't reach (boxText). */
const LIT_TEXT_BOX_CLS = "claudian-enhanced-lit-text-box";
/** The parts of a Mermaid diagram — nodes, edges, subgraphs, states, notes — a reference goes to (lightDiagram). */
const LIT_SHAPE_CLS = "claudian-enhanced-lit-shape";
/** What a reference to a range of lines lights in reading view: its blocks or list items. */
const LIT_BLOCK_CLS = "claudian-enhanced-lit-block";
/** Something a reference lights (lightTable, lightDiagram, lightLines), held lit by keepLit. */
type Light = { paint: () => Element[] | null; clear: () => void };
/** A diagram as drawn, not mermaid-enhanced's copy standing in while it's redrawn. */
const DRAWN_DIAGRAM = ".mermaid:not(.mermaid-enhanced-hold) svg";
/** Elements that end one run of a reference's text and start another (linkReferencesIn). */
const RUN_BREAK = /^(?:P|LI|UL|OL|DIV|TABLE|TR|TD|TH|H[1-6]|PRE|BLOCKQUOTE|BR|HR)$/;
/** Where references are looked for: a prompt's text, a reply's text. */
const REFERENCE_TEXT = `${CLAUDIAN_USER_MESSAGE} ${CLAUDIAN_PROMPT_TEXT}, .claudian-message-assistant .claudian-text-block`;
/** The conversation's session id at the end of the row under the composer; see syncSessionIds. */
const SESSION_ID_CLS = "claudian-enhanced-session-id";
/** How long a copied session id says so before showing the id again (ms). */
const COPIED_MS = 1200;
/** The stop button at the end of the composer's toolbar, while Claudian works; see syncStopButtons. */
const STOP_BTN_CLS = "claudian-enhanced-stop";
/** How often whether Claudian is working is looked at again (ms): a turn ends without a mutation of its own. */
const STOP_POLL_MS = 300;
/**
 * What `lastOpenedPath` holds while an empty tab ("New tab") is the one open: no note, so a
 * conversation of none (see leaveForEmptyTab). Falsy, and never a note's path.
 */
const EMPTY_TAB = "";
/** How often session ids are looked at again outside the view's mutations (ms). */
const SESSION_ID_POLL_MS = 2000;
/**
 * Most Claudian tabs kept at once, one per open note; see trimTabCache. Each keeps its
 * conversation drawn, which is what makes going back to it instant, and what it costs.
 */
const TAB_CACHE_LIMIT = 8;
/** How long after a switch the tab cache is trimmed, so a run of switches trims once (ms). */
const TAB_TRIM_DELAY_MS = 1000;
/** Pause between conversations loaded ahead, to keep the work out of the way (ms). */
const PRELOAD_GAP_MS = 1500;
/** On a hidden Claudian tab kept laid out; see scheduleKeep. */
const KEPT_CLS = "claudian-enhanced-kept";
/** Hidden Claudian tabs kept laid out at once — the ones gone back to most often. */
const KEPT_LIMIT = 3;
/** Pause before keeping the next hidden tab laid out, out of the way of a switch or a reveal (ms). */
const KEEP_DELAY_MS = 800;
/** When loading ahead begins after Obsidian starts, Claudian's own restore done by then (ms). */
const PRELOAD_START_MS = 5000;
/** Longest `ask` waits for Claudian to hold the conversation it asks in (ms). */
const ASK_SETTLE_MS = 4000;
/** How often the note tabs' Claudian status is looked at again (ms); see NoteTabStatus. */
const TAB_STATUS_POLL_MS = 1000;
/** How often, and how many times, a prompt not filled in yet is looked at again (~30s). */
const TAG_RETRY_MS = 400;
/** How long after a note switch its result is checked; see verifySoon. */
const VERIFY_AFTER_MS = 1500;
const TAG_RETRIES = 75;
/** Claudian's replies. Prompts are left out on purpose: they're sticky (see styles.css), so
 *  where one is drawn says where it's pinned, not where it sits in the conversation. */
const CLAUDIAN_REPLY = ".claudian-message[data-message-id]:not(.claudian-message-user)";
/**
 * On Claudian's view while the note's conversation is being put on screen — brought out with
 * ⌘L, or loaded into a new tab: hidden until it is in place and on its spot (veilUntilSettled).
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
 * said `currentNote` / `updatedAt`, and both spellings are read. Since 2.3 too, new metas go
 * one folder per device under `devices/` (see CLAUDIAN_DEVICES_DIR); older ones stay at the top.
 */
const CLAUDIAN_SESSIONS_DIR = ".claudian/sessions";
const CLAUDIAN_DEVICES_DIR = `${CLAUDIAN_SESSIONS_DIR}/devices`;
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
	/** A note picked for the draft by hand — null is the chip's ×, no note; following stops. */
	selectExplicit?: (path: string | null) => void;
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
	/** What the next prompt goes with: the context Claudian reads off this as it sends. */
	getContext?: () => ClaudianSelectionContext | null;
	/** Drop the selection it carries, its highlight and its chip. */
	clear?: () => void;
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
	/** Draws the conversation; `removeMessage` takes one message's element away. */
	renderer?: { removeMessage?: (id: string) => void };
	conversationId?: string | null;
	/**
	 * How far Claudian has got loading this tab's conversation history: "loading", then
	 * "ready" or "failed" (absent until it starts). The id and the note are in place before
	 * any of that, so this is the only way to tell a conversation that is genuinely empty
	 * from one whose messages simply haven't arrived yet. See restoredTabSettled.
	 */
	hydrationState?: string;
	state?: ClaudianTabState;
	ui?: {
		linkedContentController?: ClaudianLinkedContent;
		/** The composer's `/` and `@` menus; their sources are what composerSources hands out. */
		composerDropdown?: { slashSource?: unknown; mentionSource?: unknown; controller?: { view?: ClaudianMenuView } };
	};
	/**
	 * The editor 划词 controller: `composerSelections.editor` since Claudian 2.3.16, which
	 * gathered the editor, browser and canvas selections under one; `selectionController` before.
	 */
	controllers?: {
		composerSelections?: { editor?: ClaudianSelectionController };
		selectionController?: ClaudianSelectionController;
		/** Sends what the composer holds, as Enter does; `cancelStreaming` stops the turn, as Esc does. */
		inputController?: {
			sendMessage?: () => Promise<void>;
			deps?: { canStartTurn?: () => boolean };
			cancelStreaming?: () => void;
			isPreparingMainTurn?: boolean;
		};
		/** The side chat; while it's where the composer sends (`destination` "side"), Esc stops it instead. */
		sideChatController?: { destination?: string; runtime?: { isWorking?: boolean } | null; cancelSide?: () => void };
	};
	/** What runs on past a reply: background work, and messages waiting to be sent. */
	session?: { hasMainBackgroundWork?: boolean; runtime?: { mailbox?: { hasPending?: boolean } | null } };
	/**
	 * The composer; Claudian gives its CodeMirror host a `value` that reads the text in it.
	 * `infoRowEl` is the row under it, with the note chip at its start.
	 */
	dom?: { inputEl?: { value?: unknown }; inputWrapper?: HTMLElement; infoRowEl?: HTMLElement; contentEl?: HTMLElement; messagesEl?: HTMLElement };
}

/**
 * Claudian's per-view tab manager, reached through the view's own `getTabManager()`.
 *
 * `openConversation` is the seam that makes returning to a note cheap: it first switches to
 * a tab already holding that conversation, then to another Claudian view holding it, and
 * only otherwise loads it — into a new tab given `preferNewTab: true`, which this plugin
 * always passes: it keeps one tab per open note, the strip hidden (replaceConversationFor).
 * `createTab`, `switchToTab` and `closeTab` are the rest of that cache.
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
	/** Shows a tab it holds — hidden ones are kept as they were, not rebuilt. */
	switchToTab?: (id: string) => Promise<void> | void;
	/** A fresh conversation in the active tab — what Claudian's "new session" command runs. */
	createNewConversation?: () => Promise<void>;
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
	/** Loads the whole conversation from disk; its summary's messageCount is right only after. */
	getConversationById?: (id: string) => Promise<unknown>;
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

/** How long ⌥K keeps the focus in the composer against the note taking it back; see holdComposerFocus. */
const COMPOSER_FOCUS_HOLD_MS = 600;

/**
 * Claudian's composer: an editor of its own (not a textarea) that answers to a textarea's
 * value and caret, and takes text as typed.
 */

interface ClaudianComposer extends HTMLElement {
	value?: unknown;
	selectionStart?: number;
	selectionEnd?: number;
	replaceText?: (from: number, to: number, text: string) => void;
	/** The element that takes the focus. */
	getAccessibleTextbox?: () => HTMLElement | null;
}

/** What a diagram is drawn from: a note's lines (1-based, inclusive), or a drawing's file (0, 0). */
interface DiagramSource {
	path: string;
	from: number;
	to: number;
}

/** The bits of Excalidraw's view (ExcalidrawView) ⌥K reads. */
interface ExcalidrawViewLike {
	getViewSelectedElements?: () => ExcalidrawElementLike[];
	getViewElements?: () => ExcalidrawElementLike[];
}

interface ExcalidrawElementLike {
	id: string;
	type?: string;
	text?: string;
	boundElements?: { id: string; type?: string }[] | null;
}

/** The code block around line `line` (1-based), its fences included; null outside one. */
function fenceAround(lines: string[], line: number): { from: number; to: number } | null {
	const FENCE = /^[\s>]*(`{3,}|~{3,})(.*)$/;
	// The widget may sit on the opening fence or just under it.
	let from = line;
	while (from > 0 && !FENCE.test(lines[from - 1] ?? "")) from--;
	const open = FENCE.exec(lines[from - 1] ?? "");
	if (!open) return null;
	const marks = open[1] ?? "";
	for (let n = from + 1; n <= lines.length; n++) {
		const close = FENCE.exec(lines[n - 1] ?? "");
		if (close && close[1]?.[0] === marks[0] && (close[1]?.length ?? 0) >= marks.length && !close[2]?.trim()) return { from, to: n };
	}
	return { from, to: lines.length };
}

/** Where a drawing file's `## Text Elements` section runs, by offset. */
function textElementsRange(content: string): { from: number; to: number } | null {
	const from = content.search(/^## Text Elements[ \t]*$/m);
	if (from < 0) return null;
	const rest = content.slice(from + 1).search(/^(?:## |%%)/m);
	return { from, to: rest < 0 ? content.length : from + 1 + rest };
}

/** The offset line `line` (1-based) starts at; past the end, the length. */
function offsetOfLine(lines: string[], line: number): number {
	let offset = 0;
	for (let n = 1; n < line && n <= lines.length; n++) offset += (lines[n - 1]?.length ?? 0) + 1;
	return offset;
}

/** The line (1-based) `offset` is on. */
function lineAtOffset(content: string, offset: number): number {
	return content.slice(0, offset).split("\n").length;
}

/** The box Claudian's `@` and `/` menus are drawn in; see quietEmptyMenus. */
interface ClaudianMenuView {
	render?: (items: readonly { state?: string }[], selected: number) => void;
	hide?: () => void;
}
/**
 * What a selection reads as. Obsidian 1.15 draws a diagram's label as an SVG <text>, a
 * <tspan> to a line, which `toString` runs together ("manage_type = 14选择器上下界"): in a
 * diagram, its lines and labels are each a line of their own.
 */
function selectionText(selection: Selection): string {
	const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
	const root = range?.commonAncestorContainer;
	if (!range || !(root instanceof Element ? root : root?.parentElement)?.closest("svg")) return selection.toString();
	if (!(root instanceof Element)) return selection.toString();
	let text = "";
	let line: Element | null = null;
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		// Not a diagram's <style>, say.
		const at = node.parentElement?.closest("tspan[y], text, foreignObject") ?? null;
		if (!at || !range.intersectsNode(node)) continue;
		const value = node.nodeValue ?? "";
		const piece = value.slice(node === range.startContainer ? range.startOffset : 0, node === range.endContainer ? range.endOffset : value.length);
		if (!piece) continue;
		if (text && at !== line) text += "\n";
		line = at;
		text += piece;
	}
	return text || selection.toString();
}


/** The note lines a prompt was sent with, as Claude got them. */
interface SentSelection {
	path: string;
	start: number;
	end: number;
	/** The selected text, as sent; shown in the tag's peek card. */
	text: string;
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
	selectedText?: string;
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
	return sentLines(
		context.editorSelection ?? context.selections?.find((item) => item.kind === "editor")?.selection,
	);
}

/** The note lines a selection context names, or null for one that isn't a 划词. */
function sentLines(selection: ClaudianSelectionContext | null | undefined): SentSelection | null {
	if (selection?.mode !== "selection" || !selection.notePath || !selection.startLine) return null;
	return {
		path: selection.notePath,
		start: selection.startLine,
		end: selection.startLine + Math.max(1, selection.lineCount ?? 1) - 1,
		text: selection.selectedText ?? "",
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

/** A `<br>` as it reads once escaped to text. */
const BR_TEXT = /<br\s*\/?>/i;

/**
 * Turn the `<br>`s in the table cells under `root` back into line breaks.
 *
 * Markdown has no line break inside a table cell, so a reply breaks one with `<br>` — and
 * Claudian escapes every bit of raw HTML in a reply before rendering it, so the cell showed
 * the tag as text. Only `<br>`, the one tag a cell needs, and only in text outside code,
 * where a literal `<br>` is meant to be read as one.
 */
function breakCellLines(root: Node): void {
	if (!(root instanceof HTMLElement)) return;
	const cells = root.matches("td, th") ? [root] : Array.from(root.querySelectorAll<HTMLElement>("td, th"));
	for (const cell of cells) {
		if (!cell.textContent || !BR_TEXT.test(cell.textContent) || !cell.closest(".claudian-message")) continue;
		const doc = cell.ownerDocument;
		const walker = doc.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
		const texts: Text[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
		for (const text of texts) {
			if (!BR_TEXT.test(text.data) || text.parentElement?.closest("code")) continue;
			const fragment = doc.createDocumentFragment();
			text.data.split(/<br\s*\/?>/i).forEach((part, index) => {
				if (index > 0) fragment.appendChild(doc.createElement("br"));
				if (part) fragment.appendChild(doc.createTextNode(part));
			});
			text.replaceWith(fragment);
		}
	}
}

/** A change-list group label, its icon optional: the systemPrompt ends an edit reply with these. */
const CHANGE_LABEL = /^(?:(?:➕|➖|✏️?)\s*)?(Added|Removed|Changed)$/;

/**
 * Colour the Added / Removed / Changed labels of a reply's change list by kind. They're plain
 * bold, which the theme paints one colour, and Claudian escapes raw HTML, so the reply can't
 * colour them itself. Only a bold that is a paragraph of its own: the same word in prose stays.
 */
function tagChangeLabels(root: Node): void {
	const el = root instanceof HTMLElement ? root : root.parentElement;
	if (!el) return;
	const labels = Array.from(el.querySelectorAll<HTMLElement>("p > strong"));
	const own = el.closest<HTMLElement>("p > strong");
	if (own) labels.push(own);
	for (const label of labels) {
		if (!label.closest(".claudian-message")) continue;
		const kind = CHANGE_LABEL.exec(label.textContent?.trim() ?? "")?.[1]?.toLowerCase();
		const alone = label.parentElement?.textContent?.trim() === label.textContent?.trim();
		for (const k of ["added", "removed", "changed"]) {
			label.classList.toggle(`${OWN_CLS_PREFIX}change-${k}`, alone && kind === k);
		}
	}
}

/**
 * The ids a drawn diagram gives what lines `from`–`to` (0-based) of its source `body` draw:
 * a flowchart's or a state diagram's, by the kind its first line names; none for another kind.
 */
function diagramTargets(body: string[], from: number, to: number): Set<string> {
	let front = false;
	for (const line of body) {
		const code = line.trim();
		// Frontmatter (`---` … `---`), comments and directives (`%%{init}%%`) come before the kind.
		if (code === "---") front = !front;
		if (front || code === "---" || !code || code.startsWith("%%")) continue;
		if (/^stateDiagram\b/.test(code)) return stateTargets(body, from, to);
		if (/^(?:flowchart|graph)\b/.test(code)) return flowchartTargets(body, from, to);
		break;
	}
	return new Set();
}

/**
 * The ids a drawn flowchart gives what lines `from`–`to` (0-based) of its source `body`
 * draw: a node's own; a subgraph's, for its `subgraph` line and its `end`. An edge, carried
 * by the edge and its label alike, is `L_<from>_<to>_<k>` — but k skips (the second of two
 * A → B edges is `L_A_B_2`), so it's given as `L_<from>_<to>_#<n>`, the n-th of them drawn;
 * see drawnIds.
 */
function flowchartTargets(body: string[], from: number, to: number): Set<string> {
	const ids = new Set<string>();
	// Earlier lines count too: they number the edges and open the subgraphs these close.
	const edges = new Map<string, number>();
	const open: string[] = [];
	for (let i = 0; i <= Math.min(to, body.length - 1); i++) {
		const code = (body[i] ?? "").replace(/%%.*$/, "").trim();
		const found: string[] = [];
		let m: RegExpExecArray | null;
		if ((m = /^subgraph\s+("?)([^\s"[]+)\1/.exec(code))) {
			open.push(m[2] ?? "");
			found.push(m[2] ?? "");
		} else if (/^end$/.test(code)) found.push(open.pop() ?? "");
		else if ((m = /^(?:style|click)\s+(\S+)/.exec(code))) found.push(m[1] ?? "");
		else if ((m = /^class\s+(\S+)/.exec(code))) found.push(...(m[1] ?? "").split(","));
		else if (code && !/^(?:classDef|linkStyle|direction|flowchart|graph|title|accTitle|accDescr)\b/.test(code)) {
			const groups = statementNodes(code);
			if (groups.length === 1) found.push(...(groups[0] ?? []));
			for (let g = 1; g < groups.length; g++) {
				for (const a of groups[g - 1] ?? []) {
					for (const b of groups[g] ?? []) {
						const pair = `${a}_${b}`;
						const n = edges.get(pair) ?? 0;
						edges.set(pair, n + 1);
						found.push(`L_${pair}_#${n}`);
					}
				}
			}
		}
		if (i >= from) for (const id of found) if (id) ids.add(id);
	}
	return ids;
}

/**
 * The ids a drawn state diagram gives what lines `from`–`to` (0-based) of its source `body`
 * draw: a state's own, for the lines that declare, describe or style it, and a composite
 * state's for its `{` and `}`. A transition is `edge<k>`, its label too; a note
 * `<state>----note-<k>`, with the line to its state. One count, k, numbers transitions and
 * notes alike, in the order they're written, composite states' insides included.
 */
function stateTargets(body: string[], from: number, to: number): Set<string> {
	const ids = new Set<string>();
	const open: string[] = [];
	let count = 0;
	// A note written over lines of its own, up to its `end note`: what each of them draws.
	let note: string[] | null = null;
	for (let i = 0; i <= Math.min(to, body.length - 1); i++) {
		const code = (body[i] ?? "").replace(/%%.*$/, "").trim();
		let found: string[] = [];
		let m: RegExpExecArray | null;
		if (note) {
			found = note;
			if (/^end\s+note$/i.test(code)) note = null;
		} else if ((m = /^note\s+(left|right)\s+of\s+([^\s:]+)\s*(:)?/i.exec(code))) {
			const [, side = "", state = "", colon] = m;
			const id = `${state}----note-${count++}`;
			// The line runs from the note on the left of its state, to it on the right.
			found = [id, side.toLowerCase() === "left" ? `${id}-${state}` : `${state}-${id}`];
			if (!colon) note = found;
		} else if (code === "}") found = [open.pop() ?? ""];
		else if ((m = /^state\s+(?:"[^"]*"\s+as\s+)?([^\s{"<]+)\s*(\{)?/.exec(code))) {
			found = [m[1] ?? ""];
			if (m[2]) open.push(m[1] ?? "");
		} else if ((m = /^(?:style|class)\s+(\S+)/.exec(code))) found = (m[1] ?? "").split(",");
		else if (code.includes("-->")) found = [`edge${count++}`];
		else if (code && code !== "--" && !/^(?:stateDiagram|direction|classDef|title|accTitle|accDescr)\b/.test(code)) {
			// `A`, `A : what it is`, `A:::class`.
			found = [/^[^\s:]+/.exec(code)?.[0] ?? ""];
		}
		if (i >= from) for (const id of found) if (id) ids.add(id);
	}
	return ids;
}

/** `targets` (diagramTargets) as the ids among `drawn`, in drawing order, that they stand for. */
function drawnIds(targets: Set<string>, drawn: string[]): Set<string> {
	const ids = new Set<string>();
	const edges = [...new Set(drawn.filter((id) => id.startsWith("L_")))];
	for (const target of targets) {
		const edge = /^(L_.+_)#(\d+)$/.exec(target);
		if (!edge) ids.add(target);
		const [, prefix = "", n = "0"] = edge ?? [];
		const id = edge && edges.filter((at) => at.startsWith(prefix) && /^\d+$/.test(at.slice(prefix.length)))[Number(n)];
		if (id) ids.add(id);
	}
	return ids;
}

/**
 * The nodes of a flowchart statement, link by link: `A & B --> C` is [[A, B], [C]]. Labels —
 * quoted, in a shape's brackets, on a link — are taken out first, whatever they hold.
 */
function statementNodes(code: string): string[][] {
	let text = code
		.replace(/"[^"]*"/g, "")
		.replace(/\|[^|]*\|/g, " ")
		.replace(/:::[\w-]+/g, "")
		// A label written into its link: `A -- text --> B`.
		.replace(/(?<![-=.])(?:--|==|-\.)(?![-=.>])\s+[^-=.>|]+?\s+(?:-->|---|==>|===|\.->|-\.-|--[ox])/g, " --> ");
	for (let before = ""; before !== text; ) {
		before = text;
		text = text.replace(/[[({][^[\](){}]*[\])}]/g, "");
	}
	return text
		.split(/\s*(?:<?(?:-{2,}|={2,}|-\.+-)[->ox]?|~{3,})\s*/)
		.map((part) => part.split("&").map((id) => /[\p{L}\p{N}_]+(?:[-.][\p{L}\p{N}_]+)*/u.exec(id)?.[0] ?? "").filter(Boolean))
		.filter((group) => group.length > 0);
}

/**
 * Boxes behind `range`'s text in a diagram's SVG `<text>`, one per line of it, in the text's
 * own coordinates: measured on screen and scaled back, the diagram being drawn at any size.
 * None while the diagram isn't laid out.
 */
function boxText(range: Range): SVGRectElement[] {
	const text = range.startContainer.parentElement?.closest("text");
	const parent = text?.parentNode;
	if (!text || !parent) return [];
	const screen = text.getBoundingClientRect();
	const own = text.getBBox();
	if (screen.width === 0 || screen.height === 0) return [];
	const [sx, sy] = [own.width / screen.width, own.height / screen.height];
	const doc = text.ownerDocument;
	// Text node by text node: the range's own rects would add a whole line's tspan over its text.
	const rects: DOMRect[] = [];
	const walker = doc.createTreeWalker(text, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!range.intersectsNode(node)) continue;
		const part = doc.createRange();
		part.selectNodeContents(node);
		if (node === range.startContainer) part.setStart(node, range.startOffset);
		if (node === range.endContainer) part.setEnd(node, range.endOffset);
		rects.push(...Array.from(part.getClientRects()));
	}
	const pad = 2;
	return rects.map((rect) => {
		const box = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
		box.setAttribute("class", LIT_TEXT_BOX_CLS);
		box.setAttribute("x", String(own.x + (rect.left - screen.left) * sx - pad));
		box.setAttribute("y", String(own.y + (rect.top - screen.top) * sy));
		box.setAttribute("width", String(rect.width * sx + 2 * pad));
		box.setAttribute("height", String(rect.height * sy));
		box.setAttribute("rx", "3");
		const transform = text.getAttribute("transform");
		if (transform) box.setAttribute("transform", transform);
		parent.insertBefore(box, text);
		return box;
	});
}

/** Whether Claudian is working on `tab`, as Esc reads it before stopping it. */
function isWorking(tab: ClaudianTab): boolean {
	const side = tab.controllers?.sideChatController;
	if (side?.destination === "side") return side.runtime?.isWorking ?? false;
	return !!(tab.state?.isStreaming || tab.controllers?.inputController?.isPreparingMainTurn || tab.session?.hasMainBackgroundWork || tab.session?.runtime?.mailbox?.hasPending);
}

/**
 * Where `quote` — source text, shortened as "start … end" when long — is in the rendered
 * `cells` (or a diagram's part), both read as flatten reads them (no markup, no spacing); null
 * when it isn't there, or when it's all their text (the cells themselves are what's meant).
 */
function renderedRange(cells: Element[], quote: string): Range | null {
	const chars: { node: Text; offset: number }[] = [];
	let flat = "";
	for (const cell of cells) {
		const walker = cell.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			// Only what's drawn: a cell being edited keeps its rendered text, hidden, beside its editor.
			if (!(node instanceof Text) || node.parentElement?.checkVisibility() === false) continue;
			for (let i = 0; i < node.data.length; i++) {
				const ch = node.data.charAt(i);
				if (MARKUP.test(ch)) continue;
				flat += ch;
				chars.push({ node, offset: i });
			}
		}
	}
	const [head = "", tail] = quote.split(" … ").map(flatten);
	const start = head ? flat.indexOf(head) : -1;
	if (start < 0) return null;
	let end = start + head.length;
	if (tail) {
		const at = flat.indexOf(tail, end);
		if (at < 0) return null;
		end = at + tail.length;
	}
	const [from, to] = [chars[start], chars[end - 1]];
	if (!from || !to || (start === 0 && end === flat.length)) return null;
	const range = from.node.ownerDocument.createRange();
	range.setStart(from.node, from.offset);
	range.setEnd(to.node, to.offset + 1);
	return range;
}

/**
 * Text from a table cell, spelled one way. A line break in a cell is `<br>` in the note, and
 * that is how Claudian carries it; the cell's own editor holds a real one.
 */
function cellText(text: string): string {
	return text.replace(/<br\s*\/?>/gi, "\n").replace(/\s+/g, " ").trim();
}

/** Every class this plugin writes starts with this. */
const OWN_CLS_PREFIX = "claudian-enhanced-";

/**
 * Whether a class change touched only this plugin's classes — or anything at all on its own
 * jump button. Compared against the element's classes now, so with several changes to one
 * element in a batch the first record carries all of them and the rest read as no change.
 */
function onlyOwnClassesChanged(record: MutationRecord): boolean {
	const el = record.target;
	if (!(el instanceof Element)) return false;
	if (el.classList.contains(JUMP_BTN_CLS)) return true;
	const before = new Set((record.oldValue ?? "").split(/\s+/).filter(Boolean));
	for (const cls of Array.from(el.classList)) {
		if (!before.delete(cls) && !cls.startsWith(OWN_CLS_PREFIX)) return false;
	}
	for (const cls of before) if (!cls.startsWith(OWN_CLS_PREFIX)) return false;
	return true;
}

/** The page's CSS Custom Highlight registry, where the browser has one. */
/**
 * Whether an element of Claudian's view is on screen. Not just laid out: an inactive tab may be
 * kept laid out here (KEPT_CLS in styles.css), only out of sight.
 */
function onScreen(el: HTMLElement): boolean {
	return el.offsetParent !== null && !el.closest(".claudian-hidden");
}

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
	/** The empty tab open while `lastOpenedPath` is EMPTY_TAB, by leaf id; see leaveForEmptyTab. */
	private emptyLeafId: string | null = null;
	/** The conversation each empty tab was left with, by leaf id — a note's are in `remembered`. */
	private emptyTabConversations = new Map<string, string>();
	/** Which note (or empty tab, see draftKey) each draft tab is for, by Claudian tab id. */
	private readonly draftTabs = new Map<string, string>();
	/** When each Claudian tab was last on screen, by id — for trimTabCache to let go the oldest. */
	private readonly tabShownAt = new Map<string, number>();
	private trimTimer: number | null = null;
	/** A conversation is being loaded in a hidden tab; see preloadOpenNotes. */
	private preloading = false;
	private keepHandle: number | null = null;
	/** Tabs whose conversation has been put on its reading spot, on screen or ahead (keepOne). */
	private readonly laidOut = new WeakSet<ClaudianTab>();
	/** The conversation each Claudian tab held when last looked at, by tab id; see noticeNewSessions. */
	private readonly seenConversations = new Map<string, string | null>();
	/** Session ids read from stored conversations, by conversation id; see sessionIdOf. */
	private readonly storedSessionIds = new Map<string, string>();
	/** Claudian's visibility checks this plugin has corrected, and the originals; see honestVisibility. */
	private readonly visibilityChecks = new Map<{ isVisible?: () => boolean }, () => boolean>();
	private preloadTimer: number | null = null;
	/** Claudian's conversations, each loaded once so their message counts are real; see loadConversationCounts. */
	private conversationCounts: Promise<void> | null = null;
	/** The note whose conversation a veiled view is waiting for (see veilUntilSettled). */
	private veiledFor: string | null = null;
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
	/**
	 * The message list a press is held in, whether it was following the stream when it began,
	 * and where it was scrolled to then (holdStillWhilePressed).
	 */
	private pressed: { list: HTMLElement; following: boolean; top: number } | null = null;
	/** Each message list's jump-to-latest button, made the first time it's needed. */
	private jumpButtons = new WeakMap<HTMLElement, HTMLElement>();
	/** Each message list's outline of its prompts, top left (prompt-nav.ts), made once it has two. */
	private promptNavs = new WeakMap<HTMLElement, PromptNav>();
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
	/** rAF handle for linking a streaming reply's references; see scheduleReplyLinks. */
	private replyLinkFrame: number | null = null;
	/** Puts out what keepLit keeps lit, while something is. */
	private litOff: (() => void) | null = null;
	/** Prompts the reader expanded by hand, which a later pass must not fold back up. */
	private expandedPrompts = new WeakSet<HTMLElement>();
	/** Each menu box quietEmptyMenus took over, and its own render, put back on unload. */
	private quietedMenus = new WeakMap<ClaudianMenuView, NonNullable<ClaudianMenuView["render"]>>();
	/** Prompts the reader collapsed by hand: folded wherever they are, not only while pinned. */
	private collapsedPrompts = new WeakSet<HTMLElement>();
	/** Re-runs the fold pass when the panel resizes, since width changes how text wraps. */
	private foldResizeObserver: ResizeObserver | null = null;
	/**
	 * Notes we can put a conversation back for, most recently visited first. Written when
	 * leaving a note, read when arriving at one; see rememberConversation / conversationFor.
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
	/** What each prompt's tag stands for; see renderSelectionTag. */
	private tagSelections = new WeakMap<HTMLElement, SentSelection>();
	/** Passes in a row that found a prompt not filled in yet; see tagSentSelections. */
	private tagRetries = 0;
	private tagRetryTimer: number | null = null;
	/** Claudian's settings file as last seen (mtime); see followSharedPrompt. */
	private settingsSeenAt = 0;
	/** Pending check that a note switch landed; see verifySoon. */
	private verifyTimer: number | null = null;
	/** Watches Claudian's view for being shown; see watchClaudianVisibility. */
	private visibilityObserver: ResizeObserver | null = null;
	private visibilityWatched: HTMLElement | null = null;
	private claudianShown = false;
	/** Whether the last pass found a prompt not filled in yet, so a reply streaming looks again. */
	private tagsPending = false;
	/** Fresh prompts already tagged from the composer while Claude Code takes the turn. */
	private readonly provisionallyTagged = new WeakSet<HTMLElement>();
	/** Claude Code session files already read for sentSelections, with the mtime read. */
	private readSessions = new Map<string, number>();
	private tagFrame: number | null = null;
	private dedupeFrame: number | null = null;
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
	/** Whether the pointer last rested over Claudian's view; see inClaudian. */
	private pointerOverClaudian = false;
	/** What the pointer is over: a diagram there is what ⌥K refers to when nothing is selected. */
	private pointerTarget: Element | null = null;
	/** Which Claudian view the pointer last rested on; see claudianInUse. */
	private pointerClaudianLeaf: WorkspaceLeaf | null = null;
	/** Outline and the like blanked for a Claudian in a tab; see syncNoteFollowers. */
	private followersBlank = false;
	/** ⌘F in Claudian: find in the conversation; see conversation-find.ts. */
	private readonly find = new ConversationFind(this.app, {
		scroller: () => this.visibleIn<HTMLElement>(this.claudianInUse(), CLAUDIAN_MESSAGES),
		unfold: (prompt) => {
			this.expandedPrompts.add(prompt);
			this.collapsedPrompts.delete(prompt);
			prompt.removeClass(FOLDED_CLS);
			this.releaseSlot(prompt);
			this.syncFoldToggle(prompt, false);
		},
		refocus: () =>
			this.visibleIn<HTMLElement>(this.claudianInUse(), CLAUDIAN_INPUT)?.querySelector<HTMLElement>(".cm-content")?.focus(),
		parentScope: () => (this.claudianInUse()?.view as unknown as { scope?: Scope | null } | undefined)?.scope ?? null,
	});
	/** Each note tab's Claudian status icon; see tab-status.ts. */
	private readonly tabStatus = new NoteTabStatus(
		this.app,
		() => (this.getClaudianLeaf()?.view as unknown as ClaudianStatusSource | undefined) ?? null,
	);
	/** The card a hovered selection chip shows its text in; see selection-peek.ts. */
	private readonly selectionPeek = new SelectionPeek(
		() => this.getClaudianLeaf()?.view.containerEl ?? null,
		() => this.peekForComposer(),
		() => this.visibleInput()?.querySelector<HTMLElement>(".cm-content")?.focus(),
		(tag) => this.peekForTag(tag),
		(selection) => this.openSelection(selection),
	);

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
		// One key, two meanings, picked by where you are: in Claudian (the cursor in it, or
		// the pointer over it — see inClaudian) it starts a new session in the tab, anywhere
		// else it opens a new draft (Drafts), or a new tab like ⌘T without it. Both live here
		// rather than as two bindings of ⌘N because Obsidian runs only the first command bound
		// to a key, whether or not it applies. Core "Create new note" (file-explorer:new-file)
		// must stay unbound in hotkeys.json so it doesn't race us for ⌘N.
		this.addCommand({
			id: "clear-tab",
			// "Claudian" is a proper noun (the plugin's name), so it stays capitalized.
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			name: "New draft, or a new Claudian session when in Claudian",
			checkCallback: (checking: boolean) => {
				if (!this.inClaudian()) {
					if (!checking) {
						const { commands } = this.app as unknown as AppWithCommands;
						if (!commands.executeCommandById(NEW_DRAFT_COMMAND)) {
							commands.executeCommandById(NEW_TAB_COMMAND);
						}
					}
					return true;
				}
				// A Claudian in a tab of its own: a new conversation there, nothing about notes.
				const inUse = this.claudianInUse();
				if (inUse && this.sidebarOf(inUse) === null) {
					const manager = (inUse.view as unknown as { getTabManager?: () => ClaudianTabManager | null }).getTabManager?.();
					const own = manager?.getActiveTab?.();
					if (!manager || !own || own.state?.isStreaming) return false;
					if (!checking) {
						if (own.state?.messages?.length) {
							void manager.createNewConversation?.().then(() => this.unlinkTabChats());
						}
						this.visibleIn<HTMLElement>(inUse, CLAUDIAN_INPUT)?.querySelector<HTMLElement>(".cm-content")?.focus();
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
				const claudianEl = target?.closest(`.workspace-leaf-content[data-type="${CLAUDIAN_VIEW}"]`) ?? null;
				this.pointerOverClaudian = claudianEl !== null;
				this.pointerTarget = target;
				if (claudianEl) {
					this.pointerClaudianLeaf =
						this.app.workspace.getLeavesOfType(CLAUDIAN_VIEW).find((leaf) => leaf.view.containerEl === claudianEl) ?? null;
					if (this.pointerClaudianLeaf && this.sidebarOf(this.pointerClaudianLeaf) === null) this.unlinkTabChats();
				}
				this.markFindScope();
				this.selectionPeek.onPointerOver(target);
			},
			{ capture: true },
		);
		// ⌘F in Claudian finds in the conversation. Sticky Find claims the key for the note,
		// even with focus on <body> — which is where clicking Claudian's messages leaves it — so
		// <body> says whose find it is (data-toolkit-find), and Sticky Find stands aside.
		this.registerDomEvent(document, "focusin", () => {
			this.markFindScope();
			this.unlinkTabChats();
		});
		// A draft can appear without any of the events unlinkTabChats watches (Claudian's own +
		// in its tab bar), but nothing is sent without a key or a click; both land here first.
		this.registerDomEvent(window, "keydown", () => this.unlinkTabChats(), { capture: true });
		this.registerDomEvent(window, "pointerdown", () => this.unlinkTabChats(), { capture: true });
		this.registerDomEvent(
			window,
			"keydown",
			(evt: KeyboardEvent) => {
				// Escape closes the find bar first, wherever focus sits in Claudian (the bar's own
				// input, the composer, <body> after a click in the messages), and goes no further:
				// with a reply running, the next Escape is Claudian's, which stops it.
				if (evt.key === "Escape" && !evt.isComposing && this.find.isOpen) {
					const target = evt.target;
					if (this.find.contains(target) || this.inClaudian() || target === document.body) {
						evt.preventDefault();
						evt.stopImmediatePropagation();
						this.find.close();
					}
					return;
				}
				if (evt.key.toLowerCase() !== "f" || evt.shiftKey || evt.altKey || evt.isComposing) return;
				const primary = Platform.isMacOS ? evt.metaKey : evt.ctrlKey;
				const secondary = Platform.isMacOS ? evt.ctrlKey : evt.metaKey;
				if (!primary || secondary || !(this.inClaudian() || this.find.contains(evt.target))) return;
				evt.preventDefault();
				evt.stopImmediatePropagation();
				const selected = window.getSelection()?.toString().trim() ?? "";
				this.find.open(selected && !selected.includes("\n") ? selected : undefined);
			},
			{ capture: true },
		);
		this.register(() => {
			this.find.close();
			delete document.body.dataset.toolkitFind;
		});
		this.registerDomEvent(document, "mousedown", (e) => this.selectionPeek.onMouseDown(e), { capture: true });
		this.registerDomEvent(document, "click", (e) => this.selectionPeek.onClick(e), { capture: true });
		this.register(() => this.selectionPeek.hide());
		// Escape cancels a live 划词 (see onEscapeCapture). Listened for on window in
		// the capture phase so it runs regardless of where focus currently sits.
		this.registerDomEvent(window, "keydown", this.onEscapeCapture, {
			capture: true,
		});
		this.registerSelectionReference();
		// Text selected in a note comment (Note Comments) goes to Claudian as the 划词 does.
		const comments = new CommentSelection(this.app, {
			tabs: () =>
				this.app.workspace.getLeavesOfType(CLAUDIAN_VIEW).flatMap((leaf) => {
					const manager = (leaf.view as unknown as { getTabManager?: () => ClaudianTabManager | null }).getTabManager?.();
					const tab = manager?.getActiveTab?.();
					return tab ? [tab as unknown as CommentSelectionTab] : [];
				}),
			inClaudian: (el) =>
				this.app.workspace.getLeavesOfType(CLAUDIAN_VIEW).some((leaf) => leaf.view.containerEl.contains(el)),
		});
		this.register(() => comments.destroy());
		this.registerDomEvent(document, "selectionchange", comments.onSelectionChange);
		this.registerDomEvent(window, "pointerdown", comments.onPointerDown, { capture: true });
		this.registerDomEvent(window, "pointerup", comments.onPointerUp, { capture: true });
		this.registerDomEvent(
			window,
			"keydown",
			(e: KeyboardEvent) => {
				if (!this.find.contains(e.target)) comments.onEscape(e);
			},
			{ capture: true },
		);
		// Keep Claudian's conversation in step with the open note without a manual ⌘L:
		// switching notes brings that note's conversation back or starts a fresh one. A
		// file-open alone isn't enough to notice the switch — when the active leaf has been
		// sitting on Claudian's sidebar, Obsidian's active *file* stays frozen and no
		// file-open fires — so leaf changes are watched too. See syncCurrentNoteChip.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.syncNoteFollowers(leaf);
				this.watchClaudianVisibility();
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
			this.app.workspace.on("file-open", () => {
				this.syncCurrentNoteChip();
				this.unlinkTabChats();
				// Obsidian re-opens the last note for them when a tab turns into Claudian in place.
				// After the event: a view opened since this plugin loaded hears it after us.
				window.setTimeout(() => this.syncNoteFollowers(this.app.workspace.getMostRecentLeaf(), true));
			}),
		);
		// Claudian shown any other way than ⌘L — its tab clicked in the sidebar, a layout
		// restored — changes neither the active leaf nor the file; see watchClaudianVisibility.
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.watchClaudianVisibility();
				this.unlinkTabChats();
				// A tab turned into Claudian where it stands (a new tab's question) isn't a leaf change.
				this.syncNoteFollowers(this.app.workspace.getMostRecentLeaf());
				// One Claudian tab per open note (replaceConversationFor): let go of a closed
				// note's, and load ahead the conversations of notes just opened.
				this.scheduleTabTrim();
				this.schedulePreload(PRELOAD_GAP_MS);
			}),
		);
		this.app.workspace.onLayoutReady(() => {
			this.schedulePreload(PRELOAD_START_MS);
			this.scheduleKeep();
		});
		this.app.workspace.onLayoutReady(() => {
			this.watchClaudianVisibility();
			this.syncNoteFollowers(this.app.workspace.getMostRecentLeaf());
		});
		this.register(() => this.visibilityObserver?.disconnect());
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
		this.holdStillWhilePressed();
		// Cold-start fix. Claudian restores its last conversation together with *that
		// conversation's* note, and a sent conversation is locked to it — so it stays on the
		// old note even though a different note is open now, and the active-leaf sync above
		// is a no-op (the open note is already active, so nothing changes). When the restored
		// note genuinely mismatches the open note, treat it as arriving from that note: this
		// note gets its own conversation back, or a fresh one that links the note we
		// actually have open. We fire only on a real mismatch so a restart never discards a
		// conversation whose note already matches. See reconcileChipOnStartup.
		// The system prompt is shared between vaults (scripts/sync-vaults.mjs) and devices
		// (iCloud); carry a prompt changed on disk into the running Claudian.
		this.app.workspace.onLayoutReady(() => {
			void this.followSharedPrompt(true);
			this.registerInterval(window.setInterval(() => void this.followSharedPrompt(false), SETTINGS_POLL_MS));
		});
		// The view observer shows a session id as the conversation changes, but the id can land
		// after the reply's last mutation; see syncSessionIds.
		this.registerInterval(
			window.setInterval(() => {
				this.syncSessionIds();
				this.quietEmptyMenus();
				this.noticeNewSessions();
				// The sidebar's draft for a chat in front is swapped in without an event of its own.
				this.unlinkTabChats();
			}, SESSION_ID_POLL_MS),
		);
		// Note tabs show how their conversations are doing. A turn starting, waiting or ending
		// changes nothing in the workspace, so a slow look covers those; tabs coming and going
		// are caught as they happen.
		this.app.workspace.onLayoutReady(() => this.tabStatus.sync());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.tabStatus.sync()));
		this.registerInterval(window.setInterval(() => this.tabStatus.sync(), TAB_STATUS_POLL_MS));
		this.register(() => this.tabStatus.clear());
		this.registerInterval(window.setInterval(() => this.syncStopButtons(), STOP_POLL_MS));
		this.app.workspace.onLayoutReady(() => {
			this.reconcileChipOnStartup(Date.now() + 8000);
		});
	}

	onunload(): void {
		// Stops every focus loop and veil/restore pass still running against this instance.
		this.gen++;
		this.litOff?.();
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		if (this.tagRetryTimer !== null) window.clearTimeout(this.tagRetryTimer);
		if (this.verifyTimer !== null) window.clearTimeout(this.verifyTimer);
		if (this.trimTimer !== null) window.clearTimeout(this.trimTimer);
		if (this.preloadTimer !== null) window.clearTimeout(this.preloadTimer);
		if (this.keepHandle !== null) window.clearTimeout(this.keepHandle);
		this.dropKept();
		for (const [presentation, original] of this.visibilityChecks) presentation.isVisible = original;
		this.visibilityChecks.clear();
		for (const frame of [this.pinnedFrame, this.foldFrame, this.tagFrame, this.replyLinkFrame]) {
			if (frame !== null) cancelAnimationFrame(frame);
		}
		this.pinnedPrompt?.style.removeProperty("transform");
		// Composers of background tabs sit outside the view, so their labels go tab by tab.
		for (const tab of this.allClaudianTabs()) {
			tab.dom?.infoRowEl?.querySelector(`:scope > .${SESSION_ID_CLS}`)?.remove();
			tab.dom?.inputWrapper?.querySelector(`.${STOP_BTN_CLS}`)?.remove();
			const menu = tab.ui?.composerDropdown?.controller?.view;
			const render = menu && this.quietedMenus.get(menu);
			if (menu && render) menu.render = render;
		}
		// Leave Claudian's view as it draws itself: what we added goes, what we marked is unmarked.
		const view = this.getClaudianLeaf()?.view.containerEl;
		if (!view) return;
		view.querySelectorAll(`.${FOLD_TOGGLE_CLS}, .${JUMP_BTN_CLS}, .${SELECTION_TAG_CLS}`).forEach((el) => el.remove());
		view.querySelectorAll<HTMLElement>(CLAUDIAN_MESSAGES).forEach((list) => this.promptNavs.get(list)?.destroy());
		view.querySelectorAll<HTMLElement>(`.${REFERENCE_CLS}`).forEach((el) => el.replaceWith(el.dataset.source ?? ""));
		const marks = [PINNED_CLS, BURIED_CLS, FOLDABLE_CLS, FOLDED_CLS, VEILED_CLS, RESTORING_CLS];
		for (const el of [view, ...Array.from(view.querySelectorAll<HTMLElement>(marks.map((cls) => `.${cls}`).join(", ")))]) {
			el.removeClasses(marks);
		}
	}

	/** Tell Sticky Find whose ⌘F it is: see the keydown handler in onload. */
	private markFindScope(): void {
		const scope = this.inClaudian() ? "claudian" : "";
		if ((document.body.dataset.toolkitFind ?? "") === scope) return;
		if (scope) document.body.dataset.toolkitFind = scope;
		else delete document.body.dataset.toolkitFind;
	}

	/**
	 * Ask Claudian `text` from an empty tab: Quick Open's new-tab search hands a query over
	 * here (its "Ask Claudian" row). Claudian comes out holding the empty tab's own
	 * conversation — the one asked in this tab before, or a fresh one (leaveForEmptyTab) —
	 * and the question goes into its composer and is sent as Enter sends it. Reports whether
	 * it was sent; not when Claudian isn't there, or never settled on that conversation.
	 */
	async ask(text: string, options?: { leaf?: WorkspaceLeaf }): Promise<boolean> {
		const prompt = text.trim();
		if (!prompt) return false;
		if (options?.leaf) return this.askInTab(options.leaf, prompt);
		const gen = ++this.gen;
		const leaf = this.getClaudianLeaf();
		if (!leaf || !this.isLeafVisible(leaf)) this.openClaudian(gen);
		else {
			if (this.onEmptyTab()) this.leaveForEmptyTab();
			this.stickyFocusInput(Date.now() + 1500, gen);
		}
		const tab = await this.tabForAsking(Date.now() + ASK_SETTLE_MS);
		const input = tab?.dom?.inputEl;
		const send = tab?.controllers?.inputController?.sendMessage;
		if (!tab || !input || typeof send !== "function") return false;
		input.value = prompt;
		await send.call(tab.controllers?.inputController);
		return true;
	}

	/**
	 * Ask in a tab of its own, the way ChatGPT's home page turns into the conversation: the
	 * empty tab the question was typed in becomes a Claudian chat filling the main area, and
	 * the question is sent there. The sidebar's Claudian is left as it was, still following
	 * notes; this one is a conversation of its own (getClaudianLeaf leaves it out).
	 */
	private async askInTab(leaf: WorkspaceLeaf, prompt: string): Promise<boolean> {
		const tab = await this.becomeChat(leaf);
		const input = tab?.dom?.inputEl;
		const send = tab?.controllers?.inputController?.sendMessage;
		if (!tab || !input || typeof send !== "function") return false;
		this.unlinkTabChats();
		const before = tab.state?.messages?.length ?? 0;
		input.value = prompt;
		// The next question is typed there: the composer holds focus, as the sidebar's does
		// after ⌘L, rather than the chat's root that Claudian focuses after rendering.
		this.stickyFocusInput(Date.now() + 1500, ++this.gen, leaf);
		await send.call(tab.controllers?.inputController);
		// Sent means in the conversation, not just handed over.
		return (tab.state?.messages?.length ?? 0) > before;
	}

	/**
	 * Claudian's own composer suggestion sources — `/` for commands and skills, `@` for notes
	 * and sessions — for Quick Open's new-tab search to offer while a question is typed there,
	 * the same lists Claudian's composer opens. From the sidebar Claudian's active tab; null
	 * until it has one. Each takes the text and caret and says what to offer and insert.
	 */
	composerSources(): unknown[] | null {
		const dropdown = this.getActiveTab()?.ui?.composerDropdown;
		const sources = [dropdown?.slashSource, dropdown?.mentionSource].filter((source) => source !== undefined);
		return sources.length > 0 ? sources : null;
	}

	/**
	 * Turn `leaf` into a Claudian chat filling the main area and wait for its active tab to take
	 * a turn; null if it doesn't by the deadline.
	 */
	private async becomeChat(leaf: WorkspaceLeaf): Promise<ClaudianTab | null> {
		await leaf.setViewState({ type: CLAUDIAN_VIEW, active: true });
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		const deadline = Date.now() + ASK_SETTLE_MS;
		return new Promise<ClaudianTab | null>((resolve) => {
			const look = (): void => {
				const manager = (leaf.view as unknown as { getTabManager?: () => ClaudianTabManager | null }).getTabManager?.();
				const active = manager?.getActiveTab?.() ?? null;
				const controller = active?.controllers?.inputController;
				// Mounted is not enough: a view just made doesn't take a turn yet, and its send
				// returns without a word — the question was dropped and the box emptied anyway.
				const ready =
					active?.dom?.inputEl &&
					typeof controller?.sendMessage === "function" &&
					controller.deps?.canStartTurn?.() !== false;
				if (ready) resolve(active);
				else if (Date.now() > deadline) resolve(null);
				else window.setTimeout(look, 50);
			};
			look();
		});
	}

	/**
	 * Claudian's active tab once it holds the conversation an empty tab asks in — its own, or
	 * a fresh draft — loaded; null if that doesn't happen by `deadline`. Swapping the
	 * conversation in is asynchronous, as is mounting a Claudian opened just now. A reply still
	 * running in it is no reason to wait: the question queues behind it, as one typed would.
	 */
	private tabForAsking(deadline: number): Promise<ClaudianTab | null> {
		return new Promise((resolve) => {
			const look = (): void => {
				const tab = this.getActiveTab();
				const wanted = this.onEmptyTab() ? this.conversationFor(EMPTY_TAB) : (tab?.conversationId ?? null);
				const ready =
					tab !== null &&
					(!this.onEmptyTab() || this.lastOpenedPath === EMPTY_TAB) &&
					(tab.conversationId ?? null) === wanted &&
					tab.hydrationState !== "loading";
				if (ready) resolve(tab);
				else if (Date.now() > deadline) resolve(null);
				else window.setTimeout(look, 50);
			};
			look();
		});
	}

	/**
	 * Whether clear-tab's key is meant for Claudian: the cursor is in it (typing in its
	 * composer, with the pointer resting anywhere), or the pointer is over it (clicking a
	 * sidebar leaves focus on <body>, so focus alone would miss a click into its messages).
	 */
	private inClaudian(): boolean {
		const focused = document.activeElement;
		const holdsFocus = this.app.workspace
			.getLeavesOfType(CLAUDIAN_VIEW)
			.some((leaf) => !!focused && leaf.view.containerEl.contains(focused));
		return holdsFocus || this.pointerOverClaudian;
	}

	/**
	 * ⌥K (bound in the vault's hotkeys), as in Claude Code's VS Code extension: the note's
	 * selection goes into Claudian's composer as a reference, `@path#first-last`, on a line of
	 * its own at the end, for what to do about it to follow. Several in one prompt review
	 * several passages in one go; Claude reads the lines from the note.
	 *
	 * Diagrams too: a Mermaid diagram is its code block's lines, an Excalidraw drawing its
	 * file — narrowed to the line a label is on when one is selected, in the note or in the
	 * zoom; else the one in the zoom, or under the pointer. In Excalidraw's own view, the
	 * selected elements' text, each on its line of the drawing file.
	 */
	private registerSelectionReference(): void {
		this.addCommand({
			id: "insert-selection-reference",
			name: "Insert a reference to the selection into the composer",
			checkCallback: (checking) => {
				const pending = this.selectedReference();
				if (checking) return pending !== null;
				void pending?.then((references) => this.insertReference(references));
				return true;
			},
		});
	}

	/** What ⌥K refers to (see registerSelectionReference), worked out; null for nothing. */
	private selectedReference(): Promise<NoteReference[]> | null {
		const selection = document.getSelection();
		const text = selection && !selection.isCollapsed ? selectionText(selection).trim() : "";
		const anchor = selection?.anchorNode;
		const anchorEl = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
		// A diagram in the zoom: the text selected in it, else the whole of it.
		const zoomed = Array.from(document.querySelectorAll<HTMLElement>("[data-zoom-path]")).find((el) => el.checkVisibility());
		if (zoomed) return this.diagramReference(zoomed, text && anchorEl && zoomed.contains(anchorEl) ? text : null);
		const drawing = this.selectedDrawingElements();
		if (drawing) return drawing;
		// A label selected in a diagram in the note.
		if (text && anchorEl && this.diagramSourceOf(anchorEl)) return this.diagramReference(anchorEl, text);
		const lines = this.selectedLines();
		if (lines) return Promise.resolve([lines]);
		// Nothing selected: the diagram under the pointer.
		const under = this.pointerTarget?.isConnected ? this.pointerTarget : null;
		return under && this.diagramSourceOf(under) ? this.diagramReference(under, null) : null;
	}

	/**
	 * What a diagram shown at `element` is drawn from: the zoom says it (ZoomSource in
	 * shared/zoom-overlay.ts); in a note, a Mermaid diagram is its code block's lines, fences
	 * included, and an Excalidraw embed is its drawing's file (no lines).
	 */
	private diagramSourceOf(element: Element): DiagramSource | null {
		if (!element.closest("[data-zoom-path], .excalidraw-embedded-img, .mermaid")) return null;
		const zoomed = element.closest<HTMLElement>("[data-zoom-path]");
		if (zoomed?.dataset.zoomPath) {
			return { path: zoomed.dataset.zoomPath, from: Number(zoomed.dataset.zoomFrom ?? 0), to: Number(zoomed.dataset.zoomTo ?? 0) };
		}
		let view: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!view && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(element)) view = leaf.view;
		});
		const note = (view as MarkdownView | null)?.file;
		if (!view || !note) return null;
		const embed = element.closest(".excalidraw-embedded-img");
		if (embed) {
			const name = embed.closest("[filesource]")?.getAttribute("filesource") ?? embed.closest(".internal-embed")?.getAttribute("src");
			if (!name) return null;
			const file =
				this.app.vault.getFileByPath(name) ??
				this.app.vault.getFileByPath(`${name}.md`) ??
				this.app.metadataCache.getFirstLinkpathDest(name.split("#")[0] ?? "", note.path);
			return file ? { path: file.path, from: 0, to: 0 } : null;
		}
		const diagram = element.closest(".mermaid");
		if (!diagram) return null;
		let start: number | null = null;
		// Reading view: Mermaid (Enhanced) stamps the block with its first line (0-based).
		const stamped = diagram.closest("[data-mermaid-line]")?.getAttribute("data-mermaid-line");
		if (stamped) start = Number(stamped) + 1;
		const cm = this.cmOf((view as MarkdownView).leaf);
		const block = diagram.closest(".cm-embed-block, .cm-preview-code-block");
		if (start === null && cm && block && cm.contentDOM.contains(block)) {
			try {
				start = cm.state.doc.lineAt(cm.posAtDOM(block)).number;
			} catch {
				return null;
			}
		}
		if (start === null) return null;
		const lines = (view as MarkdownView).data.split("\n");
		const fence = fenceAround(lines, start);
		return fence ? { path: note.path, ...fence } : null;
	}

	/**
	 * The reference for the diagram shown at `element`, narrowed to where `text` (a label
	 * selected in it) is: a line of the code block, a line of the drawing's text elements.
	 */
	private async diagramReference(element: Element, text: string | null): Promise<NoteReference[]> {
		const source = this.diagramSourceOf(element);
		if (!source) return [];
		const whole: NoteReference = { path: source.path, start: source.from, end: source.to };
		if (!text) return [whole];
		const file = this.app.vault.getFileByPath(source.path);
		if (!file) return [whole];
		const content = this.openText(source.path) ?? (await this.app.vault.cachedRead(file));
		const lines = content.split("\n");
		const lineText = (n: number): string => lines[n - 1] ?? "";
		// Within the code block; in a drawing, its text elements (the rest is its scene, compressed).
		const range = source.from
			? { from: offsetOfLine(lines, source.from), to: offsetOfLine(lines, source.to + 1) }
			: textElementsRange(content);
		const found = range ? locateText(content.slice(range.from, range.to), text) : null;
		if (!range || !found) return [{ ...whole, quote: text }];
		const start = lineAtOffset(content, range.from + found.from);
		const end = lineAtOffset(content, range.from + found.to);
		return [describe({ path: source.path, start, end }, lineText, text, null)];
	}

	/**
	 * The elements selected in the active Excalidraw view, each with text as the line of the
	 * drawing file it is kept on (`text ^id`, under `## Text Elements`); a shape by the text
	 * bound to it. None with text: the drawing. Null outside Excalidraw's view.
	 */
	private selectedDrawingElements(): Promise<NoteReference[]> | null {
		const view = this.app.workspace.getActiveViewOfType(TextFileView) as (TextFileView & ExcalidrawViewLike) | null;
		if (!view?.file || view.getViewType() !== "excalidraw") return null;
		const file = view.file;
		const selected = view.getViewSelectedElements?.() ?? [];
		const all = new Map((view.getViewElements?.() ?? []).map((element) => [element.id, element]));
		const texts = new Map<string, string>();
		for (const element of selected) {
			if (element.type === "text" && element.text) texts.set(element.id, element.text);
			for (const bound of element.boundElements ?? []) {
				const label = bound.type === "text" ? all.get(bound.id)?.text : undefined;
				if (label) texts.set(bound.id, label);
			}
		}
		return this.app.vault.cachedRead(file).then((content) => {
			const lines = content.split("\n");
			const references: NoteReference[] = [];
			for (const [id, text] of texts) {
				const line = lines.findIndex((l) => l.endsWith(` ^${id}`)) + 1;
				// Not saved there yet: the drawing, with the text to find.
				references.push(line ? { path: file.path, start: line, end: line, quote: text } : { path: file.path, start: 0, end: 0, quote: text });
			}
			return references.length > 0 ? references : [{ path: file.path, start: 0, end: 0 }];
		});
	}

	/** An open note's text as it is in its editor, which may be ahead of the file. */
	private openText(path: string): string | null {
		let text: string | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (text === null && leaf.view instanceof MarkdownView && leaf.view.file?.path === path) text = leaf.view.data;
		});
		return text;
	}

	/**
	 * What's selected in the active note, as a reference: the editor's selection; else text
	 * selected where the editor doesn't hold it — a table cell's own editor, cells of a rendered
	 * table, a callout, reading view — found among the lines it came from.
	 */
	private selectedLines(): NoteReference | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return null;
		const path = view.file.path;
		const cm = view.getMode() === "source" ? this.cmOf(view.leaf) : null;
		const selection = view.containerEl.ownerDocument.getSelection();
		if (!cm) {
			const text = selection ? selectionText(selection).trim() : "";
			if (!text || !selection?.anchorNode || !view.containerEl.contains(selection.anchorNode)) return null;
			const found = locateText(view.data, text);
			if (!found) return null;
			const lines = view.data.split("\n");
			const lineAt = (offset: number): number => view.data.slice(0, offset).split("\n").length;
			const at = { path, start: lineAt(found.from), end: lineAt(found.to) };
			return describe(at, (n) => lines[n - 1] ?? "", text, columnsOf(selection));
		}
		const doc = cm.state.doc;
		const lineText = (n: number): string => doc.line(n).text;
		const cells = this.tableCellSelection();
		// Cells picked out by class, rows and columns: the columns say which, no text needed.
		const byCells = (start: number, count: number): NoteReference => {
			const end = Math.min(start + Math.max(0, count - 1), doc.lines);
			return describe({ path, start, end }, lineText, null, this.selectedCellColumns(cm));
		};
		// Ahead of what a cell's own editor has selected when they're more than the one: a drag
		// across cells starts in one, whose editor keeps its text selected, and the reference was
		// to that cell alone.
		if (cells?.startLine && this.selectedCellCount(cm) > 1) return byCells(cells.startLine, cells.lineCount);
		const cell = this.cellEditorSelection(cm);
		if (cell) return describe({ path, start: cell.line, end: cell.line }, lineText, cell.text, columnsOf(selection));
		const main = cm.state.selection.main;
		const selected = doc.sliceString(main.from, main.to);
		if (selected.trim()) {
			// Blank lines at either end are no part of the passage.
			const from = main.from + (selected.length - selected.trimStart().length);
			const to = main.to - (selected.length - selected.trimEnd().length);
			const [first, last] = [doc.lineAt(from), doc.lineAt(to)];
			const columns: [number, number] = [columnAt(first.text, from - first.from), columnAt(last.text, to - last.from)];
			return describe({ path, start: first.number, end: last.number }, lineText, doc.sliceString(from, to), columns);
		}
		if (cells?.startLine) return byCells(cells.startLine, cells.lineCount);
		const block = this.selectionInRenderedBlock();
		if (!block?.startLine || !block.selectedText.trim()) return null;
		const first = doc.line(Math.min(block.startLine, doc.lines));
		const last = doc.line(Math.min(block.startLine + Math.max(0, block.lineCount - 1), doc.lines));
		// Narrowed to the lines the text is on, where it can be found among them.
		const found = locateText(doc.sliceString(first.from, last.to), block.selectedText);
		const at = found
			? { path, start: doc.lineAt(first.from + found.from).number, end: doc.lineAt(first.from + found.to).number }
			: { path, start: first.number, end: last.number };
		return describe(at, lineText, block.selectedText.trim(), columnsOf(selection));
	}

	/**
	 * Text selected in the Live Preview table cell whose own editor — the one nested in the
	 * table widget while a cell is edited — has focus, and the line of its row.
	 */
	private cellEditorSelection(cm: EditorView): { line: number; text: string } | null {
		const anchor = cm.dom.ownerDocument.getSelection()?.anchorNode;
		const element = anchor instanceof Element ? anchor : anchor?.parentElement;
		const inner = element?.closest<HTMLElement>(".cm-table-widget .cm-editor");
		const table = inner?.closest<HTMLElement>(".cm-table-widget");
		const cell = inner?.closest<HTMLTableCellElement>("td, th");
		if (!inner || !table || !cell || !cm.contentDOM.contains(table)) return null;
		const nested = EditorView.findFromDOM(inner);
		const main = nested?.state.selection.main;
		const text = main ? nested?.state.sliceDoc(main.from, main.to).trim() : "";
		if (!nested?.hasFocus || !text) return null;
		let pos: number;
		try {
			pos = cm.posAtDOM(table);
		} catch {
			return null;
		}
		// Row 0 is the header; the delimiter line under it isn't a row of the table.
		const row = (cell.parentElement as HTMLTableRowElement).rowIndex;
		return { line: Math.min(cm.state.doc.lineAt(pos).number + (row === 0 ? 0 : row + 1), cm.state.doc.lines), text };
	}

	/**
	 * The columns of the cells selected by class in a Live Preview table (see
	 * tableCellSelection); null for whole rows, which need no columns named.
	 */
	private selectedCellCount(cm: EditorView): number {
		return cm.contentDOM.querySelectorAll(".cm-table-widget.has-selection:not(.is-selected) :is(th, td).is-selected").length;
	}

	private selectedCellColumns(cm: EditorView): [number, number] | null {
		const table = cm.contentDOM.querySelector<HTMLElement>(".cm-table-widget.has-selection:not(.is-selected)");
		const columns = Array.from(table?.querySelectorAll<HTMLTableCellElement>("th.is-selected, td.is-selected") ?? []).map(
			(cell) => cell.cellIndex,
		);
		if (columns.length === 0) return null;
		const [from, to] = [Math.min(...columns), Math.max(...columns)];
		const width = table?.querySelector("tr")?.cells.length ?? 0;
		return from === 0 && to >= width - 1 ? null : [from, to];
	}

	/** Put the references at the end of Claudian's composer, and go type there. */
	private async insertReference(selected: NoteReference[]): Promise<void> {
		if (selected.length === 0) return;
		const reference = selected.map(referenceText).join(" ");
		// The selection is let go of: the reference stands for it, and Claudian would carry it
		// into the prompt as well.
		const cm = this.cmOf(this.getNoteLeaf());
		for (const view of [cm, cm && this.focusedCellEditor(cm)]) {
			const main = view?.state.selection.main;
			if (view && main && !main.empty) view.dispatch({ selection: { anchor: main.head } });
		}
		const gen = ++this.gen;
		const leaf = this.getClaudianLeaf();
		if (!leaf || !this.isLeafVisible(leaf)) this.openClaudian(gen);
		const tab = leaf && this.isLeafVisible(leaf) ? this.getActiveTab() : await this.tabForAsking(Date.now() + ASK_SETTLE_MS);
		// Shown is not ready: just after Obsidian starts, Claudian is on screen before its composer
		// is mounted, and the reference was turned away as if it weren't open at all.
		const input = composerOf(tab) ?? (await this.composerReady(Date.now() + ASK_SETTLE_MS));
		if (!input) {
			new Notice("Claudian isn't open.");
			return;
		}
		const value = input.value;
		// At the end, wherever the caret is: the passages and what's said about each read in the
		// order they were taken. On a line of its own after what's written: each gets its own say.
		const head = value.replace(/[ \t]+$/, "");
		const text = `${head.trim() && !head.endsWith("\n") ? "\n" : ""}${reference} `;
		// As typed: Claudian's composer takes it as input, its caret after it.
		input.replaceText(head.length, value.length, text);
		const box = input.getAccessibleTextbox?.() ?? input;
		box.focus();
		this.holdComposerFocus(box);
		this.getSelectionController()?.clear?.();
	}

	/**
	 * Keep the focus in the composer for a moment after ⌥K put it there. From a Live Preview
	 * table cell the note took it back: the cell's editor, let go of, writes the cell into the
	 * note and the table is drawn again with that cell being edited — the reference landed, and
	 * the cursor was left in the table. A press or a key of the user's own ends the hold.
	 */
	private holdComposerFocus(box: HTMLElement): void {
		const doc = box.ownerDocument;
		const note = this.cmOf(this.getNoteLeaf())?.dom ?? null;
		const back = (e: FocusEvent): void => {
			if (note && e.target instanceof Node && note.contains(e.target)) box.focus();
		};
		const stop = (): void => {
			window.clearTimeout(timer);
			doc.removeEventListener("focusin", back, true);
			doc.removeEventListener("pointerdown", stop, true);
			doc.removeEventListener("keydown", stop, true);
		};
		doc.addEventListener("focusin", back, true);
		doc.addEventListener("pointerdown", stop, true);
		doc.addEventListener("keydown", stop, true);
		const timer = window.setTimeout(stop, COMPOSER_FOCUS_HOLD_MS);
	}

	/** The active tab's composer once it can take text, or null if not by `deadline`. */
	private composerReady(deadline: number): Promise<ReadyComposer | null> {
		return new Promise((resolve) => {
			const look = (): void => {
				const input = composerOf(this.getActiveTab());
				if (input) resolve(input);
				else if (Date.now() > deadline) resolve(null);
				else window.setTimeout(look, 50);
			};
			look();
		});
	}

	/** The editor of the Live Preview table cell being edited in `cm`, if it has focus. */
	private focusedCellEditor(cm: EditorView): EditorView | null {
		const active = cm.dom.ownerDocument.activeElement;
		const inner = active?.closest<HTMLElement>(".cm-table-widget .cm-editor");
		const nested = inner && cm.contentDOM.contains(inner) ? EditorView.findFromDOM(inner) : null;
		return nested?.hasFocus ? nested : null;
	}

	private onEscapeCapture = (e: KeyboardEvent): void => {
		if (e.key !== "Escape" || e.isComposing) return;
		// The find bar's Escape closes the bar, and leaves focus in Claudian.
		if (this.find.contains(e.target)) return;
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
			const swapping = this.catchUpBeforeShow();
			void this.app.workspace.revealLeaf(existing).then(() => {
				this.returnToSpot(false);
				if (swapping) this.liftVeilWhenSettled(existing.view.containerEl);
			});
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
	 * Before ⌘L shows Claudian, put the open note's conversation in it — when what it holds
	 * is the conversation of a note left while it was hidden. Shown first and caught up by
	 * the sync after (which waits out keepNoteActive, most of a second), that other
	 * conversation was on screen until the swap; a note with none flashed someone else's
	 * history before its fresh one. Swapped while still hidden, and veiled until it lands,
	 * the note's own conversation — or a fresh one — is the first thing shown.
	 *
	 * Reports whether a swap was started. Needs Claudian mounted: never opened this session,
	 * it has no conversation to show yet, and its own restore is reconciled on startup.
	 */
	private catchUpBeforeShow(): boolean {
		if (this.onEmptyTab() && this.claudianMounted()) {
			this.leaveForEmptyTab();
			return false;
		}
		const path = this.activeNotePath();
		if (!path || !this.claudianMounted()) return false;
		// First show this session: the conversation Claudian restored belongs to the note it
		// is linked to, as reconcileChipOnStartup reads it.
		if (this.lastOpenedPath === null) this.lastOpenedPath = this.linkedNotePath();
		if (this.lastOpenedPath === null || this.lastOpenedPath === path) return false;
		this.veilUntilSettled(path, false);
		this.lastSyncedPath = path;
		this.handleNoteChange(path);
		return true;
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
	private stickyFocusInput(deadline: number, gen: number, leaf?: WorkspaceLeaf): void {
		const settleMs = 150;
		let heldSince = 0;

		const tick = (): void => {
			if (gen !== this.gen) return; // superseded by a newer ⌘L
			// The sidebar's composer, or that of a Claudian in a tab of its own.
			const input = leaf ? this.visibleIn<HTMLElement>(leaf, CLAUDIAN_INPUT) : this.visibleInput();
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
		// Claudian or Outline, the sidebar shows what you last chose; switching notes leaves it be.
		const claudianLeaf = this.getClaudianLeaf();
		if (!claudianLeaf || !this.isLeafVisible(claudianLeaf)) {
			// Hidden/absent → the ⌘L reveal path refreshes on next open; forget state so
			// the next real switch is treated as a change.
			this.lastSyncedPath = null;
			return;
		}
		if (this.onEmptyTab()) {
			this.leaveForEmptyTab();
			return;
		}
		const path = this.activeNotePath();
		// Synced already — unless the conversation is still another note's.
		if (!path || (path === this.lastSyncedPath && path === this.lastOpenedPath)) return;
		this.lastSyncedPath = path;
		this.handleNoteChange(path);
	}

	/**
	 * Take a system prompt changed in Claudian's settings file from outside — the vault sync,
	 * or iCloud bringing another device's — into the running Claudian. Claudian reads the file
	 * only at startup and writes what it holds whenever it saves a setting, so a prompt written
	 * under it was put back to the old one at its next save, and the sync then carried the old
	 * one back to the other vaults. Only the prompt: the rest of the file is this vault's own.
	 * The first look just notes the file, which Claudian has read itself.
	 */
	private async followSharedPrompt(first: boolean): Promise<void> {
		const adapter = this.app.vault.adapter;
		const stat = await adapter.stat(CLAUDIAN_SETTINGS_FILE).catch(() => null);
		if (!stat || stat.mtime === this.settingsSeenAt) return;
		this.settingsSeenAt = stat.mtime;
		if (first) return;
		const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
		const claudian = plugins?.realclaudian as { settings?: { systemPrompt?: unknown } } | undefined;
		if (!claudian?.settings) return;
		let prompt: unknown;
		try {
			prompt = (JSON.parse(await adapter.read(CLAUDIAN_SETTINGS_FILE)) as { systemPrompt?: unknown }).systemPrompt;
		} catch {
			return; // mid-write, or not JSON: the next look will tell
		}
		if (typeof prompt !== "string" || prompt === claudian.settings.systemPrompt) return;
		claudian.settings.systemPrompt = prompt;
		console.debug("Claudian (Enhanced): took the system prompt changed on disk");
	}

	/**
	 * Catch up when Claudian comes into view by any means. Notes switched while Outline (or
	 * any other sidebar tab) was showing left Claudian alone, and the switch waits until
	 * Claudian is back — but only ⌘L ran that catch-up. Clicking Claudian's tab in the sidebar fires no
	 * active-leaf-change and no file-open, so the last note's conversation stayed on screen
	 * under this one: the recurring "Claudian shows another note's session". Its view going
	 * from hidden to shown is watched directly (a hidden sidebar tab is display:none, so its
	 * size changes), and that is a sync like any other.
	 */
	private watchClaudianVisibility(): void {
		const leaf = this.getClaudianLeaf();
		const el = leaf?.view.containerEl ?? null;
		if (!leaf || !el || el === this.visibilityWatched) return;
		this.visibilityObserver?.disconnect();
		this.visibilityWatched = el;
		this.claudianShown = this.isLeafVisible(leaf);
		this.visibilityObserver = new ResizeObserver(() => {
			const current = this.getClaudianLeaf();
			const shown = !!current && this.isLeafVisible(current);
			if (shown && !this.claudianShown) {
				this.lastSyncedPath = null;
				this.scheduleChipSync();
				this.scheduleKeep();
			} else if (!shown && this.claudianShown) {
				this.dropKept();
			}
			this.claudianShown = shown;
		});
		this.visibilityObserver.observe(el);
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
		// Which conversation the note wants is looked up once per note, not on every frame.
		let wantFor: string | null | undefined;
		let want: string | null = null;
		const settle = (): void => {
			if (!container.hasClass(VEILED_CLS)) return;
			if (this.veiledFor !== wantFor) {
				wantFor = this.veiledFor;
				want = wantFor === null || wantFor === undefined ? null : this.conversationFor(wantFor);
			}
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
		this.verifySoon(path);
		// First note we've seen (fresh load, or Claudian just appeared): there is no
		// previous conversation to clear.
		if (previous !== null && previous !== path) {
			this.saveScrollSpot();
			if (previous === EMPTY_TAB) this.rememberEmptyTabConversation();
			else this.rememberConversation(previous);
			if (this.replaceConversationFor(path)) return;
		}
		this.followNoteInDraft(path);
	}

	/**
	 * The tab open in the main area when it holds no note: an empty one — "New tab", no file in
	 * it — or a Claudian chat of its own (askInTab), which an empty tab becomes when asked in.
	 * The sidebar's Claudian treats both alike, showing that tab's draft rather than the last
	 * note's conversation, which Obsidian's active file still names.
	 */
	private emptyTab(): WorkspaceLeaf | null {
		const recent = this.app.workspace.getMostRecentLeaf();
		const type = recent?.view.getViewType();
		if ((type !== "empty" && type !== CLAUDIAN_VIEW) || !recent || this.sidebarOf(recent) !== null) return null;
		return recent;
	}

	private onEmptyTab(): boolean {
		return this.emptyTab() !== null;
	}

	/** Files the conversation on screen under the empty tab it was had in. */
	private rememberEmptyTabConversation(): void {
		const conversationId = this.getActiveTab()?.conversationId;
		if (this.emptyLeafId && conversationId) this.emptyTabConversations.set(this.emptyLeafId, conversationId);
	}

	/**
	 * An empty tab has no note, so the conversation on screen is filed under the note it
	 * belongs to and Claudian shows the empty tab's own: the one last had in that tab, or a
	 * fresh start. Back at the note, handleNoteChange brings its conversation back — it reads
	 * EMPTY_TAB as having come from elsewhere, and files the empty tab's by the tab's leaf
	 * (it belongs to no note). Held for this session only: an empty tab doesn't outlive it.
	 */
	private leaveForEmptyTab(): void {
		const leafId = (this.emptyTab() as unknown as { id?: string } | null)?.id ?? null;
		const previous = this.lastOpenedPath;
		if (previous === EMPTY_TAB && leafId === this.emptyLeafId) return;
		if (previous === EMPTY_TAB) this.rememberEmptyTabConversation();
		this.lastOpenedPath = EMPTY_TAB;
		this.emptyLeafId = leafId;
		this.lastSyncedPath = null;
		if (previous) {
			this.saveScrollSpot();
			this.rememberConversation(previous);
		}
		this.replaceConversationFor(EMPTY_TAB);
		this.unlinkTabChats();
	}

	/**
	 * Put `path`'s conversation on screen — its own, or a draft for it — keeping the one it
	 * replaces in its own tab. Claudian (Enhanced) keeps one Claudian tab per open note, the
	 * tab strip hidden: going back to a note whose tab is still there only shows that tab,
	 * read where it was left, with nothing to load or re-render. A conversation no tab holds
	 * opens in a new one; a note with none gets its draft tab, or a new one. Tabs for notes
	 * no longer open, and the least recently shown past TAB_CACHE_LIMIT, are let go
	 * (trimTabCache); conversations opened in advance are the preload (preloadOpenNotes).
	 * Whether a switch was set off; a running reply is never in the way, as it keeps its tab.
	 */
	private replaceConversationFor(path: string): boolean {
		const manager = this.getTabManager();
		if (!manager) return false;
		const conversationId = this.conversationFor(path);
		return conversationId ? this.showConversation(manager, path, conversationId) : this.showDraft(manager, path);
	}

	/** Show `conversationId` for `path`: its tab if one holds it, else a new tab it loads into. */
	private showConversation(manager: ClaudianTabManager, path: string, conversationId: string): boolean {
		if (typeof manager.openConversation !== "function") return false;
		const holder = manager.getAllTabs?.().find((tab) => tab.conversationId === conversationId) ?? null;
		if (holder) {
			// Claudian switches to the tab holding it; hidden, not torn down, it is as it was. One
			// loaded ahead and never laid out goes to its reading spot once shown.
			const placed = this.laidOut.has(holder);
			if (manager.getActiveTab?.() !== holder) {
				void manager.openConversation(conversationId, { preferNewTab: true }).then(() => {
					const scroller = holder.dom?.messagesEl;
					if (placed || !scroller || this.getActiveTab() !== holder) return;
					this.settleScroll(scroller, conversationId, this.beginRestore(scroller, false));
				});
			}
			this.markShown(holder);
			this.scheduleTabTrim();
			return true;
		}
		this.veilUntilSettled(path);
		manager.openConversation(conversationId, { preferNewTab: true }).then(
			() => {
				const tab = this.getActiveTab();
				if (tab) this.markShown(tab);
				// Drawn from nothing in a new tab: hidden under the veil until on its reading spot.
				const scroller = this.visibleEl<HTMLElement>(CLAUDIAN_MESSAGES);
				if (scroller && tab?.conversationId === conversationId) {
					this.settleScroll(scroller, conversationId, this.beginRestore(scroller));
				}
				this.scheduleTabTrim();
			},
			() => {
				if (this.lastOpenedPath === path) this.showDraft(manager, path);
			},
		);
		return true;
	}

	/**
	 * Show the draft tab of `path`, a note with no conversation: the one it had, or the blank
	 * tab on screen if no other open note is using it, or a new one. Pointed at the note once
	 * shown (an empty tab's draft links none).
	 */
	private showDraft(manager: ClaudianTabManager, path: string): boolean {
		const key = this.draftKey(path);
		const follow = (): void => {
			if (path !== EMPTY_TAB && this.lastOpenedPath === path) this.followNoteInDraft(path);
		};
		const own = manager.getAllTabs?.().find((tab) => tab.id && !tab.conversationId && this.draftTabs.get(tab.id) === key);
		if (own?.id) {
			if (manager.getActiveTab?.() !== own) void manager.switchToTab?.(own.id);
			this.markShown(own);
			follow();
			this.scheduleTabTrim();
			return true;
		}
		const active = manager.getActiveTab?.() ?? null;
		if (active?.id && this.isBlankTab(manager, active) && !this.draftInUse(active.id)) {
			this.draftTabs.set(active.id, key);
			this.markShown(active);
			follow();
			this.scheduleTabTrim();
			return true;
		}
		if (typeof manager.createTab !== "function") return false;
		void manager.createTab(undefined, undefined, { activate: true }).then(
			(tab) => {
				if (tab?.id) {
					this.draftTabs.set(tab.id, key);
					this.markShown(tab);
				}
				follow();
				this.scheduleTabTrim();
			},
			(error: unknown) => console.warn("Claudian (Enhanced): couldn't open a draft tab", error),
		);
		return true;
	}

	/** Which draft a note's tab is: the note's path, or an empty tab's own. */
	private draftKey(path: string): string {
		return path === EMPTY_TAB ? `${EMPTY_TAB}:${this.emptyLeafId ?? ""}` : path;
	}

	/** Whether a tab's draft is another open note's (or an open empty tab's). */
	private draftInUse(tabId: string): boolean {
		const key = this.draftTabs.get(tabId);
		return key !== undefined && this.openNoteKeys().has(key);
	}

	/** Nothing in it: no conversation, no messages, nothing typed, nothing running. */
	private isBlankTab(manager: ClaudianTabManager, tab: ClaudianTab): boolean {
		if (tab.conversationId || tab.state?.messages?.length || this.tabWorking(manager, tab)) return false;
		const typed = tab.dom?.inputEl?.value;
		return !(typeof typed === "string" && typed.trim());
	}

	private markShown(tab: ClaudianTab): void {
		this.honestVisibility(tab);
		if (tab.id) this.tabShownAt.set(tab.id, Date.now());
		// On screen, it is laid out — and keeps that layout once hidden again.
		this.laidOut.add(tab);
	}

	/**
	 * The notes open in the main area, by path, and the open empty tabs, by their draft key —
	 * what a Claudian tab is kept for.
	 */
	private openNoteKeys(): Set<string> {
		const keys = new Set<string>();
		const { leftSplit, rightSplit } = this.app.workspace;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const root = leaf.getRoot();
			if (root === leftSplit || root === rightSplit) return;
			const file = leaf.getViewState().state?.file;
			if (typeof file === "string") keys.add(file);
			else if (leaf.view.getViewType() === "empty" || leaf.view.getViewType() === CLAUDIAN_VIEW) {
				keys.add(`${EMPTY_TAB}:${(leaf as unknown as { id?: string }).id ?? ""}`);
			}
		});
		return keys;
	}

	/** Trim the cache once the switch that asked has landed — and any others with it. */
	private scheduleTabTrim(): void {
		if (this.trimTimer !== null) window.clearTimeout(this.trimTimer);
		this.trimTimer = window.setTimeout(() => {
			this.trimTimer = null;
			this.trimTabCache();
		}, TAB_TRIM_DELAY_MS);
	}

	/**
	 * Let go of the Claudian tabs no open note needs, then of the least recently shown past
	 * TAB_CACHE_LIMIT. Never the tab on screen, one still working, or one with text typed in
	 * it; closing a tab only drops what it shows — the conversation stays in Claudian's history.
	 */
	private trimTabCache(): void {
		const manager = this.getTabManager();
		if (!manager || typeof manager.getAllTabs !== "function" || typeof manager.closeTab !== "function") return;
		const active = manager.getActiveTab?.() ?? null;
		if (active) this.markShown(active);
		const open = this.openNoteKeys();
		// The conversation each open note (or empty tab) comes back to.
		const needed = new Set<string>();
		for (const key of open) {
			const id = key.startsWith(`${EMPTY_TAB}:`)
				? this.emptyTabConversations.get(key.slice(EMPTY_TAB.length + 1))
				: this.conversationFor(key);
			if (id) needed.add(id);
		}
		const neededFor = (tab: ClaudianTab): boolean => {
			if (tab.conversationId) return needed.has(tab.conversationId);
			const key = tab.id ? this.draftTabs.get(tab.id) : undefined;
			return key !== undefined && open.has(key);
		};
		const kept: ClaudianTab[] = [];
		for (const tab of manager.getAllTabs()) {
			if (!tab.id) continue;
			this.honestVisibility(tab);
			const protectedTab = tab === active || this.tabWorking(manager, tab) || !this.isBlankComposer(tab);
			if (protectedTab || neededFor(tab)) kept.push(tab);
			else this.closeCachedTab(manager, tab.id);
		}
		const spare = kept
			.filter((tab) => tab !== active && !this.tabWorking(manager, tab) && this.isBlankComposer(tab))
			.sort((a, b) => (this.tabShownAt.get(a.id ?? "") ?? 0) - (this.tabShownAt.get(b.id ?? "") ?? 0));
		for (let excess = kept.length - TAB_CACHE_LIMIT; excess > 0 && spare.length > 0; excess--) {
			const oldest = spare.shift();
			if (oldest?.id) this.closeCachedTab(manager, oldest.id);
		}
		this.scheduleKeep();
	}

	private isBlankComposer(tab: ClaudianTab): boolean {
		const typed = tab.dom?.inputEl?.value;
		return !(typeof typed === "string" && typed.trim());
	}

	private closeCachedTab(manager: ClaudianTabManager, tabId: string): void {
		this.draftTabs.delete(tabId);
		this.tabShownAt.delete(tabId);
		void manager.closeTab?.(tabId);
	}

	/**
	 * Load, in hidden tabs, the conversations of open notes no tab holds yet, so the first
	 * switch to each is as quick as a return. One at a time, a pause between, the note you're
	 * on first; within TAB_CACHE_LIMIT. Claudian loads a tab's conversation only as it is
	 * shown, and its loading empties the list for a "Loading…" first — so it is loaded here
	 * through the tab's own model, and the tab marked loaded, which showing it then honours.
	 */
	private preloadOpenNotes(): void {
		if (this.preloading || Platform.isMobile) return;
		const manager = this.getTabManager();
		if (!manager || typeof manager.createTab !== "function" || !this.claudianMounted()) return;
		const tabs = manager.getAllTabs?.() ?? [];
		const active = manager.getActiveTab?.() ?? null;
		const current = this.activeNotePath();
		const notes = [...this.openNoteKeys()].filter((key) => !key.startsWith(`${EMPTY_TAB}:`));
		notes.sort((a, b) => Number(b === current) - Number(a === current));
		const wanted = notes.map((note) => this.conversationFor(note)).filter((id): id is string => !!id);
		// A tab Claudian restored at startup holds its conversation but loads it only when shown.
		const unloaded = tabs.find(
			(tab) => tab !== active && tab.conversationId && wanted.includes(tab.conversationId) && tab.hydrationState !== "ready",
		);
		const held = new Set(tabs.map((tab) => tab.conversationId).filter(Boolean));
		const missing = tabs.length < TAB_CACHE_LIMIT ? wanted.find((id) => !held.has(id)) : undefined;
		if (!unloaded && !missing) return;
		this.preloading = true;
		const tabReady = unloaded
			? Promise.resolve<ClaudianTab | null>(unloaded)
			: manager.createTab(missing, undefined, { activate: false }).then((tab) => {
					if (tab?.id) this.tabShownAt.set(tab.id, 0);
					return tab;
				});
		void tabReady
			.then(async (tab) => {
				const model = (tab as unknown as { session?: { runtime?: { model?: { hydrate?: () => Promise<void> } } } } | null)
					?.session?.runtime?.model;
				if (!tab || tab === manager.getActiveTab?.() || typeof model?.hydrate !== "function") return;
				await model.hydrate();
				if (!tab.state?.messages?.length || tab === manager.getActiveTab?.()) return;
				tab.hydrationState = "ready";
				this.honestVisibility(tab);
				this.scheduleKeep();
			})
			.catch((error: unknown) => console.warn("Claudian (Enhanced): couldn't preload a conversation", error))
			.finally(() => {
				this.preloading = false;
				this.schedulePreload(PRELOAD_GAP_MS);
			});
	}

	/**
	 * Keep the most recently shown hidden tabs laid out (KEPT_CLS, styles.css), so going back to
	 * one is a repaint — one tab per idle moment, while Claudian is on screen. Not more than
	 * KEPT_LIMIT, and none while Claudian is hidden behind another sidebar tab: Obsidian hides
	 * the whole view then, and showing it again lays out everything kept in it, so it drops
	 * them all (dropKept) and only the conversation on screen is laid out on the way back.
	 */
	private scheduleKeep(): void {
		if (this.keepHandle !== null) return;
		this.keepHandle = window.setTimeout(() => {
			this.keepHandle = null;
			window.requestIdleCallback(() => this.keepOne(), { timeout: 2000 });
		}, KEEP_DELAY_MS);
	}

	private keepOne(): void {
		const leaf = this.getClaudianLeaf();
		const manager = this.getTabManager();
		if (!leaf || !manager || !this.isLeafVisible(leaf)) return;
		const active = manager.getActiveTab?.() ?? null;
		const hidden = (manager.getAllTabs?.() ?? [])
			.filter((tab) => tab !== active && tab.dom?.contentEl && tab.state?.messages?.length)
			.sort((a, b) => (this.tabShownAt.get(b.id ?? "") ?? 0) - (this.tabShownAt.get(a.id ?? "") ?? 0));
		for (const tab of hidden.slice(KEPT_LIMIT)) tab.dom?.contentEl?.removeClass(KEPT_CLS);
		const next = hidden.slice(0, KEPT_LIMIT).find((tab) => !tab.dom?.contentEl?.hasClass(KEPT_CLS));
		const content = next?.dom?.contentEl;
		if (!next || !content) return;
		this.honestVisibility(next);
		content.addClass(KEPT_CLS);
		// Laid out now: one never shown (loaded ahead) goes to its reading spot, as a shown one would be.
		const scroller = next.dom?.messagesEl;
		if (!this.laidOut.has(next) && scroller) {
			this.applySpot(scroller, (next.conversationId && this.spots.get(next.conversationId)) || null);
			this.laidOut.add(next);
		}
		this.scheduleKeep();
	}

	/** Stop keeping hidden tabs laid out; see scheduleKeep. */
	private dropKept(): void {
		for (const tab of this.getTabManager()?.getAllTabs?.() ?? []) tab.dom?.contentEl?.removeClass(KEPT_CLS);
	}

	/**
	 * Teach Claudian's per-tab "is it on screen?" that a hidden tab isn't. It asks whether the
	 * message list has a box, which a tab hidden with display:none hasn't — and one kept laid out
	 * out of sight (KEPT_CLS) has. Taken for on screen, a reply that finished in the background
	 * would mark nothing unread, and a switch would mark another tab's as read.
	 */
	private honestVisibility(tab: ClaudianTab): void {
		const presentation = (tab as unknown as { session?: { runtime?: { model?: { presentation?: { isVisible?: () => boolean } } } } })
			.session?.runtime?.model?.presentation;
		const content = tab.dom?.contentEl;
		if (!presentation || typeof presentation.isVisible !== "function" || !content) return;
		if (this.visibilityChecks.has(presentation)) return;
		const original = presentation.isVisible;
		this.visibilityChecks.set(presentation, original);
		presentation.isVisible = () => original.call(presentation) && !content.classList.contains("claudian-hidden");
	}

	/** Look for a conversation to load ahead after `delay`; asked again before then, once. */
	private schedulePreload(delay: number): void {
		if (this.preloadTimer !== null) window.clearTimeout(this.preloadTimer);
		this.preloadTimer = window.setTimeout(() => {
			this.preloadTimer = null;
			this.preloadOpenNotes();
		}, delay);
	}


	/** The note Claudian's own record links a conversation to: "" for none, null when unknown. */
	private conversationNote(conversationId: string): string | null {
		const api = (this.getClaudianLeaf()?.view as unknown as { plugin?: ClaudianPluginApi } | undefined)?.plugin;
		const summary = api?.getConversationList?.()?.find((c) => c.id === conversationId);
		return summary ? (summary.linkedContentPath ?? "") : null;
	}

	/**
	 * Check, once a note switch has had time to land, that the conversation on screen isn't
	 * another note's — and switch again if it is. Every way into a switch (the sync, ⌘L's
	 * catch-up, the startup reconcile) ends in Claudian calls that can fail quietly: a command
	 * refused while its view was hidden, a restore read before Claudian had filled in the
	 * conversation's note. Each left the last note's conversation under this one with the
	 * switch already counted as done, so nothing ever tried again. Judged by Claudian's own
	 * record of the conversation's note, not its chip; a conversation with no note, or one
	 * still replying, is left alone, as is anything once you've moved on.
	 */
	private verifySoon(path: string): void {
		if (this.verifyTimer !== null) window.clearTimeout(this.verifyTimer);
		this.verifyTimer = window.setTimeout(() => {
			this.verifyTimer = null;
			if (this.lastOpenedPath !== path || this.activeNotePath() !== path) return;
			const restoring = Array.from(this.restores.values()).some((restore) => restore.phase !== "holding");
			if (restoring || this.veiledFor !== null || this.activeTabWorking()) {
				this.verifySoon(path); // still settling: look again shortly
				return;
			}
			const conversationId = this.getActiveTab()?.conversationId;
			if (!conversationId) return;
			const note = this.conversationNote(conversationId);
			if (!note || note === path) return;
			console.debug(`Claudian (Enhanced): ${path} still showed ${note}'s conversation; switching again`);
			// Filed under its own note first, so going back there finds it.
			this.rememberConversation(note);
			if (!this.replaceConversationFor(path)) this.followNoteInDraft(path);
		}, VERIFY_AFTER_MS);
	}

	/**
	 * Load each of Claudian's conversations once, so their message counts can be trusted.
	 *
	 * Since Claudian 2.3 a conversation's summary says 0 messages until the conversation has
	 * been loaded, and every one not opened yet this session reads as empty. Finding a note's
	 * conversation skips empty ones (latestLinkedConversation), so a note whose conversations
	 * hadn't been opened yet seemed to have none and was met with whatever was on screen.
	 * Loading is a few milliseconds a conversation, once per session.
	 */
	private loadConversationCounts(): Promise<void> {
		this.conversationCounts ??= (async () => {
			const api = (this.getClaudianLeaf()?.view as unknown as { plugin?: ClaudianPluginApi } | undefined)?.plugin;
			if (typeof api?.getConversationList !== "function" || typeof api.getConversationById !== "function") return;
			for (const conversation of api.getConversationList() ?? []) {
				if (!conversation.id || conversation.messageCount || conversation.isArchived) continue;
				try {
					await api.getConversationById(conversation.id);
				} catch {
					// Unreadable: it stays counted as empty, as before.
				}
			}
		})();
		return this.conversationCounts;
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
	 * The conversation on file for this note, if it still exists and is still the note's.
	 */
	private conversationFor(notePath: string): string | null {
		if (notePath === EMPTY_TAB) {
			const id = this.emptyLeafId ? this.emptyTabConversations.get(this.emptyLeafId) : undefined;
			return id && this.conversationExists(id) ? id : null;
		}
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
		// Counts not loaded yet read as empty; this asks once, for the next time (see there).
		void this.loadConversationCounts();
		const view = this.getClaudianLeaf()?.view as unknown as { plugin?: ClaudianPluginApi };
		const list = view?.plugin?.getConversationList;
		if (typeof list !== "function") return null;
		const clearedAt = this.clearedNotes[notePath] ?? 0;
		let best: { id: string; at: number } | null = null;
		for (const conversation of list.call(view.plugin) ?? []) {
			if (!conversation.id || conversation.linkedContentPath !== notePath) continue;
			if (conversation.isArchived || conversation.messageCount === 0) continue;
			if (this.predatesNote(conversation, notePath)) continue;
			const at = conversation.lastActivityAt ?? conversation.createdAt ?? 0;
			if (at <= clearedAt) continue;
			if (!best || at > best.at) best = { id: conversation.id, at };
		}
		return best?.id ?? null;
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
	 * Whether Claudian still has this conversation. Its repository holds every conversation
	 * in memory, so this also answers for ones never opened in this session.
	 *
	 * A build that renamed the lookup answers "yes": the point of this check is to catch a
	 * deleted conversation, and treating an unreachable lookup as "gone" would disable
	 * restoring altogether rather than degrade it.
	 */
	private conversationExists(id: string): boolean {
		const list = this.conversationSummaries();
		return list === null || list.some((conversation) => conversation.id === id);
	}

	/**
	 * Claudian's list of conversation summaries — id, note, recency — or null when it can't be
	 * read. Asked rather than `getCachedConversation`, which copies the whole conversation:
	 * some 15ms for 300 messages, and these questions are asked on every switch and trim.
	 */
	private conversationSummaries(): ClaudianConversationSummary[] | null {
		const plugin = (this.getClaudianLeaf()?.view as unknown as { plugin?: ClaudianPluginApi } | undefined)?.plugin;
		const list = plugin?.getConversationList;
		return typeof list === "function" ? (list.call(plugin) ?? null) : null;
	}

	/**
	 * Whether a conversation belongs to this note, as Claudian records it: the note it is
	 * linked to. A conversation started with no note (from the graph view, say) is linked to
	 * none and belongs to no note. Answers "yes" when the lookup or the record isn't there to
	 * ask, for the same reason as conversationExists: this exists to catch a wrong pairing,
	 * not to switch the feature off when Claudian's internals move.
	 */
	private conversationBelongsTo(id: string, notePath: string): boolean {
		const conversation = this.conversationSummaries()?.find((summary) => summary.id === id);
		if (!conversation) return true;
		return (conversation.linkedContentPath ?? null) === notePath && !this.predatesNote(conversation, notePath);
	}

	/**
	 * Whether the conversation was last had before the note now at `notePath` existed: it was
	 * an earlier note's at that path, one deleted or moved away, whose name a new note took
	 * again — a new draft is "Draft 1" as often as the last one was. A rename keeps the
	 * note's creation time, so its own conversations stay newer than it.
	 */
	private predatesNote(conversation: ClaudianConversationSummary, notePath: string): boolean {
		const created = this.app.vault.getFileByPath(notePath)?.stat.ctime;
		const at = conversation.lastActivityAt ?? conversation.createdAt;
		return typeof created === "number" && typeof at === "number" && at < created;
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
		const name = `/${conversationId}${SESSION_META_SUFFIX}`;
		const path = (await this.sessionMetaPaths()).find((file) => file.endsWith(name));
		if (!path) return null;
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
		const metas: Array<RememberedNote & { updatedAt: number }> = [];
		for (const file of await this.sessionMetaPaths()) {
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

	/** Every session meta Claudian has written: the old top-level ones and each device's. */
	private async sessionMetaPaths(): Promise<string[]> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(CLAUDIAN_SESSIONS_DIR))) return [];
		const top = await adapter.list(CLAUDIAN_SESSIONS_DIR);
		const files = [...top.files];
		if (top.folders.includes(CLAUDIAN_DEVICES_DIR)) {
			for (const device of (await adapter.list(CLAUDIAN_DEVICES_DIR)).folders) {
				files.push(...(await adapter.list(device)).files);
			}
		}
		return files.filter((file) => file.endsWith(SESSION_META_SUFFIX));
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
	/**
	 * Take a new session started by hand as the note's from now on. Claudian's own "new
	 * session" (its button, its command) puts a fresh conversation in the tab on screen, and
	 * nothing of that reached the note's memory — so leaving the note and coming back brought
	 * the conversation it had replaced back, found in Claudian's history as the note's latest.
	 * Seen here as the tab on screen going from a conversation to none, while a note (or an
	 * empty tab) is open: the old conversation is let go for the note, as clear-tab does, and
	 * the fresh tab becomes the note's draft, what coming back shows.
	 */
	private noticeNewSessions(): void {
		const manager = this.getTabManager();
		const active = manager?.getActiveTab?.() ?? null;
		for (const tab of manager?.getAllTabs?.() ?? []) {
			if (!tab.id) continue;
			const now = tab.conversationId ?? null;
			const before = this.seenConversations.get(tab.id);
			this.seenConversations.set(tab.id, now);
			if (tab !== active || !before || now) continue;
			const note = this.lastOpenedPath;
			if (note === null) continue;
			if (note === EMPTY_TAB) {
				if (this.emptyLeafId) this.emptyTabConversations.delete(this.emptyLeafId);
			} else {
				this.forgetNote(note);
				this.clearedNotes[note] = Date.now();
				void this.persistMemory();
			}
			this.draftTabs.set(tab.id, this.draftKey(note));
		}
	}

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

	/** Every conversation tab of every Claudian view: the sidebar's and the chats in tabs of their own. */
	private allClaudianTabs(): ClaudianTab[] {
		return this.app.workspace.getLeavesOfType(CLAUDIAN_VIEW).flatMap((leaf) => {
			const view = leaf.view as unknown as { getTabManager?: () => ClaudianTabManager | null };
			return view.getTabManager?.()?.getAllTabs?.() ?? [];
		});
	}

	/** Claudian's active conversation-tab state, or null if absent / internals renamed. */
	private getActiveTabState(): ClaudianTabState | null {
		return this.getActiveTab()?.state ?? null;
	}

	/** Claudian's 划词 controller for the active tab, or null if absent / internals renamed. */
	private getSelectionController(): ClaudianSelectionController | null {
		const controllers = this.getActiveTab()?.controllers;
		return controllers?.composerSelections?.editor ?? controllers?.selectionController ?? null;
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
	 * would see no note and act on the wrong (empty) state. A settled conversation that still
	 * carries no note gives way to this note's (see squareRestoredConversation).
	 */
	private reconcileChipOnStartup(deadline: number): void {
		const tick = (): void => {
			if (this.claudianMounted() && this.restoredTabSettled()) {
				// Judged once the conversations' message counts are real (loadConversationCounts):
				// before that, every note's own conversations read as empty.
				void this.loadConversationCounts().then(() => this.squareRestoredConversation());
				return;
			}
			if (Date.now() < deadline) window.setTimeout(tick, 150);
		};
		tick();
	}

	/** The judgement for reconcileChipOnStartup, once Claudian's restore has settled. */
	private squareRestoredConversation(): void {
		const notePath = this.activeNotePath();
		if (!notePath) return;
		// Claudian's record of the conversation's note first: its chip can still be empty when
		// the messages are in, and reading that as "no note" switched away from a conversation
		// that has one — through a path that recorded nothing and could fail.
		const conversationId = this.getActiveTab()?.conversationId;
		const recorded = conversationId ? this.conversationNote(conversationId) : null;
		const attached = recorded || this.linkedNotePath();
		if (!attached && recorded === "") {
			// A conversation that carries no note at all (started with none linked) — it belongs
			// to no note, this one included, yet it stayed on screen whatever note was open. This
			// note's own conversation replaces it, or a fresh one; it isn't recorded against any
			// note, and is still in Claudian's history. An empty draft is left to follow the note.
			const tab = this.getActiveTab();
			if (tab?.conversationId && tab.state?.messages?.length) {
				this.lastOpenedPath = notePath;
				if (this.replaceConversationFor(notePath)) return;
			}
			this.lastOpenedPath = notePath;
			this.followNoteInDraft(notePath);
			return;
		}
		if (attached === notePath) {
			// Already agree — seed the tracker so a *later* switch is the first thing that
			// clears context, and leave the conversation alone.
			this.lastOpenedPath = notePath;
			return;
		}
		// The restored conversation belongs to a different note. Dragging it onto this one
		// (what this used to do) rewrote the conversation's own note in Claudian's meta, so a
		// conversation merely *held* while some note happened to be open looked like it was
		// about that note from then on — and the memory, which trusts that meta, inherited the
		// lie. Arrive from the note it actually belongs to instead: the restored conversation is
		// recorded where it can be found again, and this note gets its own conversation back,
		// or a fresh one.
		this.lastOpenedPath = attached;
		this.handleNoteChange(notePath);
	}

	/**
	 * Whether the tab is done being restored, so its state can be judged.
	 *
	 * Claudian populates a restored tab in two steps: the conversation id and its note first,
	 * the message history afterwards. Reading it in between is what broke the cold start — a
	 * check for "is there anything to clear?" counted messages, saw none yet, decided the
	 * conversation was empty and left it in place, so the chip moved to the open note while the
	 * tab kept a conversation about a different one.
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

	private scheduleDedupe(): void {
		if (this.dedupeFrame !== null) return;
		this.dedupeFrame = requestAnimationFrame(() => {
			this.dedupeFrame = null;
			this.dropDuplicateTurns();
		});
	}

	/**
	 * Take the second copy of a turn out of a conversation. Claudian has been keeping a turn
	 * twice — the copy it made as the prompt was sent and streamed (its own `msg-…` ids), and
	 * the same turn as Claude Code recorded it (the prompt under its session id) — so the
	 * prompt and its reply showed twice, every turn of a conversation from some point on. The
	 * two are the same prompt by `userMessageId`. Only once Claude Code's copy is there with its
	 * reply is the sent copy dropped, from the conversation and from the page; a tab still
	 * working is left alone. What sets it off in Claudian isn't pinned down; this undoes it.
	 */
	private dropDuplicateTurns(): void {
		const manager = this.getTabManager();
		for (const tab of manager?.getAllTabs?.() ?? []) {
			if (this.tabWorking(manager, tab)) continue;
			const messages = tab.state?.messages as ClaudianMessage[] | undefined;
			if (!Array.isArray(messages)) continue;
			// Claude Code's copy of a prompt: its id is the session's, and its reply follows it.
			const recorded = new Set<string>();
			messages.forEach((message, i) => {
				if (message.role !== "user" || !message.userMessageId || message.id !== message.userMessageId) return;
				if (messages[i + 1]?.role === "assistant") recorded.add(message.userMessageId);
			});
			const dropped: number[] = [];
			messages.forEach((message, i) => {
				if (message.role !== "user" || !message.userMessageId || message.id === message.userMessageId) return;
				if (!recorded.has(message.userMessageId)) return;
				dropped.push(i);
				for (let j = i + 1; j < messages.length && messages[j]?.role !== "user"; j++) {
					if (String(messages[j]?.id ?? "").startsWith("msg-")) dropped.push(j);
				}
			});
			for (const i of dropped.sort((a, b) => b - a)) {
				const [message] = messages.splice(i, 1);
				if (message?.id) tab.renderer?.removeMessage?.(message.id);
			}
		}
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
			// A fresh prompt, not filled in yet: drawn before Claudian has put the message in its
			// list, or before Claude Code has taken the turn. Claudian gives the message what it
			// was sent with (`executionInput`) and the session file's id for it only then, and
			// the session file doesn't have it yet either, so asking now would wrongly settle it
			// as sent with nothing — and neither arrival touches the page to make it ask again.
			if (!message || (!message.executionInput && !message.userMessageId)) {
				unfilled = true;
				// Tagged meanwhile from the composer, the moment it's drawn: Claudian reads the
				// prompt's selection from there as it sends, and leaves it there after. Once, so
				// a selection made since doesn't move it; the message's own replaces it once in.
				if (!this.provisionallyTagged.has(bubble)) {
					this.provisionallyTagged.add(bubble);
					const pending = sentLines(this.getSelectionController()?.getContext?.());
					if (pending) this.renderSelectionTag(bubble, pending);
				}
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
		// Asked again as the reply streams in (see the submit-scroll observer), and on a timer
		// besides, for a turn that takes a while to start.
		this.tagsPending = unfilled;
		if (!unfilled) {
			this.tagRetries = 0;
		} else if (this.tagRetryTimer === null && this.tagRetries < TAG_RETRIES) {
			// One timer at a time: every pass that finds a prompt unfilled lands here, and each
			// starting its own would grow a chain of timers per pass.
			this.tagRetries++;
			this.tagRetryTimer = window.setTimeout(() => {
				this.tagRetryTimer = null;
				this.scheduleSelectionTags();
			}, TAG_RETRY_MS);
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
		const { promises: fs } = nodeRequire<typeof import("fs")>("fs");
		const path = nodeRequire<typeof import("path")>("path");
		const os = nodeRequire<typeof import("os")>("os");
		const { env } = nodeRequire<typeof import("process")>("process");
		const config = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
		const dir = path.join(config, "projects", path.resolve(adapter.getBasePath()).replace(/[^a-zA-Z0-9]/g, "-"));
		for (const tab of this.getTabManager()?.getAllTabs?.() ?? []) {
			const sessionId = this.sessionIdOf(tab);
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
				const found = /<editor_selection path="([^"]*)" lines="(\d+)-(\d+)">([\s\S]*?)<\/editor_selection>/.exec(prompt);
				if (!found) continue;
				// Claudian writes the text as CDATA, splitting it wherever it holds `]]>`.
				const text = Array.from((found[4] ?? "").matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g), (piece) => piece[1] ?? "").join("");
				this.sentSelections.set(entry.uuid, {
					path: decodeAttribute(found[1] ?? ""),
					start: Number(found[2]),
					end: Number(found[3]),
					text,
				});
			}
		}
	}

	/** Put the tag under a prompt, or take it away — touching the DOM only when it changes. */
	/**
	 * The Claude Code session a tab's conversation runs in — the id of its session file, and
	 * what `claude --resume` takes. Null for a draft, and for a conversation whose first reply
	 * hasn't started the session yet.
	 */
	private sessionIdOf(tab: ClaudianTab): string | null {
		if (!tab.conversationId) return null;
		// The session's live snapshot: no copying, and current as soon as a reply starts one.
		const live = (tab as unknown as { executionCoordinator?: { snapshot?: { providerSessionId?: string | null } } })
			.executionCoordinator?.snapshot?.providerSessionId;
		if (live) return live;
		// Else the stored conversation — copied whole to read one field, so once per conversation.
		const known = this.storedSessionIds.get(tab.conversationId);
		if (known !== undefined) return known;
		const view = this.getClaudianLeaf()?.view as unknown as { plugin?: ClaudianPluginApi } | undefined;
		const conversation = view?.plugin?.getCachedConversation?.(tab.conversationId) as {
			sessionId?: string | null;
			providerState?: { providerSessionId?: string | null };
		} | null | undefined;
		const id = conversation?.providerState?.providerSessionId ?? conversation?.sessionId ?? null;
		if (id) this.storedSessionIds.set(tab.conversationId, id);
		return id;
	}

	/**
	 * Show each tab's session id at the end of the row under its composer, across from the
	 * note chip; a click copies it. Claudian empties only the chip's own slot when the note
	 * changes, so the label stays put in the row once added. Written only when the id
	 * changes: the view observer calls this on every mutation, its own write included.
	 */
	private syncSessionIds(): void {
		for (const tab of this.allClaudianTabs()) {
			const row = tab.dom?.infoRowEl;
			if (!(row instanceof HTMLElement)) continue;
			const id = this.sessionIdOf(tab);
			let label = row.querySelector<HTMLElement>(`:scope > .${SESSION_ID_CLS}`);
			if (!id) {
				label?.remove();
				continue;
			}
			if (!label) {
				const created = row.createDiv({ cls: SESSION_ID_CLS, attr: { role: "button", "aria-label": "Copy session ID" } });
				// Not off the composer: a click is no reason to stop typing.
				created.addEventListener("mousedown", (e) => e.preventDefault());
				created.addEventListener("click", () => this.copySessionId(created));
				label = created;
			}
			if (label.dataset.sessionId !== id) {
				label.dataset.sessionId = id;
				label.setText(id);
			}
		}
	}

	/**
	 * A stop button at the bottom right of each tab's composer while Claudian works on it, for
	 * what Esc does there: the side chat stopped while the composer sends to it, else the turn,
	 * with the queued messages and background work behind it. Gone once it's stopped.
	 */
	private syncStopButtons(): void {
		for (const tab of this.allClaudianTabs()) {
			const toolbar = tab.dom?.inputWrapper?.querySelector<HTMLElement>(":scope > .claudian-input-toolbar");
			if (!toolbar) continue;
			let button = toolbar.querySelector<HTMLElement>(`:scope > .${STOP_BTN_CLS}`);
			const working = isWorking(tab);
			if (!button && !working) continue;
			if (!button) {
				const created = toolbar.createEl("button", { cls: STOP_BTN_CLS, attr: { "aria-label": "Stop" } });
				setIcon(created, "square");
				// Not off the composer: the next prompt is typed there.
				created.addEventListener("mousedown", (e) => e.preventDefault());
				created.addEventListener("click", () => {
					if (!isWorking(tab)) return;
					const side = tab.controllers?.sideChatController;
					if (side?.destination === "side") side.cancelSide?.();
					else tab.controllers?.inputController?.cancelStreaming?.();
					this.syncStopButtons();
				});
				button = created;
			}
			// Only on a change: the view observer calls this on every mutation, a class written
			// over with the same value included, which would call it again, and again.
			if (button.hasClass("claudian-hidden") === working) button.toggleClass("claudian-hidden", !working);
		}
	}

	/**
	 * Claudian's `@` and `/` menus say "No matches" when nothing matches what's typed: a box
	 * in the way of the text that offers nothing. It closes instead — closed, not just out of
	 * sight, so the arrow keys it would take go back to the composer (Enter and Tab already
	 * do) — and opens again once there is something to offer. The "Loading…" it shows while
	 * it looks again stays closed too, so typing on past the last match doesn't flash it.
	 */
	private quietEmptyMenus(): void {
		for (const tab of this.allClaudianTabs()) {
			const view = tab.ui?.composerDropdown?.controller?.view;
			const render = view?.render;
			const hide = view?.hide;
			if (!view || typeof render !== "function" || typeof hide !== "function" || this.quietedMenus.has(view)) continue;
			let quiet = false;
			view.render = (items, selected) => {
				const state = items.length === 1 ? items[0]?.state : undefined;
				quiet = state === "empty" || (quiet && state === "loading");
				if (quiet) hide.call(view);
				else render.call(view, items, selected);
			};
			this.quietedMenus.set(view, render);
		}
	}

	private copySessionId(label: HTMLElement): void {
		const id = label.dataset.sessionId;
		if (!id) return;
		void navigator.clipboard.writeText(id).then(() => {
			label.setText("Copied");
			window.setTimeout(() => label.setText(label.dataset.sessionId ?? ""), COPIED_MS);
		});
	}

	private renderSelectionTag(bubble: HTMLElement, selection: SentSelection | null): void {
		const content = bubble.querySelector<HTMLElement>(".claudian-message-content");
		if (!content) return;
		const existing = content.querySelector<HTMLElement>(`:scope > .${SELECTION_TAG_CLS}`);
		if (!selection) {
			existing?.remove();
			return;
		}
		const linked = this.linkedNotePath();
		const note = selection.path === linked ? "" : `${selection.path.split("/").pop()?.replace(/\.md$/, "")} · `;
		const label = `${note}${referenceLabel(this.referenceOfSelection(this.peekOfSent(selection)))}`;
		if (existing?.dataset.label === label) {
			this.tagSelections.set(existing, selection);
			return;
		}
		existing?.remove();
		// No tooltip: hovering it shows the peek card, which says more (selection-peek.ts).
		const tag = content.createDiv({ cls: SELECTION_TAG_CLS, attr: { "data-label": label } });
		setIcon(tag.createSpan({ cls: `${SELECTION_TAG_CLS}-icon` }), "text-select");
		tag.createSpan({ text: label });
		this.tagSelections.set(tag, selection);
	}

	/** The selection a prompt's tag stands for, as the peek card shows it. */
	private peekForTag(tag: HTMLElement): PeekSelection | null {
		const selection = this.tagSelections.get(tag);
		return selection ? this.labelled(this.peekOfSent(selection)) : null;
	}

	/** The selection the composer carries, as the peek card shows it. */
	private peekForComposer(): PeekSelection | null {
		const selection = this.getSelectionController()?.storedSelection;
		return selection ? this.labelled(selection) : null;
	}

	private peekOfSent(selection: SentSelection): PeekSelection {
		return { notePath: selection.path, selectedText: selection.text, startLine: selection.start, lineCount: selection.end - selection.start + 1 };
	}

	/** `selection` with the label its tag has: what it is, as ⌥K's reference to it would say (referenceLabel). */
	private labelled(selection: PeekSelection): PeekSelection {
		return { ...selection, label: referenceLabel(this.referenceOfSelection(selection)) };
	}

	/**
	 * A 划词 — the composer's, or one a prompt was sent with — as the reference ⌥K makes of the
	 * same selection (selectionReference), read against the note's text: `source`, or the note
	 * as it's open. Its lines alone when the note isn't to hand, or the selection has none.
	 */
	private referenceOfSelection(selection: PeekSelection, source = this.openText(selection.notePath)): NoteReference {
		const start = selection.startLine ?? 0;
		const lines = { path: selection.notePath, start, end: start ? start + Math.max(1, selection.lineCount) - 1 : 0 };
		if (!start || source === null) return lines;
		const text = source.split("\n");
		return selectionReference(lines, (n) => text[n - 1] ?? "", selection.selectedText);
	}

	/** To a sent selection's lines in its note, from its tag or peek card: lit as ⌥K's reference to the same is. */
	private openSelection(selection: PeekSelection): void {
		void (async () => {
			const file = this.app.vault.getFileByPath(selection.notePath);
			const source = this.openText(selection.notePath) ?? (file ? await this.app.vault.cachedRead(file) : null);
			const reference = this.referenceOfSelection(selection, source);
			// No lines to go by: the note, at the text where it's found.
			await this.revealReference(reference.start ? reference : { ...reference, start: 1, end: 1, quote: selection.selectedText || undefined });
		})();
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
				// Our own class writes (pinning, burying, folding, the jump button) render nothing
				// of Claudian's; read as streaming, every scroll would answer itself.
				if (record.type === "attributes" && onlyOwnClassesChanged(record)) continue;
				this.hideIfRebuilding(record);
				for (const node of Array.from(record.addedNodes)) {
					breakCellLines(node);
					tagChangeLabels(node);
				}
				const added = this.addedUserMessage(record);
				submitted ??= added;
				streamed ??= this.messagesListOf(record.target);
				queued ||= this.isInQueueRow(record.target);
				promptsChanged ||= this.changesPromptContent(record, added);
			}
			if (promptsChanged) {
				this.scheduleFold(container);
				this.scheduleDedupe();
				this.scheduleSelectionTags();
			} else if (this.tagsPending && streamed) {
				this.scheduleSelectionTags();
			}
			if (streamed) this.scheduleReplyLinks(streamed);
			this.returnToSpot(true);
			// Both scroll "the list this landed in" — there's one per conversation tab. Not a
			// conversation being put back, though: settleScroll positions that, its re-rendered
			// prompts aren't submits, and pinning it here is what used to move it.
			const submittedList = submitted?.closest<HTMLElement>(CLAUDIAN_MESSAGES) ?? null;
			if (submittedList) {
				if (!this.restores.has(submittedList)) this.scrollToBottom(submittedList);
			} else if (streamed && !this.restores.has(streamed) && onScreen(streamed)) {
				// A tab out of sight is still laid out (styles.css): following it would lay it out on
				// every token of a reply running in the background.
				this.followToBottom(streamed);
				// A reply growing below a reader who scrolled up moves the end further away
				// without a scroll event; one following it is pinned, so this hides nothing.
				this.syncJumpButton(streamed);
			}
			if (queued) this.handleQueueChange();
			this.syncSessionIds();
			this.syncStopButtons();
			this.quietEmptyMenus();
			this.noticeNewSessions();
		});
		breakCellLines(container);
		tagChangeLabels(container);
		this.scheduleDedupe();
		this.submitScrollObserver.observe(container, {
			childList: true,
			subtree: true,
			// Discarding/dispatching a queued message only toggles the row's visibility
			// class (Claudian leaves the stale summary in the DOM), so childList alone
			// would never tell us the queue emptied. See handleQueueChange.
			attributes: true,
			attributeFilter: ["class"],
			attributeOldValue: true,
		});
		// Width decides how many lines a prompt wraps to, so a panel resize can move a
		// prompt across the fold limit in either direction.
		this.foldResizeObserver?.disconnect();
		this.foldResizeObserver = new ResizeObserver(() => this.scheduleFold(container));
		this.foldResizeObserver.observe(container);
		// Prompts already on screen when we bind never produce a mutation of their own.
		this.scheduleFold(container);
		this.scheduleSelectionTags();
		this.syncSessionIds();
		this.syncStopButtons();
		this.quietEmptyMenus();
	}

	/**
	 * Whether a mutation can change how tall a prompt is: one added, or its content
	 * re-rendered (Claudian empties and refills it on edit). Class changes are ignored on
	 * purpose — pinning, burying and folding all write classes onto prompts, and none of
	 * them change what the content measures.
	 */
	private changesPromptContent(record: MutationRecord, added: HTMLElement | null): boolean {
		if (record.type !== "childList") return false;
		if (added) return true;
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
		this.syncPromptNav(scroller, prompts.length, Math.max(pinnedIndex, 0));
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
			// Only the pinned prompt folds (foldLongPrompts); the observer leaves our own class
			// writes alone, so it's told here.
			this.scheduleFold(this.getClaudianLeaf()?.view.containerEl ?? scroller);
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

	/**
	 * Show each reference to note lines in `root` — one ⌥K put in a prompt (insertReference),
	 * one a reply's change list ends a bullet with — as a link to its lines, as Claudian shows
	 * a mentioned note: `@Notes/a.md#12-14` reads `a L12–14`, and a click opens the note there
	 * (revealReference). Only paths the vault has; anything else stays text. A reply that is
	 * still streaming is drawn afresh with each piece, links gone; the next pass puts them back.
	 */
	private linkReferences(root: HTMLElement): void {
		const blocks = root.matches(".claudian-message-assistant") ? root.querySelectorAll<HTMLElement>(".claudian-text-block") : root.querySelectorAll<HTMLElement>(REFERENCE_TEXT);
		for (const block of Array.from(blocks)) {
			if (!block.textContent?.includes("@")) continue;
			const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
			const run: (Text | null)[] = [];
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (node instanceof Text) run.push(node.parentElement?.closest(`.${REFERENCE_CLS}`) ? null : node);
				else if (node instanceof HTMLElement && RUN_BREAK.test(node.tagName)) run.push(null);
			}
			this.linkReferencesIn(run);
		}
	}

	/**
	 * Each reference reads as the section its lines are in — the deepest heading above them,
	 * else the note's name — and the lines: `排期 L88`. In a list item, a reference to the same
	 * section as the one before it (a reply's change list giving several spots in a section)
	 * reads as its lines alone.
	 *
	 * In a prompt, the one asking already knows where they selected: there it reads as the lines
	 * and what's selected in them — columns, text — taken into the link: `L729 · 时间片显示 · 「局」`.
	 *
	 * `run` is one paragraph's (list item's, cell's) text nodes, null where one ends and another
	 * starts: markup draws parts of a reference as elements — selected text with `code` or
	 * **bold** in it, a path with emphasis marks in it — read together they are one again.
	 */
	private linkReferencesIn(run: (Text | null)[]): void {
		let text = "";
		const pieces: { node: Text; from: number }[] = [];
		for (const node of run) {
			if (node) {
				pieces.push({ node, from: text.length });
				text += node.data;
			} else text += "\n";
		}
		// A spot in `text` as one in a node: a start in the node it starts, an end in the one it ends.
		const spot = (offset: number, end: boolean): { node: Text; offset: number } | null => {
			const piece = pieces.find(({ node, from }) => (end ? offset > from && offset <= from + node.data.length : offset >= from && offset < from + node.data.length));
			return piece ? { node: piece.node, offset: offset - piece.from } : null;
		};
		const previous = new Map<HTMLElement | null, string | null>();
		const links: { from: { node: Text; offset: number }; to: { node: Text; offset: number }; link: HTMLElement }[] = [];
		for (const match of text.matchAll(REFERENCE)) {
			const reference = readReference(match);
			const { path, start, end } = reference;
			const file = this.app.vault.getFileByPath(path);
			const from = spot(match.index, false);
			if (!file || !from || from.node.parentElement?.closest("a, code")) continue;
			const prompt = !!from.node.parentElement?.closest(CLAUDIAN_USER_MESSAGE);
			const source = prompt ? match[0] : `@${path}${start ? `#${start}${end > start ? `-${end}` : ""}` : ""}`;
			const to = spot(match.index + source.length, true);
			if (!to) continue;
			const item = from.node.parentElement?.closest("li") ?? null;
			if (!previous.has(item)) {
				const before = item
					? Array.from(item.querySelectorAll<HTMLElement>(`.${REFERENCE_CLS}`))
							.filter((el) => el.compareDocumentPosition(from.node) & Node.DOCUMENT_POSITION_FOLLOWING)
							.pop()
					: undefined;
				previous.set(item, before?.dataset.section ?? null);
			}
			const section = `${path}#${this.sectionAt(file, start)}`;
			const name = section.slice(path.length + 1);
			const lines = linesLabel(start, end);
			const link = from.node.ownerDocument.createElement("span");
			link.className = REFERENCE_CLS;
			if (prompt && lines) link.setText(referenceLabel(reference));
			else link.setText(item && section === previous.get(item) && lines ? lines : [name, lines].filter(Boolean).join(" "));
			link.dataset.section = section;
			previous.set(item, section);
			link.setAttribute("role", "link");
			link.setAttribute("aria-label", source.slice(1));
			link.dataset.source = source;
			link.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.revealReference(reference);
			});
			links.push({ from, to, link });
		}
		// Last first: taking one out leaves the spots before it where they were.
		for (const { from, to, link } of links.reverse()) {
			const range = from.node.ownerDocument.createRange();
			range.setStart(from.node, from.offset);
			range.setEnd(to.node, to.offset);
			range.deleteContents();
			range.insertNode(link);
		}
	}

	/** The deepest heading above line `line` (1-based) of `file`, else the note's own name. */
	private sectionAt(file: TFile, line: number): string {
		let section: string | null = null;
		for (const heading of this.app.metadataCache.getFileCache(file)?.headings ?? []) {
			if (heading.position.start.line + 1 > line) break;
			section = heading.heading;
		}
		return section ?? file.basename.replace(/\.excalidraw$/, "");
	}

	/**
	 * Open the note a reference names at its first line — or, when the reference quotes text
	 * that's no longer on its lines (the note has moved since), the line that text is on now.
	 * A drawing or a reference without lines just opens. In a table, what it names is lit:
	 * the columns of those rows it gives, or the text it quotes (lightTable).
	 */
	private async revealReference(reference: NoteReference): Promise<void> {
		const { path, start, end, quote, columns = [] } = reference;
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		let existing: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!existing && (leaf.view as { file?: TFile | null }).file?.path === path && this.sidebarOf(leaf) === null) existing = leaf;
		});
		const leaf: WorkspaceLeaf = existing ?? this.app.workspace.getLeaf("tab");
		if (!existing) await leaf.openFile(file);
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		const view = leaf.view;
		if (!start || !(view instanceof MarkdownView)) return;
		const lines = view.data.split("\n");
		let line = Math.min(start, lines.length);
		// Only its start, should it be shortened: the part before the ellipsis is its own text.
		const quoted = quote?.split(" … ")[0];
		if (quoted && !flatten(lines.slice(start - 1, end).join("\n")).includes(flatten(quoted))) {
			const found = locateText(view.data, quoted);
			if (found) line = view.data.slice(0, found.from).split("\n").length;
		}
		const last = Math.max(line, Math.min(line + end - start, lines.length));
		const table = this.blockAt(view, line, "table");
		let diagram = this.blockAt(view, line, "code");
		if (diagram && !/^\s*(?:```|~~~)\s*mermaid\b/.test(lines[diagram.position.start.line] ?? "")) diagram = null;
		const cm = view.getMode() === "source" ? this.cmOf(leaf) : null;
		// A diagram the cursor is already in shows its source: its lines are there to go to.
		const main = cm?.state.selection.main;
		if (diagram && main && main.to >= diagram.position.start.offset && main.from <= diagram.position.end.offset) diagram = null;
		if (cm) {
			const pos = cm.state.doc.line(Math.min(line, cm.state.doc.lines)).from;
			// Not into a table or a diagram: the cursor in a table opens a cell's editor, the table's
			// own focus state, neither of which says which row; in a diagram it shows the source in
			// its place. Scrolled to, what the reference names is lit instead.
			if (table || diagram) cm.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
			else {
				// `line` alone lights the one line; a range is lit as a search match is, start to end.
				const range = last > line ? { startLoc: { line: line - 1, col: 0 }, endLoc: { line: last - 1, col: lines[last - 1]?.length ?? 0 } } : {};
				view.setEphemeralState({ line: line - 1, ...range });
				cm.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
			}
		} else view.setEphemeralState({ line: line - 1 });
		let lights: (Light | null)[];
		if (table) lights = [this.lightTable(view, table, line, last, columns, quoted)];
		else if (diagram) lights = [this.lightDiagram(view, diagram, line, last, quoted)];
		else {
			// A range of text can take in tables, which neither the editor's highlight nor reading
			// view's reaches into: each is lit by its rows.
			const sections = view.file ? this.app.metadataCache.getFileCache(view.file)?.sections : undefined;
			const tables = (sections ?? []).filter((s) => s.type === "table" && s.position.start.line + 1 > line && s.position.start.line < last);
			lights = tables.map((s) => this.lightTable(view, s, s.position.start.line + 1, last, [], undefined, false));
			if (!cm && last > line) lights.push(this.lightLines(view, line, last, tables));
		}
		const lit = lights.filter((light): light is Light => light !== null);
		if (lit.length === 0) return;
		this.keepLit(
			view,
			() => {
				const held = lit.map((light) => light.paint());
				return held.every((els) => els === null) ? null : held.flatMap((els) => els ?? []);
			},
			() => lit.forEach((light) => light.clear()),
		);
	}

	/** The `type` section (a table, a code block) line `line` (1-based) of `view`'s note is in; not one nested in a callout or a list. */
	private blockAt(view: MarkdownView, line: number, type: string): SectionCache | null {
		const sections = view.file ? this.app.metadataCache.getFileCache(view.file)?.sections : undefined;
		return sections?.find((s) => s.type === type && s.position.start.line < line && line <= s.position.end.line + 1) ?? null;
	}

	/**
	 * Light the cells of lines `from`–`to` (1-based) of `section`, the table they're in: those
	 * in `columns` (header names, as references give them), else the whole rows — or, when the
	 * reference quotes part of them, just that text. Either view draws a table as one block, so
	 * the scroll gets as far as the table, never the cell.
	 */
	private lightTable(view: MarkdownView, section: SectionCache, from: number, to: number, columns: string[], quote: string | undefined, scroll = true): Light {
		const first = section.position.start.line + 1;
		const last = Math.min(to, section.position.end.line + 1);
		// Row 0 is the header; the delimiter line under it isn't a row of the table, so it lights the header.
		const rowOf = (line: number): number => Math.max(line - first - 1, 0);
		const header = tableRowCells(view.data.split("\n")[first - 1] ?? "").map((name) => name.replace(/[*_`]/g, "").trim());
		const indexes = columns
			.map((name) => (header.includes(name) ? header.indexOf(name) : Number(/^#(\d+)$/.exec(name)?.[1] ?? 0) - 1))
			.filter((index) => index >= 0);
		const [minCol, maxCol] = indexes.length ? [Math.min(...indexes), Math.max(...indexes)] : [0, Infinity];
		const registry = highlightRegistry();
		const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => object }).Highlight;
		let lit: HTMLTableCellElement[] = [];
		let scrolled = !scroll;
		const paint = (): HTMLTableCellElement[] | null => {
			const table = this.renderedBlock(view, first)?.querySelector("table");
			const cells = Array.from(table?.rows ?? [])
				.slice(rowOf(from), rowOf(last) + 1)
				.flatMap((row) => Array.from(row.cells).filter((cell) => cell.cellIndex >= minCol && cell.cellIndex <= maxCol));
			if (cells.length === 0) return null;
			const range = quote && registry && Highlight ? renderedRange(cells, quote) : null;
			for (const cell of lit) if (!cells.includes(cell) || range) cell.removeClass(LIT_CELL_CLS);
			if (range && registry && Highlight) registry.set(LIT_TEXT, new Highlight(range));
			else for (const cell of cells) if (!cell.hasClass(LIT_CELL_CLS)) cell.addClass(LIT_CELL_CLS);
			lit = range ? [] : cells;
			if (!scrolled) {
				scrolled = true;
				// Reading view flashes the whole table it scrolled to, which would drown the cells out.
				table?.closest(".is-flashing")?.removeClass("is-flashing");
				(range?.startContainer.parentElement ?? cells[0])?.scrollIntoView({ block: "center" });
			}
			return cells;
		};
		return {
			paint,
			clear: () => {
				for (const cell of lit) cell.removeClass(LIT_CELL_CLS);
				registry?.delete(LIT_TEXT);
			},
		};
	}

	/**
	 * Light what lines `from`–`to` (1-based) of `section`, a Mermaid block, draw: a flowchart's
	 * nodes, edges with their labels and subgraphs; a state diagram's states, transitions and
	 * notes — found by the ids the drawing gives them (diagramTargets). Or, when the reference
	 * quotes part of one of their labels, just that text. Lines that draw nothing (styling,
	 * comments), and diagrams of other kinds, light nothing; the scroll got as far as the
	 * diagram.
	 */
	private lightDiagram(view: MarkdownView, section: SectionCache, from: number, to: number, quote: string | undefined): Light | null {
		const first = section.position.start.line + 1;
		const body = view.data.split("\n").slice(first, section.position.end.line);
		// The fence lines are none of the diagram's: line `first` is the opening one.
		const targets = diagramTargets(body, Math.max(from - first - 1, 0), to - first - 1);
		if (targets.size === 0) return null;
		let lit: Element[] = [];
		let boxes: SVGRectElement[] = [];
		let scrolled = false;
		const paint = (): Element[] | null => {
			const svg = this.renderedBlock(view, first)?.querySelector(DRAWN_DIAGRAM);
			const all = Array.from(svg?.querySelectorAll("[data-id]") ?? []);
			const ids = drawnIds(targets, all.map((el) => el.getAttribute("data-id") ?? ""));
			const parts = all.filter((el) => ids.has(el.getAttribute("data-id") ?? ""));
			if (parts.length === 0) return null;
			const range = quote ? (parts.map((part) => renderedRange([part], quote)).find((found) => found !== null) ?? null) : null;
			const shapes = range ? [] : parts;
			for (const el of lit) if (!shapes.includes(el)) el.classList.remove(LIT_SHAPE_CLS);
			for (const el of shapes) if (!el.classList.contains(LIT_SHAPE_CLS)) el.classList.add(LIT_SHAPE_CLS);
			lit = shapes;
			// Drawn again only when the diagram was: boxes going in are a change keepLit repaints on.
			if (!range || boxes.some((box) => !box.isConnected)) {
				boxes.forEach((box) => box.remove());
				boxes = [];
			}
			if (range && boxes.length === 0) boxes = boxText(range);
			if (range && boxes.length === 0) return null;
			if (!scrolled) {
				scrolled = true;
				svg?.closest(".is-flashing")?.removeClass("is-flashing");
				(boxes[0] ?? parts[0])?.scrollIntoView({ block: "center", inline: "nearest" });
			}
			return range ? boxes : parts;
		};
		return {
			paint,
			clear: () => {
				lit.forEach((el) => el.classList.remove(LIT_SHAPE_CLS));
				boxes.forEach((box) => box.remove());
			},
		};
	}

	/**
	 * Light lines `from` to `to` (1-based) in reading view, which lights only the block or list
	 * item at the first: the blocks they take, or of a block they take part of, its list items;
	 * not the tables in `skip`.
	 */
	private lightLines(view: MarkdownView, from: number, to: number, skip: SectionCache[]): Light {
		let lit: HTMLElement[] = [];
		let first = true;
		const paint = (): HTMLElement[] | null => {
			const renderer = (view.previewMode as unknown as { renderer?: { sections?: { el: HTMLElement; lines: number }[] } }).renderer;
			const parts: HTMLElement[] = [];
			let at = 1;
			for (const section of renderer?.sections ?? []) {
				const end = at + section.lines - 1;
				// A table in range is lit by its cells (lightTable).
				const table = skip.some((s) => s.position.start.line + 1 === at);
				if (section.lines > 0 && !table && at <= to && end >= from && section.el.isConnected) {
					// A list item's data-line counts from its block's first line.
					const inRange = from <= at && end <= to ? [] : Array.from(section.el.querySelectorAll<HTMLElement>("li[data-line]")).filter((li) => {
						const n = at + Number(li.dataset.line);
						return n >= from && n <= to;
					});
					// An item lit lights the items nested in it.
					const items = inRange.filter((li) => !inRange.some((other) => other !== li && other.contains(li)));
					parts.push(...(items.length ? items : [section.el]));
				}
				at += section.lines;
				if (at > to) break;
			}
			if (parts.length === 0) return null;
			for (const el of lit) if (!parts.includes(el)) el.removeClass(LIT_BLOCK_CLS);
			for (const el of parts) if (!el.hasClass(LIT_BLOCK_CLS)) el.addClass(LIT_BLOCK_CLS);
			lit = parts;
			if (first) {
				first = false;
				view.previewMode.containerEl.querySelectorAll(".is-flashing").forEach((el) => el.removeClass("is-flashing"));
			}
			return parts;
		};
		return { paint, clear: () => lit.forEach((el) => el.removeClass(LIT_BLOCK_CLS)) };
	}

	/**
	 * Keep what `paint` lights lit as Obsidian lights a search result it opened a note at: until
	 * a click in the note, or Escape. `paint` lights it and returns what it lit, or null while
	 * that isn't drawn; it runs again whenever the
	 * note's DOM changes, since the table or diagram can be drawn afresh meanwhile — the widget as
	 * the note changes, reading view as it scrolls. `clear` puts it out.
	 */
	private keepLit(view: MarkdownView, paint: () => Element[] | null, clear: () => void): void {
		this.litOff?.();
		const path = view.file?.path;
		const doc = view.containerEl.ownerDocument;
		const repaint = (): boolean => {
			if (view.file?.path !== path) {
				off();
				return true;
			}
			return paint() !== null;
		};
		let frame: number | null = null;
		const observer = new MutationObserver(() => {
			frame ??= requestAnimationFrame(() => {
				frame = null;
				repaint();
			});
		});
		const onPointerDown = (e: PointerEvent): void => {
			const target = e.target instanceof Node ? e.target : null;
			if (target && view.containerEl.contains(target)) off();
		};
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key === "Escape") off();
		};
		const off = (): void => {
			if (this.litOff !== off) return;
			this.litOff = null;
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
			doc.removeEventListener("pointerdown", onPointerDown, true);
			doc.removeEventListener("keydown", onKeyDown, true);
			clear();
		};
		this.litOff = off;
		doc.addEventListener("pointerdown", onPointerDown, true);
		doc.addEventListener("keydown", onKeyDown, true);
		// Drawn on a frame to come: the widget once the editor has scrolled to it, reading
		// view's section once it has rendered.
		let frames = 0;
		const look = (): void => {
			if (this.litOff !== off) return;
			if (repaint()) observer.observe(view.containerEl, { childList: true, subtree: true });
			else if (++frames < 30) requestAnimationFrame(look);
			else off();
		};
		requestAnimationFrame(look);
	}

	/** What `view` draws for the table or code block whose source starts on line `first` (1-based), if it's drawn. */
	private renderedBlock(view: MarkdownView, first: number): HTMLElement | null {
		if (view.getMode() === "source") {
			const cm = this.cmOf(view.leaf);
			for (const widget of Array.from(cm?.contentDOM.querySelectorAll<HTMLElement>(".cm-table-widget, .cm-preview-code-block") ?? [])) {
				try {
					if (cm?.state.doc.lineAt(cm.posAtDOM(widget)).number === first) return widget;
				} catch {
					// A widget the editor is redrawing has no position yet.
				}
			}
			return null;
		}
		// Reading view's sections say how many lines each takes, not where it starts: counted up.
		const renderer = (view.previewMode as unknown as { renderer?: { sections?: { el: HTMLElement; lines: number }[] } }).renderer;
		let at = 1;
		for (const section of renderer?.sections ?? []) {
			// A header or footer takes no lines, and shares its place with what's next.
			if (at === first && section.lines > 0) return section.el.isConnected ? section.el : null;
			at += section.lines;
			if (at > first) break;
		}
		return null;
	}

	/** Link the references in the latest reply of `list` on the next frame, once however many pieces stream in. */
	private scheduleReplyLinks(list: HTMLElement): void {
		if (this.replyLinkFrame !== null) return;
		this.replyLinkFrame = requestAnimationFrame(() => {
			this.replyLinkFrame = null;
			const reply = Array.from(list.querySelectorAll<HTMLElement>(".claudian-message-assistant")).pop();
			if (reply) this.linkReferences(reply);
		});
	}

	/** Run a fold pass on the next frame, coalescing a burst of mutations into one. */
	private scheduleFold(container: HTMLElement): void {
		if (this.foldFrame !== null) return;
		this.foldFrame = requestAnimationFrame(() => {
			this.foldFrame = null;
			this.foldLongPrompts(container);
			this.linkReferences(container);
		});
	}

	/**
	 * Fold the pinned prompt down to FOLD_LINES when it's too long to be a readable header,
	 * with a toggle; the others, read where they are, stay whole unless collapsed by hand.
	 *
	 * A pinned prompt is only useful as a header: a long one — a pasted diagram, a file's
	 * worth of context — covered the whole panel while its reply scrolled underneath. A
	 * sticky element's box is its slot in the list, though, so folding it as it pins would
	 * pull the reply being read up by however much was cut: what's cut is kept as a bottom
	 * margin while it's pinned (keepSlot), and given back as it unpins.
	 *
	 * Reads before writes, and writes only on change — the same discipline as
	 * markPinnedPrompt, for the same reasons: interleaving forces a reflow per prompt, and
	 * every class write here is a mutation the observer above sees. A prompt that isn't laid
	 * out (in a hidden tab) measures zero and is left exactly as it was.
	 */
	private foldLongPrompts(container: HTMLElement): void {
		if (!container.isConnected) return;
		const measured: Array<{ prompt: HTMLElement; long: boolean; height: number }> = [];
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
			measured.push({ prompt, long, height: prompt.getBoundingClientRect().height });
		}
		for (const { prompt, long, height } of measured) {
			const pinned = prompt === this.pinnedPrompt;
			const byHand = this.collapsedPrompts.has(prompt);
			const folded = long && !this.expandedPrompts.has(prompt) && (pinned || byHand);
			const was = prompt.hasClass(FOLDED_CLS);
			if (prompt.hasClass(FOLDABLE_CLS) !== long) prompt.toggleClass(FOLDABLE_CLS, long);
			if (was !== folded) prompt.toggleClass(FOLDED_CLS, folded);
			// Folded for being pinned, not by hand: its slot in the list is kept.
			if (folded && !byHand && !was) this.keepSlot(prompt, height);
			else if (!folded || byHand) this.releaseSlot(prompt);
			if (long) this.syncFoldToggle(prompt, folded);
			else prompt.querySelector(`.${FOLD_TOGGLE_CLS}`)?.remove();
		}
	}

	/**
	 * The expand/collapse control: a strip along the bubble's bottom edge, the whole width,
	 * with a chevron in its middle — always shown, since it is the only sign there is more.
	 * Only the edge: a press anywhere else on a pinned prompt goes to its turn, and the two
	 * would be told apart by where they land. Not a <button>: the theme pads every button,
	 * which is what made the toolbar's icons shake; and the pinned-prompt click handler stands
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
				if (collapse) {
					this.expandedPrompts.delete(prompt);
					// The pinned one folds anyway, its slot kept; another stays folded by hand.
					if (prompt !== this.pinnedPrompt) this.collapsedPrompts.add(prompt);
				} else {
					this.expandedPrompts.add(prompt);
					this.collapsedPrompts.delete(prompt);
				}
				const container = this.getClaudianLeaf()?.view.containerEl;
				if (container) this.foldLongPrompts(container);
			};
			toggle = bubble.createDiv({ cls: FOLD_TOGGLE_CLS, attr: { role: "button", tabindex: "0" } });
			toggle.createSpan({ cls: `${FOLD_TOGGLE_CLS}-icon` });
			toggle.addEventListener("click", flip);
			toggle.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") flip(event);
			});
		}
		const state = folded ? "folded" : "expanded";
		if (toggle.dataset.state === state) return;
		toggle.dataset.state = state;
		const icon = toggle.querySelector<HTMLElement>(`.${FOLD_TOGGLE_CLS}-icon`) ?? toggle;
		setIcon(icon, folded ? "chevron-down" : "chevron-up");
		toggle.setAttribute("aria-label", folded ? "Expand prompt" : "Collapse prompt");
	}

	/**
	 * Keep a prompt folded for being pinned taking the room it took unfolded (`unfolded`
	 * high), by a bottom margin of the difference, so nothing under it moves. One forced
	 * layout, and only as a prompt pins.
	 */
	private keepSlot(prompt: HTMLElement, unfolded: number): void {
		const base = parseFloat(getComputedStyle(prompt).marginBottom) || 0;
		const cut = unfolded - prompt.getBoundingClientRect().height;
		if (cut < 0.5) return;
		prompt.dataset.foldSlot = "kept";
		prompt.setCssProps({ "margin-bottom": `${base + cut}px` });
	}

	/** Give back the room keepSlot kept, as the prompt unfolds. */
	private releaseSlot(prompt: HTMLElement): void {
		if (prompt.dataset.foldSlot === undefined) return;
		delete prompt.dataset.foldSlot;
		prompt.style.removeProperty("margin-bottom");
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
		const held = (): void => {
			if (controller.storedSelection !== this.blockSelection) {
				const cells = this.tableCellSelection();
				if (cells) this.adoptSelection(controller, cells);
			}
			notify?.call(controller);
			// Claudian dropping or replacing the selection takes its painting with it.
			this.syncCellHighlight();
		};
		controller.onUserSelectionChanged = held;
		this.register(() => {
			if (controller.onUserSelectionChanged === held) controller.onUserSelectionChanged = notify;
			// A selection of ours is held past Claudian's poll for good; hand it back to the poll.
			if (this.blockSelection && controller.storedSelection === this.blockSelection) {
				controller.inputHandoffGraceUntil = null;
			}
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
		const text = selection ? selectionText(selection).trim() : "";
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
	 * a callout or a table ends — or, a code block (a diagram), to its closing fence. Within
	 * it, the text is found as ⌥K finds it (locateText): a label of a diagram is the line it's
	 * written on, `<br/>` and quotes and all. Failing that, the first and last selected lines
	 * are matched with markup and spacing left out; if the first can't be, the whole block
	 * is the honest answer.
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
		const fence = /^[\s>]*(`{3,}|~{3,})/.exec(doc.line(first).text)?.[1];
		if (fence) {
			while (last < doc.lines && !doc.line(last + 1).text.replace(/^[\s>]*/, "").startsWith(fence)) last++;
			last = Math.min(last + 1, doc.lines);
		} else {
			while (last < doc.lines && doc.line(last + 1).text.trim() !== "") last++;
		}
		const from = doc.line(first).from;
		const found = locateText(doc.sliceString(from, doc.line(last).to), text);
		if (found) {
			const start = doc.lineAt(from + found.from).number;
			return { start, count: doc.lineAt(from + found.to).number - start + 1 };
		}
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
		if (!onScreen(scroller)) return;
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
	 * The spot is applied when a conversation is loaded into a new tab (showConversation), but two
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
		if (!scroller || !onScreen(scroller) || this.restores.has(scroller)) return;
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

	/** Scroll to a saved spot; with none (not read here this session), to the end. */
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

	/**
	 * The list's outline of its prompts (prompt-nav.ts), made in the list's wrapper beside the
	 * jump-to-latest button once there are two prompts to tell apart; `current` is the one
	 * pinned. Its moves through the list are the plugin's own until the reader chooses one:
	 * hovering a prompt shows its turn without detaching a list that follows the stream, and
	 * leaving puts it back as it was; choosing one is the reader's own move up.
	 */
	private syncPromptNav(scroller: HTMLElement, count: number, current: number): void {
		let nav = this.promptNavs.get(scroller);
		if (!nav) {
			const wrapper = scroller.parentElement;
			if (count < 2 || !wrapper) return;
			const ownMove = (move: () => void): void => {
				this.selfScrolling = true;
				move();
				this.lastScrollTop.set(scroller, scroller.scrollTop);
				requestAnimationFrame(() => {
					this.selfScrolling = false;
				});
			};
			nav = new PromptNav(scroller, wrapper, {
				preview: (list, prompt) => ownMove(() => this.scrollTurnIntoView(list, prompt)),
				restore: (list, top, wasFollowing) =>
					ownMove(() => {
						// Back to the end, not to the offset it was at: the turns shown on the way
						// were drawn at their own heights, which moved the end.
						if (!wasFollowing) {
							list.scrollTop = top;
							return;
						}
						this.detached.delete(list);
						list.scrollTop = list.scrollHeight;
					}),
				commit: (list) => {
					const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
					if (distance > REATTACH_PX) this.detached.add(list);
				},
				isFollowing: (list) => !this.detached.has(list),
			});
			this.promptNavs.set(scroller, nav);
		}
		nav.sync(count, current);
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
		// The reader took over; leave them where they are until they come back down.
		if (this.detached.has(scroller)) return;
		// Pressed in: what's under the pointer stays there until it's let go of.
		if (this.pressed?.list === scroller) return;
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
			row && onScreen(row)
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
	/**
	 * Keep a message list still while a press is held in it. Following a reply as it streams
	 * scrolls the list on every piece of it, so whatever was pressed — a reference in the prompt
	 * just sent, its line tag, a link or a button in the reply — had moved away by the time the
	 * press was let go of, and the browser, the press ending on something else, made no click
	 * of it: a link in a fresh prompt did nothing until the prompt reached the top and stuck.
	 * A text selection dragged across a streaming reply holds still the same way. Let go, the
	 * list catches up with the stream — after the click, which is dispatched right after the
	 * pointer comes up, to what was under it — unless it was moved meanwhile: the reader
	 * dragging its scrollbar, or what the click does (the pinned prompt going back to its
	 * turn), which is theirs to keep.
	 */
	private holdStillWhilePressed(): void {
		this.registerDomEvent(
			document,
			"pointerdown",
			(event: PointerEvent) => {
				const list = event.target instanceof Element ? event.target.closest<HTMLElement>(CLAUDIAN_MESSAGES) : null;
				if (!list) return;
				const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
				this.pressed = { list, following: !this.detached.has(list) && distance <= FOLLOW_THRESHOLD_PX, top: list.scrollTop };
			},
			{ capture: true },
		);
		const release = (): void => {
			const pressed = this.pressed;
			this.pressed = null;
			if (!pressed?.following) return;
			window.setTimeout(() => {
				const { list, top } = pressed;
				if (this.pressed?.list !== list && list.scrollTop === top && !this.detached.has(list)) this.pinToBottom(list);
			}, 0);
		};
		this.registerDomEvent(document, "pointerup", release, { capture: true });
		this.registerDomEvent(document, "pointercancel", release, { capture: true });
		// Let go outside the window, the pointer up goes elsewhere.
		this.registerDomEvent(window, "blur", release);
	}

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
				// The bubble hosts Claudian's copy / rewind / fork toolbar, our fold toggle and
				// line tag, and can hold links, all of which keep their own meaning.
				if (
					target.closest(CLAUDIAN_USER_ACTIONS) ??
					target.closest(CLAUDIAN_LINK) ??
					target.closest(`button, .${FOLD_TOGGLE_CLS}, .${SELECTION_TAG_CLS}, .${REFERENCE_CLS}`)
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
					this.openInNewTab(href);
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
	/**
	 * A new tab for the link, even when its note is open already: that is what Cmd/Ctrl-click
	 * asks for. Opened here rather than through `openLinkText`, which Tab Manager takes over
	 * to go to the tab already showing the note — the current one, often, for a link to the
	 * note the conversation is about. A link to a note that doesn't exist yet is left to
	 * `openLinkText`, which creates it.
	 */
	private openInNewTab(href: string): void {
		const { path, subpath } = parseLinktext(href);
		const file = this.app.metadataCache.getFirstLinkpathDest(path, "");
		if (!file) {
			void this.app.workspace.openLinkText(href, "", "tab");
			return;
		}
		void this.app.workspace.getLeaf("tab").openFile(file, { active: true, eState: subpath ? { subpath } : undefined });
	}

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

	/**
	 * The sidebar's Claudian: the one everything here keeps in step with the open note. A
	 * Claudian opened in a tab of its own (a new tab's question, askInTab) isn't it — that one
	 * is a conversation of its own, and taking it for the sidebar's would follow notes in it.
	 */
	private getClaudianLeaf(): WorkspaceLeaf | null {
		return this.app.workspace.getLeavesOfType(CLAUDIAN_VIEW).find((leaf) => this.sidebarOf(leaf) !== null) ?? null;
	}

	/**
	 * The sidebar views that show the open note — Outline, Backlinks — go blank while a
	 * Claudian in a tab of its own is in front, as they do for an empty tab. They follow
	 * file-open, which Obsidian fires only for views it counts as navigation; Claudian's isn't
	 * one, so they kept showing the last note. Making it one would have the next note opened
	 * replace the chat, so they're told directly: no note on the chat, the active one again
	 * when a tab in the main area comes back. `again` blanks them anew after a file-open that
	 * reached them with the chat in front. A pinned or linked view is left be, as Obsidian
	 * leaves it; a sidebar leaf taking focus changes nothing.
	 */
	private syncNoteFollowers(leaf: WorkspaceLeaf | null, again = false): void {
		if (!leaf || leaf.getRoot() !== this.app.workspace.rootSplit) return;
		const chat = leaf.view.getViewType() === CLAUDIAN_VIEW;
		if (chat === this.followersBlank && !(chat && again)) return;
		this.followersBlank = chat;
		const file = chat ? null : this.app.workspace.getActiveFile();
		this.app.workspace.iterateAllLeaves((other) => {
			if (other.getRoot() === this.app.workspace.rootSplit) return;
			const view = other.view as unknown as { onFileOpen?: (file: TFile | null) => void; isLeafBoundToFile?: boolean };
			if (typeof view.onFileOpen === "function" && !view.isLeafBoundToFile) view.onFileOpen(file);
		});
	}

	/**
	 * A Claudian in a tab of its own is a chat, not a note's conversation: its drafts link no
	 * note. Claudian points an unsent draft's chip at whatever note is open (auto-draft) and
	 * locks it there on the first prompt, so each draft is set to no note before that — the
	 * chip's × does the same. A note picked into a draft by hand (explicit-draft) is left be.
	 * Run whenever a draft can have appeared or followed a note: a note opened, the layout
	 * changed, the pointer over the chat, focus, any key or click, a new conversation, a
	 * question about to go.
	 */
	private unlinkTabChats(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(CLAUDIAN_VIEW)) {
			if (this.sidebarOf(leaf) !== null) continue;
			const manager = (leaf.view as unknown as { getTabManager?: () => ClaudianTabManager | null }).getTabManager?.();
			for (const tab of manager?.getAllTabs?.() ?? []) {
				const linked = tab.ui?.linkedContentController;
				if (linked?.getSnapshot?.().mode === "auto-draft") linked.selectExplicit?.(null);
			}
		}
		// The sidebar's draft too, while such a chat is in front: it is that tab's (emptyTab), and
		// a tab with no note links none — but Obsidian's active file is still the last note, so
		// Claudian's auto-draft took that one. Back at a note, followNoteInDraft follows it again.
		if (this.emptyTab()?.view.getViewType() !== CLAUDIAN_VIEW) return;
		const linked = this.getActiveTab()?.ui?.linkedContentController;
		const snapshot = linked?.getSnapshot?.();
		if (snapshot?.mode === "auto-draft" && snapshot.path) linked?.selectExplicit?.(null);
	}

	/**
	 * The Claudian you're in, for keys that act on a conversation (⌘F, ⌘N): the one holding
	 * focus, else the one the pointer last rested on, else the sidebar's.
	 */
	private claudianInUse(): WorkspaceLeaf | null {
		const focused = document.activeElement;
		const leaves = this.app.workspace.getLeavesOfType(CLAUDIAN_VIEW);
		return (
			leaves.find((leaf) => !!focused && leaf.view.containerEl.contains(focused)) ??
			(this.pointerOverClaudian && this.pointerClaudianLeaf && leaves.includes(this.pointerClaudianLeaf)
				? this.pointerClaudianLeaf
				: null) ??
			this.getClaudianLeaf()
		);
	}

	/** The laid-out instance of `selector` in a given Claudian view (see visibleEl). */
	private visibleIn<T extends HTMLElement>(leaf: WorkspaceLeaf | null, selector: string): T | null {
		if (!leaf) return null;
		const els = Array.from(leaf.view.containerEl.querySelectorAll<T>(selector));
		return els.find(onScreen) ?? els[0] ?? null;
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
	 *
	 * No fallback while the front tab holds something else — an empty tab, a PDF: there is
	 * no note being worked in, and ⌘L keeps the leaf it gets here active (keepNoteActive),
	 * which brought a background note's tab to the front.
	 */
	private getNoteLeaf(): WorkspaceLeaf | null {
		const recent = this.app.workspace.getMostRecentLeaf();
		if (recent && this.cmOf(recent)) return recent;
		if (recent && this.sidebarOf(recent) === null) return null;
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
		return els.find(onScreen) ?? els[0] ?? null;
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

/** A composer mounted and taking text. */
type ReadyComposer = ClaudianComposer & { value: string; replaceText: (from: number, to: number, text: string) => void };

/** A tab's composer, if it's mounted and takes text. */
function composerOf(tab: ClaudianTab | null | undefined): ReadyComposer | null {
	const input = tab?.dom?.inputEl as ClaudianComposer | undefined;
	return typeof input?.value === "string" && typeof input.replaceText === "function" ? (input as ReadyComposer) : null;
}
