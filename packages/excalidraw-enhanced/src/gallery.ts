import { type App, MarkdownView, type TFile } from "obsidian";
import type { Gallery, ZoomTarget } from "../../../shared/zoom-overlay";

/** The part of Excalidraw's automation API used here. */
interface ExcalidrawAutomate {
	reset(): void;
	createSVG(path: string, embedFont?: boolean): Promise<SVGSVGElement>;
	destroy?(): void;
}

interface ExcalidrawAutomateRoot {
	getAPI?(): ExcalidrawAutomate;
}

/** A drawing embedded in the note: its file and the embed's line. */
interface Embedded {
	file: TFile;
	line: number;
	alias: string;
}

/**
 * Every drawing embedded in a note, for the zoom to page through from the one clicked — as
 * Mermaid (Enhanced) pages through a note's diagrams. Read from the note's embeds rather than
 * the page, where Live Preview and reading view keep only the ones near the screen; the
 * others are drawn by Excalidraw itself (its automation API's createSVG, in its own theme
 * settings), as inline SVG whose text can be selected.
 */
export class DrawingGallery {
	/** One automation instance for the session: Excalidraw keeps every one handed out. */
	private ea: ExcalidrawAutomate | null = null;
	/** Drawings drawn for the zoom, by path and modification time. */
	private readonly drawn = new Map<string, Promise<ZoomTarget | null>>();
	/** Excalidraw draws one at a time through an instance; requests wait their turn here. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly app: App) {}

	destroy(): void {
		this.ea?.destroy?.();
		this.ea = null;
		this.drawn.clear();
	}

	readonly around = (target: ZoomTarget): Promise<Gallery | null> => {
		const view = this.viewOf(target);
		const file = view?.file;
		if (!view || !file) return Promise.resolve(null);
		const drawings = this.embedded(file);
		if (drawings.length < 2) return Promise.resolve(null);
		const clicked = this.drawingOf(target, file);
		const index = clicked ? drawings.findIndex((d) => d.file.path === clicked.path) : -1;
		if (index < 0) return Promise.resolve(null);
		const lines = view.getViewData().split("\n");
		return Promise.resolve({
			index,
			items: drawings.map((drawing, i) => ({
				label: labelOf(drawing, lines),
				element: () => (i === index ? Promise.resolve(target) : this.draw(drawing.file)),
			})),
		});
	};

	/** The note view a drawing on the page is in. */
	private viewOf(target: ZoomTarget): MarkdownView | null {
		let found: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!found && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(target)) found = leaf.view;
		});
		return found;
	}

	/** The note's embeds that are drawings, in order. */
	private embedded(note: TFile): Embedded[] {
		const embeds = this.app.metadataCache.getFileCache(note)?.embeds ?? [];
		const drawings: Embedded[] = [];
		for (const embed of embeds) {
			const file = this.app.metadataCache.getFirstLinkpathDest(embed.link.split("#")[0] ?? "", note.path);
			if (!file || !isDrawing(file)) continue;
			drawings.push({ file, line: embed.position.start.line, alias: embed.displayText ?? "" });
		}
		return drawings;
	}

	/** The drawing file a clicked element shows: Excalidraw stamps it on the image, or the embed names it. */
	private drawingOf(target: ZoomTarget, note: TFile): TFile | null {
		const source = target.closest("[filesource]")?.getAttribute("filesource");
		if (source) {
			const file = this.app.vault.getFileByPath(source) ?? this.app.vault.getFileByPath(`${source}.md`);
			if (file) return file;
		}
		const link = target.closest(".internal-embed")?.getAttribute("src");
		return link ? this.app.metadataCache.getFirstLinkpathDest(link, note.path) : null;
	}

	/** Draw a drawing off the page, once per version of its file. */
	private draw(file: TFile): Promise<ZoomTarget | null> {
		const key = `${file.path}@${file.stat.mtime}`;
		let drawn = this.drawn.get(key);
		if (!drawn) {
			drawn = this.queue.then(async () => {
				const ea = this.automate();
				if (!ea) return null;
				ea.reset();
				return ea.createSVG(file.path, true);
			}).catch((error: unknown) => {
				console.error("excalidraw-enhanced: couldn't draw a drawing for the zoom", error);
				this.drawn.delete(key);
				return null;
			});
			this.queue = drawn;
			this.drawn.set(key, drawn);
		}
		return drawn;
	}

	private automate(): ExcalidrawAutomate | null {
		if (!this.ea) {
			const root = (window as unknown as { ExcalidrawAutomate?: ExcalidrawAutomateRoot }).ExcalidrawAutomate;
			this.ea = root?.getAPI?.() ?? null;
		}
		return this.ea;
	}
}

function isDrawing(file: TFile): boolean {
	return file.extension === "excalidraw" || file.path.endsWith(".excalidraw.md");
}

/**
 * A drawing's name under its thumbnail: the embed's alias when it is one (not a size such as
 * `|800`), else the heading the embed sits under, else the file's name.
 */
function labelOf(drawing: Embedded, lines: string[]): string {
	const alias = drawing.alias.trim();
	if (alias && !/^\d+(x\d+)?$/.test(alias) && !drawing.file.path.includes(alias)) return alias;
	for (let i = drawing.line - 1; i >= 0; i--) {
		const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? "");
		if (heading?.[1]) return heading[1];
	}
	return drawing.file.basename.replace(/\.excalidraw$/, "");
}
