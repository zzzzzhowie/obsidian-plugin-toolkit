import { type App, normalizePath, type TAbstractFile, TFile } from "obsidian";

/**
 * Where drafts live. Inside the vault, because Obsidian can only open a note that is: a draft
 * is a real Markdown file, so everything that works in a note (paste handlers, images,
 * Claudian, comments) works in a draft too. Out of sight all the same — hidden from the file
 * explorer (styles.css), listed under Excluded files so search and the graph skip it, and in
 * vault-backup's default ignore list.
 */
export const DRAFTS_FOLDER = "_drafts";

/** What a draft is called until it's saved, as VS Code's "Untitled-1". */
const DRAFT_NAME = "Untitled";

/** A note directly in the drafts folder. */
export function isDraft(file: TAbstractFile | null | undefined): boolean {
	return file instanceof TFile && file.extension === "md" && file.parent?.path === DRAFTS_FOLDER;
}

/** Every draft, most recently changed first. */
export function allDrafts(app: App): TFile[] {
	return app.vault
		.getFiles()
		.filter((file) => isDraft(file))
		.sort((a, b) => b.stat.mtime - a.stat.mtime);
}

export async function createDraft(app: App): Promise<TFile> {
	if (!app.vault.getFolderByPath(DRAFTS_FOLDER)) await app.vault.createFolder(DRAFTS_FOLDER);
	return app.vault.create(availablePath(app, DRAFTS_FOLDER, DRAFT_NAME), "");
}

/** `folder/name.md`, or `name 1.md`, `name 2.md`… when that's taken. */
export function availablePath(app: App, folder: string, name: string): string {
	const at = (n: number): string => normalizePath(`${folder}/${n === 0 ? name : `${name} ${n}`}.md`);
	let n = 0;
	while (app.vault.getAbstractFileByPath(at(n))) n++;
	return at(n);
}

/**
 * A file name for a draft being saved: its first line of text, as VS Code suggests — without
 * the frontmatter, the heading or list marker in front of it, inline markup, or the characters
 * a file name can't hold.
 */
export function suggestName(text: string): string {
	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
	const line = body
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	const plain = (line ?? "")
		.replace(/^(?:#{1,6}\s+|[-*+]\s+(?:\[.\]\s+)?|>\s*|\d+[.)]\s+)/, "")
		.replace(/[*_`~=]|\[\[|\]\]/g, "");
	const name = plain
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80)
		.trim();
	return name || DRAFT_NAME;
}
