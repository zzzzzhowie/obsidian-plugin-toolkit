import { Notice, TFile, type Plugin } from "obsidian";

import type { Selectors } from "./anchor";

/**
 * Comments live beside the note, never in it: the note's Markdown is not touched, so nothing
 * that reads or rewrites notes — git, Claudian, another editor — ever sees them.
 *
 * This store is the single source of truth. Editors only ever *report* where the comments
 * they are drawing have moved to; they never delete one or decide it is lost. That is what
 * makes a transient empty editor state, or a second pane a few keystrokes behind, harmless.
 */

export interface NoteComment extends Selectors {
	id: string;
	body: string;
	createdAt: number;
	/** Last change to the body. Decides which device wins when the text differs. */
	updatedAt: number;
	/** Last time an editor refreshed the selectors. Decides which device wins on position. */
	anchoredAt: number;
}

interface Trashed {
	comments: NoteComment[];
	deletedAt: number;
}

interface StoredData {
	version: 1;
	files: Record<string, NoteComment[]>;
	/** Comments of deleted notes, kept so a note that comes back gets them back. */
	trash: Record<string, Trashed>;
	/** Deleted comment id → when. Stops another device's stale copy resurrecting it. */
	tombstones: Record<string, number>;
}

/** Told about comments appearing and disappearing, so open editors can draw or drop them. */
export interface StoreListener {
	added(path: string, comment: NoteComment): void;
	removed(path: string, id: string): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A sync service often delivers another machine's rename here as a delete plus a create,
 * so a deleted note's comments are held for a while instead of dropped on the spot.
 */
const TRASH_DAYS = 30;
/** A read or write of data.json taking longer than this is given up on, so saving can't stall. */
const WRITE_TIMEOUT_MS = 15_000;
const TOMBSTONE_DAYS = 90;

export class CommentStore {
	private data: StoredData = emptyData();
	/**
	 * Set when data.json exists but could not be read. Writing then would replace every
	 * comment with an empty store, so nothing is written until the file is fixed.
	 */
	readOnly = false;
	/** Set once the plugin unloads; stale editor extensions left in canvas or popovers check it. */
	disposed = false;
	listener: StoreListener | null = null;
	/** Anything showing comments — the panel — told which note's comments changed ("*" = any). */
	private readonly changeHandlers = new Set<(path: string) => void>();

	/** What is on disk as far as this instance knows — a write that would not change it is skipped. */
	private lastWritten = "";
	private backedUp = false;
	private saving: Promise<void> | null = null;
	private saveAgain = false;
	private saveTimer: number | null = null;

	constructor(private readonly plugin: Plugin) {}

	async load(): Promise<void> {
		const raw: unknown = await this.plugin.loadData();
		// Obsidian's loadData resolves `null` when the file is absent and `undefined` when it
		// exists but won't parse. Only the first is an empty store; the second is a store we
		// cannot see, and must not overwrite. Writes aren't atomic, so this does happen.
		if (raw === undefined) {
			this.readOnly = true;
			new Notice(
				"Note comments could not read its data file, so comments are read-only until it is fixed. Nothing has been overwritten.",
				0,
			);
			return;
		}
		this.data = normalise(raw);
		this.lastWritten = JSON.stringify(this.data);
		if (this.purge()) this.scheduleSave();
	}

	onChange(handler: (path: string) => void): () => void {
		this.changeHandlers.add(handler);
		return () => this.changeHandlers.delete(handler);
	}

	private emit(path: string): void {
		for (const handler of this.changeHandlers) handler(path);
	}

	commentsFor(path: string): readonly NoteComment[] {
		return this.data.files[path] ?? [];
	}

	get(path: string, id: string): NoteComment | undefined {
		return this.data.files[path]?.find((comment) => comment.id === id);
	}

	create(path: string, selectors: Selectors, body: string): NoteComment {
		const now = Date.now();
		const comment: NoteComment = {
			...pickSelectors(selectors),
			id: crypto.randomUUID(),
			body,
			createdAt: now,
			updatedAt: now,
			anchoredAt: now,
		};
		(this.data.files[path] ??= []).push(comment);
		void this.save();
		this.listener?.added(path, comment);
		this.emit(path);
		return comment;
	}

	updateBody(path: string, id: string, body: string): void {
		const comment = this.get(path, id);
		if (!comment || comment.body === body) return;
		comment.body = body;
		comment.updatedAt = Date.now();
		void this.save();
		this.emit(path);
	}

	/** Remove a comment; returns it so the caller can offer an undo. */
	remove(path: string, id: string): NoteComment | null {
		const list = this.data.files[path];
		const index = list?.findIndex((comment) => comment.id === id) ?? -1;
		if (!list || index < 0) return null;
		const [comment] = list.splice(index, 1);
		if (list.length === 0) delete this.data.files[path];
		this.data.tombstones[id] = Date.now();
		void this.save();
		this.listener?.removed(path, id);
		this.emit(path);
		return comment ?? null;
	}

	restore(path: string, comment: NoteComment): void {
		delete this.data.tombstones[comment.id];
		(this.data.files[path] ??= []).push(comment);
		void this.save();
		this.listener?.added(path, comment);
		this.emit(path);
	}

	/**
	 * Take the positions an editor reports for the comments it is drawing. Only ids that still
	 * exist are touched, and `updatedAt` is left alone — a position refresh is not an edit, and
	 * must not win a merge against a body changed on the other machine.
	 *
	 * Not written immediately: positions are hints, and rewriting data.json on every keystroke
	 * would mean a constant stream of iCloud uploads, each reloading the file on the other Mac.
	 */
	updatePositions(path: string, reported: ReadonlyMap<string, Selectors>): boolean {
		const list = this.data.files[path];
		if (!list) return false;
		const now = Date.now();
		let moved = false;
		for (const comment of list) {
			const next = reported.get(comment.id);
			if (!next || sameSelectors(comment, next)) continue;
			Object.assign(comment, pickSelectors(next));
			comment.anchoredAt = now;
			moved = true;
		}
		return moved;
	}

	/**
	 * Follow a rename or move. A folder rename arrives as the folder followed by each of its
	 * descendants, so the prefix rewrite has to be idempotent; the writes are coalesced below.
	 */
	rename(oldPath: string, newPath: string): void {
		let changed = false;
		for (const key of Object.keys(this.data.files)) {
			const next = movedPath(key, oldPath, newPath);
			const moving = this.data.files[key];
			if (next === null || !moving) continue;
			delete this.data.files[key];
			this.data.files[next] = [...(this.data.files[next] ?? []), ...moving];
			changed = true;
		}
		for (const key of Object.keys(this.data.trash)) {
			const next = movedPath(key, oldPath, newPath);
			const parked = this.data.trash[key];
			if (next === null || !parked) continue;
			delete this.data.trash[key];
			this.data.trash[next] = parked;
			changed = true;
		}
		if (changed) {
			this.scheduleSave();
			this.emit("*");
		}
	}

	/** A note was deleted: park its comments rather than drop them. */
	trashPath(path: string): void {
		let changed = false;
		const now = Date.now();
		for (const key of Object.keys(this.data.files)) {
			if (key !== path && !key.startsWith(`${path}/`)) continue;
			const comments = this.data.files[key];
			if (comments?.length) this.data.trash[key] = { comments, deletedAt: now };
			delete this.data.files[key];
			changed = true;
		}
		if (changed) {
			this.scheduleSave();
			this.emit("*");
		}
	}

	/** A note appeared at a path whose comments are in the trash: give them back. */
	restoreFromTrash(path: string): void {
		const parked = this.data.trash[path];
		if (!parked) return;
		delete this.data.trash[path];
		const list = (this.data.files[path] ??= []);
		for (const comment of parked.comments) {
			list.push(comment);
			this.listener?.added(path, comment);
		}
		this.scheduleSave();
		this.emit(path);
	}

	/**
	 * Fold in data.json as another device wrote it.
	 *
	 * Replacing the in-memory store would be simpler and wrong: this machine's store would then
	 * silently lose anything not yet written. Not merging at all is worse — the next write from
	 * here would overwrite the other machine's comments even though nobody edited at the same
	 * time. So merge by id: body by `updatedAt`, position by `anchoredAt`, deletions by tombstone.
	 */
	mergeExternal(raw: unknown): void {
		if (raw === null || raw === undefined || this.disposed) return;
		const incoming = this.mergeIn(raw);
		// What the other machine wrote is what is on disk now. Compare against it, so a merge
		// that brings nothing new doesn't bounce the same file straight back.
		this.lastWritten = JSON.stringify(incoming);
		this.scheduleSave();
		this.emit("*");
	}

	/** Fold `raw` (data.json as some device wrote it) into the store; returns it normalised. */
	private mergeIn(raw: unknown): StoredData {
		const incoming = normalise(raw);

		for (const [id, at] of Object.entries(incoming.tombstones)) {
			this.data.tombstones[id] = Math.max(this.data.tombstones[id] ?? 0, at);
		}
		const dead = this.data.tombstones;
		// A deletion only beats edits made before it. One machine deleting a comment and the
		// other editing it afterwards is an edit the user made last; letting the older deletion
		// win dropped it silently, and neither machine kept a trace.
		const deletedAfter = (comment: NoteComment): boolean => {
			const at = dead[comment.id];
			return at !== undefined && at >= comment.updatedAt;
		};

		// Where each id lives on either side, so a rename made on the other machine moves the
		// comment instead of leaving a copy under the old path.
		const incomingPath = new Map<string, string>();
		for (const [path, list] of Object.entries(incoming.files)) {
			for (const comment of list) incomingPath.set(comment.id, path);
		}

		for (const [path, list] of Object.entries(this.data.files)) {
			for (const comment of [...list]) {
				// Edited here after the other machine deleted it: keep it, and void the deletion
				// so it doesn't travel back and take the comment with it.
				if (dead[comment.id] !== undefined && !deletedAfter(comment)) delete dead[comment.id];
				const elsewhere = incomingPath.get(comment.id);
				if (deletedAfter(comment) || (elsewhere !== undefined && elsewhere !== path && this.fileExists(elsewhere))) {
					list.splice(list.indexOf(comment), 1);
					this.listener?.removed(path, comment.id);
				}
			}
			if (list.length === 0) delete this.data.files[path];
		}

		for (const [path, list] of Object.entries(incoming.files)) {
			for (const remote of list) {
				if (deletedAfter(remote)) continue;
				// Edited after it was deleted somewhere: the edit wins, and the deletion is void.
				delete dead[remote.id];
				const local = this.findAnywhere(remote.id);
				if (!local) {
					(this.data.files[path] ??= []).push(remote);
					this.listener?.added(path, remote);
					continue;
				}
				if (remote.updatedAt > local.updatedAt) {
					local.body = remote.body;
					local.updatedAt = remote.updatedAt;
				}
				if (remote.anchoredAt > local.anchoredAt) {
					Object.assign(local, pickSelectors(remote));
					local.anchoredAt = remote.anchoredAt;
				}
			}
		}

		for (const [path, parked] of Object.entries(incoming.trash)) {
			const mine = this.data.trash[path];
			if (!mine || parked.deletedAt > mine.deletedAt) this.data.trash[path] = parked;
		}
		return incoming;
	}

	/** Write now, one write in flight at a time; a change during a write triggers one more. */
	async save(): Promise<void> {
		if (this.readOnly || this.disposed) return;
		if (this.saving) {
			this.saveAgain = true;
			return this.saving;
		}
		this.saving = (async () => {
			try {
				do {
					this.saveAgain = false;
					await this.writeMerged();
				} while (this.saveAgain);
			} catch (error) {
				console.error("Note comments: saving failed; the next change will try again", error);
			} finally {
				this.saving = null;
			}
		})();
		return this.saving;
	}

	/**
	 * One write: read what's on disk first and fold it in, then write the result.
	 *
	 * Writing this store as it is would be enough if every other device's write were always
	 * merged in here first — but a phone doesn't reliably notice data.json arriving through
	 * iCloud, and a store loaded before another device's comment was written knows nothing of
	 * it. Its next write then replaced the file, comment gone, with nothing to show it ever
	 * existed. Reading first means a write here can only add to what's there.
	 *
	 * Bounded in time: a write that never settles used to hold `saving` for good, and every
	 * later change was quietly never written.
	 */
	private async writeMerged(): Promise<void> {
		const onDisk: unknown = await withTimeout(this.plugin.loadData(), WRITE_TIMEOUT_MS);
		// `undefined`: the file is there but won't parse (half-written by sync) — write ours.
		if (onDisk !== null && onDisk !== undefined && JSON.stringify(normalise(onDisk)) !== this.lastWritten) {
			this.mergeIn(onDisk);
			this.emit("*");
		}
		const text = JSON.stringify(this.data);
		if (text === this.lastWritten) return;
		if (!this.backedUp) await this.backup();
		await withTimeout(this.plugin.saveData(this.data), WRITE_TIMEOUT_MS);
		this.lastWritten = text;
	}

	/** Coalesce a burst of changes (a folder rename, a merge) into one write. */
	scheduleSave(delayMs = 500): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, delayMs);
	}

	/**
	 * Called from onunload. The write is queued, not awaited: Obsidian's adapter runs reads
	 * and writes through one serial queue, so it still lands before a re-enabled instance's
	 * loadData reads the file — whereas awaiting would let unload finish without it.
	 */
	flushOnUnload(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		if (!this.readOnly && JSON.stringify(this.data) !== this.lastWritten) {
			void this.plugin.saveData(this.data);
		}
		this.disposed = true;
	}

	/** Returns whether anything was dropped. */
	private purge(): boolean {
		const now = Date.now();
		let changed = false;
		for (const [path, parked] of Object.entries(this.data.trash)) {
			if (now - parked.deletedAt > TRASH_DAYS * DAY_MS) {
				delete this.data.trash[path];
				changed = true;
			}
		}
		for (const [id, at] of Object.entries(this.data.tombstones)) {
			if (now - at > TOMBSTONE_DAYS * DAY_MS) {
				delete this.data.tombstones[id];
				changed = true;
			}
		}
		return changed;
	}

	/**
	 * Before the first write of a session, keep a copy of what was there. Writes are not
	 * atomic, and this file holds the only copy of every comment.
	 */
	private async backup(): Promise<void> {
		this.backedUp = true;
		const dir = this.plugin.manifest.dir;
		if (!dir) return;
		const adapter = this.plugin.app.vault.adapter;
		const source = `${dir}/data.json`;
		try {
			if (await adapter.exists(source)) {
				await adapter.write(`${dir}/data.backup.json`, await adapter.read(source));
			}
		} catch (error) {
			console.error("Note comments: could not back up data.json", error);
		}
	}

	private findAnywhere(id: string): NoteComment | undefined {
		for (const list of Object.values(this.data.files)) {
			const found = list.find((comment) => comment.id === id);
			if (found) return found;
		}
		return undefined;
	}

	private fileExists(path: string): boolean {
		return this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile;
	}
}

function emptyData(): StoredData {
	return { version: 1, files: {}, trash: {}, tombstones: {} };
}

/** Accept whatever parses, keep only what has the right shape. */
function normalise(raw: unknown): StoredData {
	const data = emptyData();
	if (!raw || typeof raw !== "object") return data;
	const source = raw as Partial<StoredData>;
	for (const [path, list] of Object.entries(source.files ?? {})) {
		const valid = Array.isArray(list) ? list.filter(isComment) : [];
		if (valid.length) data.files[path] = valid;
	}
	for (const [path, parked] of Object.entries(source.trash ?? {})) {
		if (parked && Array.isArray(parked.comments) && typeof parked.deletedAt === "number") {
			data.trash[path] = { comments: parked.comments.filter(isComment), deletedAt: parked.deletedAt };
		}
	}
	for (const [id, at] of Object.entries(source.tombstones ?? {})) {
		if (typeof at === "number") data.tombstones[id] = at;
	}
	return data;
}

function isComment(value: unknown): value is NoteComment {
	if (!value || typeof value !== "object") return false;
	const c = value as Record<string, unknown>;
	return (
		typeof c.id === "string" &&
		typeof c.body === "string" &&
		typeof c.exact === "string" &&
		typeof c.prefix === "string" &&
		typeof c.suffix === "string" &&
		typeof c.start === "number" &&
		typeof c.end === "number"
	);
}

function pickSelectors(s: Selectors): Selectors {
	return { exact: s.exact, prefix: s.prefix, suffix: s.suffix, start: s.start, end: s.end };
}

function sameSelectors(a: Selectors, b: Selectors): boolean {
	return (
		a.start === b.start &&
		a.end === b.end &&
		a.exact === b.exact &&
		a.prefix === b.prefix &&
		a.suffix === b.suffix
	);
}

function movedPath(path: string, oldPath: string, newPath: string): string | null {
	if (path === oldPath) return newPath;
	if (path.startsWith(`${oldPath}/`)) return `${newPath}/${path.slice(oldPath.length + 1)}`;
	return null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
		work.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				window.clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}
