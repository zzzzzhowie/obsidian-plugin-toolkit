import { type App, setIcon, type WorkspaceLeaf } from "obsidian";

/**
 * What Claudian reports about a conversation — the source of its own session-list badges
 * (`sessionNavigation.getConversationStatus`). `attention` is "action-required" while it
 * waits on an approval or a question, "review" once a turn settled unseen, with its outcome.
 */
interface ConversationStatus {
	isRunning?: boolean;
	attention?: { kind?: string; outcome?: string } | null;
}

/** The bits of Claudian's view this reads; every hop optional, as elsewhere. */
export interface ClaudianStatusSource {
	plugin?: {
		getConversationList?: () => { id?: string; linkedContentPath?: string | null; isArchived?: boolean }[];
	};
	sessionNavigation?: { getConversationStatus?: (id: string) => ConversationStatus };
}

type StatusKind = "action-required" | "running" | "error" | "unread";

/** Most urgent first, the order Claudian picks a session's one badge in. */
const URGENCY: StatusKind[] = ["action-required", "running", "error", "unread"];

/** Claudian's own icons and labels; unread is a dot drawn in styles.css. */
const PRESENTATION: Record<StatusKind, { icon: string | null; label: string }> = {
	"action-required": { icon: "alert-circle", label: "Claudian needs your input" },
	running: { icon: "loader-2", label: "Claudian is running" },
	error: { icon: "x-circle", label: "Claudian stopped with an error" },
	unread: { icon: null, label: "Claudian finished, unread" },
};

const STATUS_CLS = "claudian-enhanced-tab-status";

function kindOf(status: ConversationStatus | undefined): StatusKind | null {
	if (!status) return null;
	if (status.attention?.kind === "action-required") return "action-required";
	if (status.isRunning) return "running";
	if (status.attention?.kind === "review") return status.attention.outcome === "error" ? "error" : "unread";
	return null;
}

/**
 * On each note's tab, how its Claudian conversations are doing: waiting on you, running,
 * stopped with an error, or finished and not yet seen — the badge Claudian's session list
 * gives them, where the tabs are. A note's conversations are the ones linked to it; a reply
 * left running in the background when the note was left still counts, and the most urgent
 * of them shows. Nothing shows for a note with nothing going on.
 *
 * Sits in front of the tab's title, where it reads first and doesn't move as the title is cut
 * short to fit.
 */
export class NoteTabStatus {
	constructor(
		private readonly app: App,
		private readonly source: () => ClaudianStatusSource | null,
	) {}

	sync(): void {
		const tabs: { leaf: WorkspaceLeaf; path: string }[] = [];
		const { leftSplit, rightSplit } = this.app.workspace;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const root = leaf.getRoot();
			if (root === leftSplit || root === rightSplit) return;
			// From the view state, which a background tab not built yet still has.
			const path = leaf.getViewState().state?.file;
			if (typeof path === "string") tabs.push({ leaf, path });
		});
		const kinds = this.kindsByNote(new Set(tabs.map((tab) => tab.path)));
		for (const { leaf, path } of tabs) this.mark(leaf, kinds.get(path) ?? null);
	}

	clear(): void {
		this.app.workspace.iterateAllLeaves((leaf) => this.mark(leaf, null));
	}

	/** The most urgent status of each open note's conversations. */
	private kindsByNote(open: Set<string>): Map<string, StatusKind> {
		const kinds = new Map<string, StatusKind>();
		const source = this.source();
		if (!source) return kinds;
		const status = source.sessionNavigation?.getConversationStatus;
		const list = source.plugin?.getConversationList;
		if (typeof status !== "function" || typeof list !== "function") return kinds;
		for (const conversation of list.call(source.plugin) ?? []) {
			const path = conversation.linkedContentPath;
			if (!conversation.id || conversation.isArchived || !path || !open.has(path)) continue;
			const kind = kindOf(status.call(source.sessionNavigation, conversation.id));
			if (!kind) continue;
			const shown = kinds.get(path);
			if (!shown || URGENCY.indexOf(kind) < URGENCY.indexOf(shown)) kinds.set(path, kind);
		}
		return kinds;
	}

	private mark(leaf: WorkspaceLeaf, kind: StatusKind | null): void {
		const title = (leaf as unknown as { tabHeaderInnerTitleEl?: HTMLElement }).tabHeaderInnerTitleEl;
		const header = title?.parentElement;
		if (!title || !header) return;
		let icon = header.querySelector<HTMLElement>(`:scope > .${STATUS_CLS}`);
		if (!kind) {
			icon?.remove();
			return;
		}
		// Only on a change: this runs every second, and a rebuilt spinner restarts its turn.
		if (icon?.dataset.kind === kind) return;
		if (!icon) {
			icon = header.createDiv();
			title.before(icon);
		}
		icon.empty();
		icon.className = `${STATUS_CLS} is-${kind}`;
		icon.dataset.kind = kind;
		const { icon: name, label } = PRESENTATION[kind];
		icon.setAttribute("aria-label", label);
		if (name) setIcon(icon, name);
	}
}
