import { setIcon } from "obsidian";

/** A Code session in the Claude desktop app, as its sidebar lists it. */
export interface DesktopSession {
	title: string;
	/** The folder it runs in. */
	cwd: string;
	/** Its Claude Code session: the transcript `<config>/projects/<cwd, dashed>/<id>.jsonl`. */
	cliSessionId: string;
	transcript: string;
	lastActivityAt: number;
	starred: boolean;
}

/** Sessions listed at most; the app keeps thousands, read newest first until this many. */
const LIMIT = 200;
/** Records read at once. */
const BATCH = 64;

function nodeRequire<T>(id: string): T {
	return (window as unknown as { require: (id: string) => T }).require(id);
}

/** Claude Code's config folder, where every session's transcript is: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(): string {
	const path = nodeRequire<typeof import("path")>("path");
	const os = nodeRequire<typeof import("os")>("os");
	const { env } = nodeRequire<typeof import("process")>("process");
	return env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/** The folder Claude Code keeps `cwd`'s transcripts in: its path with every other character a dash. */
export function projectDir(cwd: string): string {
	const path = nodeRequire<typeof import("path")>("path");
	return path.join(claudeConfigDir(), "projects", path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
}

/**
 * The desktop app's Code sessions, most recently active first, starred ones not set apart:
 * its records (`claude-code-sessions/<account>/<org>/local_<id>.json`) read newest file
 * first, archived ones and ones whose transcript isn't on this machine left out.
 */
export async function listDesktopSessions(): Promise<DesktopSession[]> {
	const { promises: fs } = nodeRequire<typeof import("fs")>("fs");
	const path = nodeRequire<typeof import("path")>("path");
	const os = nodeRequire<typeof import("os")>("os");
	const root = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
	const list = async (dir: string): Promise<string[]> => fs.readdir(dir).catch(() => []);
	const records: string[] = [];
	for (const account of await list(root)) {
		for (const org of await list(path.join(root, account))) {
			const dir = path.join(root, account, org);
			for (const name of await list(dir)) if (/^local_[\w-]+\.json$/.test(name)) records.push(path.join(dir, name));
		}
	}
	// Stat'd all at once: thousands of them, one after another, took most of a second.
	const files = (await Promise.all(records.map(async (file) => ({ file, mtime: (await fs.stat(file).catch(() => null))?.mtimeMs ?? -1 })))).filter(({ mtime }) => mtime >= 0);
	files.sort((a, b) => b.mtime - a.mtime);
	const read = async (file: string): Promise<DesktopSession | null> => {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
		} catch {
			return null;
		}
		const id = record.cliSessionId;
		const cwd = record.cwd;
		if (record.isArchived === true || typeof id !== "string" || !/^[\w-]+$/.test(id) || typeof cwd !== "string") return null;
		const transcript = path.join(projectDir(cwd), `${id}.jsonl`);
		if (!(await fs.stat(transcript).catch(() => null))) return null;
		return {
			title: typeof record.title === "string" && record.title ? record.title : "Untitled",
			cwd,
			cliSessionId: id,
			transcript,
			lastActivityAt: typeof record.lastActivityAt === "number" ? record.lastActivityAt : 0,
			starred: record.isStarred === true,
		};
	};
	// Read a batch at a time, newest first, until there are enough.
	const sessions: DesktopSession[] = [];
	for (let at = 0; at < files.length && sessions.length < LIMIT; at += BATCH) {
		for (const session of await Promise.all(files.slice(at, at + BATCH).map(({ file }) => read(file)))) {
			if (session && sessions.length < LIMIT) sessions.push(session);
		}
	}
	return sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/**
 * Copy a desktop session's transcript into `into` (the vault's transcripts folder) under a
 * new id, as `claude --resume --fork-session` would: old lines keep the parent's sessionId,
 * and a title line names it. The desktop session goes on as it was. The new id.
 */
export async function copyDesktopSession(session: DesktopSession, into: string): Promise<string> {
	const { promises: fs } = nodeRequire<typeof import("fs")>("fs");
	const path = nodeRequire<typeof import("path")>("path");
	const id = crypto.randomUUID();
	const file = path.join(into, `${id}.jsonl`);
	await fs.mkdir(into, { recursive: true });
	await fs.copyFile(session.transcript, file);
	await fs.appendFile(file, JSON.stringify({ type: "custom-title", customTitle: session.title, sessionId: id }) + "\n");
	return id;
}

/** As Claudian's history dates them: the time today (16:02), else the day (Nov 9). */
function when(at: number): string {
	const date = new Date(at);
	if (new Date().toDateString() === date.toDateString()) return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Fill `menu` — a `claudian-history-menu` of our own — as Claudian draws its history: a header,
 * then a row a session, its title and when it was last active, the folder it ran in beside that
 * when it isn't the home folder. Claudian's styles do the rest.
 */
export function renderDesktopSessions(menu: HTMLElement, sessions: DesktopSession[] | null, onPick: (session: DesktopSession) => void): void {
	menu.empty();
	menu.createDiv({ cls: "claudian-history-header" }).createSpan({ text: "Claude desktop" });
	const list = menu.createDiv({ cls: "claudian-history-list" });
	if (!sessions || !sessions.length) {
		list.createDiv({ cls: "claudian-history-empty", text: sessions ? "No desktop sessions" : "Loading…" });
		return;
	}
	const os = nodeRequire<typeof import("os")>("os");
	const home = os.homedir();
	for (const session of sessions) {
		const item = list.createDiv({ cls: "claudian-history-item" });
		setIcon(item.createDiv({ cls: "claudian-history-item-icon" }), session.starred ? "star" : "message-square");
		const content = item.createDiv({ cls: "claudian-history-item-content", attr: { tabindex: "0", role: "button" } });
		content.createDiv({ cls: "claudian-history-item-title", text: session.title, attr: { title: session.title } });
		const folder = session.cwd === home ? "" : ` · ${session.cwd.startsWith(home) ? `~${session.cwd.slice(home.length)}` : session.cwd}`;
		content.createDiv({ cls: "claudian-history-item-date", text: `${when(session.lastActivityAt)}${folder}` });
		const pick = (e: Event): void => {
			e.stopPropagation();
			onPick(session);
		};
		item.addEventListener("click", pick);
		content.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				pick(e);
			}
		});
	}
}
