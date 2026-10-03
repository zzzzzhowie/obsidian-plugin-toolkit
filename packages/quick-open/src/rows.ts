import { type App, MarkdownView, Platform, renderMatches, setIcon } from "obsidian";

import { displayName, folderOf, iconFor } from "./files";
import { type FileItem, type HeadingItem, type Item, LABEL_FILES, type LineItem } from "./search";

/** What a row's own buttons do, beside opening the row itself. */
export interface RowActions {
	openToSide(item: FileItem): void;
	/** Take a recent file off the list. */
	remove(item: FileItem): void;
}

export interface RowOptions {
	/** Print the section label on the row's right (the modal); the new tab heads its sections instead. */
	labels: boolean;
}

/** One result row — icon, name and folder with the matched characters marked, then its buttons. */
export function renderItem(app: App, item: Item, el: HTMLElement, actions: RowActions, options: RowOptions): void {
	el.addClass("quick-open-item");
	if (item.kind === "file") renderFile(item, el, actions, options);
	else if (item.kind === "heading") renderHeading(item, el);
	else renderLine(app, item, el);
}

function renderFile(item: FileItem, el: HTMLElement, actions: RowActions, options: RowOptions): void {
	const { file } = item;
	// A section starts here: rule it off from the one above, as VS Code does.
	if (options.labels && item.label === LABEL_FILES) el.addClass("is-section-start");
	setIcon(el.createDiv({ cls: "quick-open-icon" }), iconFor(file));

	const text = el.createDiv({ cls: "quick-open-text" });
	const folder = folderOf(file);
	if (item.alias !== undefined) {
		// As Obsidian's switcher shows one: the alias, then the note it stands for.
		renderMatches(text.createSpan({ cls: "quick-open-name" }), item.alias, item.nameMatches);
		if (item.line !== undefined) text.createSpan({ cls: "quick-open-name", text: `:${item.line}` });
		text.createSpan({ cls: "quick-open-path", text: folder ? `${folder}/${displayName(file)}` : displayName(file) });
	} else {
		renderMatches(text.createSpan({ cls: "quick-open-name" }), displayName(file), item.nameMatches);
		if (item.line !== undefined) text.createSpan({ cls: "quick-open-name", text: `:${item.line}` });
		if (folder) renderMatches(text.createSpan({ cls: "quick-open-path" }), folder, item.pathMatches);
	}

	const aux = el.createDiv({ cls: "quick-open-aux" });
	if (item.alias !== undefined) {
		setIcon(aux.createSpan({ cls: "quick-open-flair", attr: { "aria-label": "Alias" } }), "forward");
	}
	if (options.labels && item.label) aux.createSpan({ cls: "quick-open-label", text: item.label });
	// A phone has no side to open to: one note on screen at a time.
	if (!Platform.isPhone) action(aux, "columns-2", "Open to the side", () => actions.openToSide(item));
	if (item.recent) action(aux, "x", "Remove from recently opened", () => actions.remove(item));
}

function renderLine(app: App, item: LineItem, el: HTMLElement): void {
	setIcon(el.createDiv({ cls: "quick-open-icon" }), "arrow-right");
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	const text = el.createDiv({ cls: "quick-open-text" });
	if (!view) {
		text.setText("Open a note to go to a line in it.");
	} else if (item.line === null) {
		const cursor = view.editor.getCursor();
		text.setText(
			`Current line: ${cursor.line + 1}, character: ${cursor.ch + 1}. ` +
				`Type a line number between 1 and ${view.editor.lineCount()} to go to.`,
		);
	} else {
		text.setText(item.column ? `Go to line ${item.line}, character ${item.column}.` : `Go to line ${item.line}.`);
	}
}

function renderHeading(item: HeadingItem, el: HTMLElement): void {
	const { heading } = item;
	setIcon(el.createDiv({ cls: "quick-open-icon" }), `heading-${Math.min(Math.max(heading.level, 1), 6)}`);
	const text = el.createDiv({ cls: "quick-open-text" });
	text.style.setProperty("--quick-open-indent", String(heading.level - 1));
	text.addClass("is-indented");
	renderMatches(text.createSpan({ cls: "quick-open-name" }), heading.heading, item.matches);
	text.createSpan({ cls: "quick-open-path", text: `line ${heading.position.start.line + 1}` });
}

/** A small button on the right of a row that does its own thing instead of opening the row. */
function action(parent: HTMLElement, icon: string, label: string, run: () => void): void {
	const button = parent.createDiv({ cls: "clickable-icon quick-open-action", attr: { "aria-label": label } });
	setIcon(button, icon);
	// Keep focus in the search box.
	button.addEventListener("mousedown", (evt) => evt.preventDefault());
	button.addEventListener("click", (evt) => {
		// The row's own click handler skips an event already handled.
		evt.preventDefault();
		evt.stopPropagation();
		run();
	});
}
