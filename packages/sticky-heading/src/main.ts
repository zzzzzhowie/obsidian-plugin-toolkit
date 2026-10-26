import { MarkdownView, Plugin, setTooltip, type HeadingCache } from "obsidian";

/**
 * The section in view, after the note's title in the tab header — `folder / Note › Heading ›
 * Subheading` — as VS Code's breadcrumbs and sticky scroll show where in a file you are. It
 * follows the scroll, not the cursor: the last heading at or above the note's top line, and
 * each heading that one is under. Clicking one scrolls back to it.
 *
 * In Live Preview, Source and Reading view alike: each mode says which line is at its top
 * (`getScroll`, fractional) and takes a line to scroll to (`applyScroll`), and the metadata
 * cache knows the headings' lines.
 */

const TRAIL_CLS = "sticky-heading-trail";

export default class StickyHeadingPlugin extends Plugin {
	/** What each note's trail shows, so scrolling within a section touches no DOM. */
	private readonly shown = new WeakMap<MarkdownView, string>();

	onload(): void {
		// Scroll doesn't bubble: caught on its way down to a note's scroller, in either mode. A
		// browser fires it once a frame at most, so the trail is redrawn as it comes.
		const listen = (doc: Document): void =>
			this.registerDomEvent(doc, "scroll", (event) => this.onScroll(event), { capture: true, passive: true });
		listen(document);
		this.registerEvent(this.app.workspace.on("window-open", (win) => listen(win.doc)));
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.refresh((view) => view.file === file)));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
		this.app.workspace.onLayoutReady(() => this.refresh());
	}

	onunload(): void {
		for (const view of this.views()) view.containerEl.querySelector(`.${TRAIL_CLS}`)?.remove();
	}

	private onScroll(event: Event): void {
		const target = event.target as Node | null;
		if (!target?.instanceOf(HTMLElement) || !target.closest(".workspace-leaf-content[data-type='markdown']")) return;
		this.refresh((view) => view.contentEl.contains(target));
	}

	/** Redraw the trail of each open note `which` picks, all of them by default. */
	private refresh(which: (view: MarkdownView) => boolean = () => true): void {
		for (const view of this.views()) if (which(view)) this.render(view);
	}

	/** The notes open in any window; a tab not shown since startup isn't loaded yet, and has no header to fill. */
	private views(): MarkdownView[] {
		return this.app.workspace
			.getLeavesOfType("markdown")
			.map((leaf) => leaf.view)
			.filter((view): view is MarkdownView => view instanceof MarkdownView);
	}

	private render(view: MarkdownView): void {
		const title = view.containerEl.querySelector<HTMLElement>(".view-header-title");
		const container = title?.parentElement;
		if (!title || !container) return;
		const headings = (view.file && this.app.metadataCache.getFileCache(view.file)?.headings) ?? [];
		const section = sectionAt(headings, view.currentMode.getScroll());
		const key = section.map((heading) => `${heading.position.start.line}\t${heading.heading}`).join("\n");
		let trail = container.querySelector<HTMLElement>(`:scope > .${TRAIL_CLS}`);
		if (trail && this.shown.get(view) === key) return;
		if (!trail) {
			trail = container.createDiv(TRAIL_CLS);
			// After the title, whatever else the header holds.
			title.insertAdjacentElement("afterend", trail);
		}
		trail.empty();
		this.shown.set(view, key);
		for (const heading of section) {
			trail.createSpan({ cls: "sticky-heading-separator", text: "›" });
			const text = plain(heading.heading);
			const crumb = trail.createSpan({ cls: "sticky-heading-crumb", text });
			setTooltip(crumb, text, { placement: "bottom" });
			const line = heading.position.start.line;
			crumb.addEventListener("click", () => {
				// The heading's line at the top, as the outline puts it; the cursor stays where it is.
				view.currentMode.applyScroll(line);
				this.render(view);
			});
		}
	}
}

/** The headings over `line`: the last one at or above it, and each one it's under. */
function sectionAt(headings: HeadingCache[], line: number): HeadingCache[] {
	const section: HeadingCache[] = [];
	for (const heading of headings) {
		// Within half a line of the top counts: scrolled to its heading, a section's top line
		// reads back a hair short of it (51.9997 for 52).
		if (heading.position.start.line > line + 0.5) break;
		while (section.length > 0 && (section[section.length - 1] as HeadingCache).level >= heading.level) section.pop();
		section.push(heading);
	}
	return section;
}

/** A heading as it reads: links by what they show, without emphasis marks; code spans as written. */
function plain(text: string): string {
	return text
		.split(/(`[^`]*`)/)
		.map((part, i) =>
			i % 2 === 1
				? part.slice(1, -1)
				: part
						.replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) =>
							alias ? alias : target.replace(/#/g, " > "),
						)
						.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
						.replace(/\[\^[^\]]*\]/g, "")
						.replace(/<\/?[a-z][^>]*>/gi, "")
						// Emphasis only between word boundaries: an underscore inside a word (snake_case) is text.
						.replace(/(^|\W)([*_]{1,3})(?=\S)(.*?\S)\2(?!\w)/g, "$1$3")
						.replace(/(~~|==)(.+?)\1/g, "$2"),
		)
		.join("")
		.trim();
}
