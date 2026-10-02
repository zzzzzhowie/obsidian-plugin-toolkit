import { debounce, normalizePath, type Plugin, TFile } from "obsidian";

/**
 * Recently opened files, most recent first — the list Go to File shows before anything is
 * typed — shared between devices through the plugin's data.json, which syncs with the vault.
 *
 * Each device records *when* it last opened each file, and a copy arriving from another
 * device is merged entry by entry, keeping the later time. It is never taken wholesale:
 * that is what goes wrong with Obsidian's own recent list, which sits in workspace.json
 * where whichever device saved last overwrites the others'.
 *
 * Taking a file off the list is recorded the same way, with its time, so the removal reaches
 * the other devices instead of their copy bringing the entry back. A file is listed while it
 * was opened more recently than it was taken off. Merging is a per-entry maximum, so it
 * gives the same result in any order and whichever device merges first.
 */

interface Stored {
	/** Path → when it was last opened, in ms. */
	opened?: Record<string, number>;
	/** Path → when it was taken off the list (removed, deleted, renamed away), in ms. */
	removed?: Record<string, number>;
}

const MAX_OPENED = 200;
/** How long a removal is remembered — long enough for every device to have synced it. */
const REMOVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Navigation comes in bursts; one write (and one sync upload) per burst. */
const SAVE_DELAY_MS = 2000;
/** Where the list lived before it was shared: this device's local storage. */
const LEGACY_STORAGE_KEY = "quick-open-history";
/** Where the Recent Files plugin keeps its list — read once, to start from it. */
const RECENT_FILES_DATA = "plugins/recent-files-obsidian/data.json";

export class FileHistory {
	private readonly opened = new Map<string, number>();
	private readonly removed = new Map<string, number>();
	private readonly requestSave = debounce(() => void this.save(), SAVE_DELAY_MS, true);
	private dirty = false;

	constructor(private readonly plugin: Plugin) {}

	private get app(): Plugin["app"] {
		return this.plugin.app;
	}

	async load(): Promise<void> {
		this.merge(await this.plugin.loadData());

		// The list this device kept before it was shared, most recent first. Folded in as
		// opened just now, a millisecond apart, so its order survives.
		const legacy: unknown = this.app.loadLocalStorage(LEGACY_STORAGE_KEY);
		if (Array.isArray(legacy)) {
			const now = Date.now();
			legacy.forEach((path, index) => {
				if (typeof path === "string") this.bump(this.opened, path, now - index);
			});
			this.app.saveLocalStorage(LEGACY_STORAGE_KEY, null);
			this.changed();
		}
	}

	/**
	 * Another device's copy arrived, or is on disk. Fold it in; write back only if this one adds
	 * something. Returns whether the list changed.
	 */
	mergeExternal(data: unknown): boolean {
		const before = this.serialize();
		this.merge(data);
		const after = this.serialize();
		if (!sameAs(after, normalise(data))) this.changed();
		return !sameAs(before, after);
	}

	/** Nothing known yet, on any device. */
	get isEmpty(): boolean {
		return this.opened.size === 0;
	}

	/** Most recent first, only files that still exist. */
	files(): TFile[] {
		const listed = [...this.opened]
			.filter(([path, at]) => at > (this.removed.get(path) ?? 0))
			.sort((a, b) => b[1] - a[1]);
		const files: TFile[] = [];
		for (const [path] of listed) {
			const file = this.app.vault.getFileByPath(path);
			if (file) files.push(file);
		}
		return files;
	}

	record(file: TFile): void {
		this.opened.set(file.path, Date.now());
		this.changed();
	}

	remove(path: string): void {
		this.removed.set(path, Date.now());
		this.changed();
	}

	/** A file or folder moved here. A folder takes everything under it along. */
	rename(oldPath: string, newPath: string): void {
		const prefix = `${oldPath}/`;
		const now = Date.now();
		let moved = false;
		for (const [path, at] of [...this.opened]) {
			if (path !== oldPath && !path.startsWith(prefix)) continue;
			const target = path === oldPath ? newPath : `${newPath}/${path.slice(prefix.length)}`;
			// Keeps its place in the list. The old path is taken off on every device: they see
			// the move as one file deleted and another created, and wouldn't know to carry it.
			this.bump(this.opened, target, at);
			this.removed.set(path, now);
			moved = true;
		}
		if (moved) this.changed();
	}

	/** A file or folder was deleted. */
	delete(path: string): void {
		const prefix = `${path}/`;
		const now = Date.now();
		let found = false;
		for (const entry of this.opened.keys()) {
			if (entry !== path && !entry.startsWith(prefix)) continue;
			this.removed.set(entry, now);
			found = true;
		}
		if (found) this.changed();
	}

	/**
	 * First run on any device: start from what's already known — Obsidian's own recent list,
	 * then the Recent Files plugin's. They're dated at the start of 1970, in order, so that
	 * anything really opened on any device, now or later, ranks above them.
	 */
	async seed(): Promise<void> {
		const known = [...this.app.workspace.getLastOpenFiles(), ...(await this.recentFilesPluginPaths())];
		const paths = [...new Set(known)].filter((path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile);
		paths.forEach((path, index) => this.bump(this.opened, path, paths.length - index));
		if (paths.length > 0) this.changed();
	}

	/** Write now if a save is waiting — on quit, and when the plugin unloads. */
	async flush(): Promise<void> {
		if (!this.dirty) return;
		this.requestSave.cancel();
		await this.save();
	}

	// --- Internals -----------------------------------------------------------------------

	private merge(data: unknown): void {
		const stored = normalise(data);
		for (const [path, at] of Object.entries(stored.opened ?? {})) this.bump(this.opened, path, at);
		for (const [path, at] of Object.entries(stored.removed ?? {})) this.bump(this.removed, path, at);
		this.prune();
	}

	private bump(map: Map<string, number>, path: string, at: number): void {
		if (at > (map.get(path) ?? -Infinity)) map.set(path, at);
	}

	private changed(): void {
		this.prune();
		this.dirty = true;
		this.requestSave();
	}

	private prune(): void {
		if (this.opened.size > MAX_OPENED) {
			const keep = new Set(
				[...this.opened]
					.sort((a, b) => b[1] - a[1])
					.slice(0, MAX_OPENED)
					.map(([path]) => path),
			);
			for (const path of [...this.opened.keys()]) if (!keep.has(path)) this.opened.delete(path);
		}
		const expired = Date.now() - REMOVAL_TTL_MS;
		for (const [path, at] of [...this.removed]) if (at < expired) this.removed.delete(path);
	}

	private serialize(): Required<Stored> {
		return { opened: toRecord(this.opened), removed: toRecord(this.removed) };
	}

	private async save(): Promise<void> {
		this.dirty = false;
		await this.plugin.saveData(this.serialize());
	}

	private async recentFilesPluginPaths(): Promise<string[]> {
		try {
			const raw = await this.app.vault.adapter.read(normalizePath(`${this.app.vault.configDir}/${RECENT_FILES_DATA}`));
			const data = JSON.parse(raw) as { recentFiles?: { path?: unknown }[] };
			return (data.recentFiles ?? []).flatMap((entry) => (typeof entry.path === "string" ? [entry.path] : []));
		} catch {
			// Not installed, or never used in this vault.
			return [];
		}
	}
}

/** `data` as stored, with anything malformed dropped. */
function normalise(data: unknown): Required<Stored> {
	const raw = (data ?? {}) as Stored;
	return { opened: numbers(raw.opened), removed: numbers(raw.removed) };
}

function numbers(value: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (!value || typeof value !== "object") return out;
	for (const [key, at] of Object.entries(value as Record<string, unknown>)) {
		if (typeof at === "number" && Number.isFinite(at)) out[key] = at;
	}
	return out;
}

function toRecord(map: Map<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, value] of map) out[key] = value;
	return out;
}

function sameAs(a: Required<Stored>, b: Required<Stored>): boolean {
	return sameRecord(a.opened, b.opened) && sameRecord(a.removed, b.removed);
}

function sameRecord(a: Record<string, number>, b: Record<string, number>): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
