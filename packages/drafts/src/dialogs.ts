import {
	AbstractInputSuggest,
	type App,
	ButtonComponent,
	Modal,
	normalizePath,
	prepareFuzzySearch,
	type TFile,
	TFolder,
} from "obsidian";

import { DRAFTS_FOLDER, FORBIDDEN_NAME_CHARS } from "./drafts";

/**
 * VS Code's save dialog for an untitled file: a name — its first line, to start with — and a
 * folder to put it in. Saving moves the draft there, so the tab it's open in carries on as
 * that note, links into it and its attachments included. Resolves to the saved note, or null
 * when cancelled.
 */
export function saveDraftDialog(app: App, file: TFile, name: string, folder: TFolder): Promise<TFile | null> {
	return new Promise((resolve) => new SaveDraftModal(app, file, name, folder, resolve).open());
}

/** What to do with a draft whose tab is closing, as VS Code asks of an untitled file. */
export type CloseChoice = "save" | "discard" | "cancel";

export function askToSave(app: App, name: string): Promise<CloseChoice> {
	return new Promise((resolve) => new AskToSaveModal(app, name, resolve).open());
}

class SaveDraftModal extends Modal {
	private readonly nameEl: HTMLInputElement;
	private readonly folderEl: HTMLInputElement;
	private readonly errorEl: HTMLElement;
	private settled = false;
	private busy = false;

	constructor(
		app: App,
		private readonly file: TFile,
		name: string,
		folder: TFolder,
		private readonly resolve: (saved: TFile | null) => void,
	) {
		super(app);
		this.setTitle("Save draft");
		this.modalEl.addClass("drafts-save-modal");
		const form = this.contentEl.createDiv("drafts-save-form");
		this.nameEl = field(form, "Name", name, "Untitled");
		this.folderEl = field(form, "Folder", folder.isRoot() ? "" : folder.path, "Vault root");
		new FolderSuggest(app, this.folderEl);
		this.errorEl = this.contentEl.createDiv("drafts-save-error");
		const buttons = this.contentEl.createDiv("modal-button-container");
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
		new ButtonComponent(buttons)
			.setButtonText("Save")
			.setCta()
			.onClick(() => void this.save());
		for (const input of [this.nameEl, this.folderEl]) {
			input.addEventListener("input", () => this.errorEl.empty());
		}
		// Enter saves from either box. While the folder list is open its own Enter picks the
		// folder first, as its popover takes the keys ahead of the modal.
		this.scope.register([], "Enter", (evt) => {
			// An Enter confirming an input method's candidate; iOS reports those as keyCode 229.
			// eslint-disable-next-line @typescript-eslint/no-deprecated -- the only way to tell on iOS
			if (evt.isComposing || evt.keyCode === 229) return true;
			void this.save();
			return false;
		});
	}

	onOpen(): void {
		this.nameEl.focus();
		this.nameEl.select();
	}

	onClose(): void {
		this.finish(null);
	}

	private async save(): Promise<void> {
		if (this.busy) return;
		const name = this.nameEl.value.trim().replace(/\.md$/i, "").trim();
		if (!name) return this.fail("Give the note a name.");
		if (FORBIDDEN_NAME_CHARS.test(name)) return this.fail('A name can\'t contain \\ / : * ? " < > | # ^ [ ]');
		const folder = normalizeFolder(this.folderEl.value);
		if (folder === DRAFTS_FOLDER || folder.startsWith(`${DRAFTS_FOLDER}/`)) {
			return this.fail("Pick a folder outside the drafts.");
		}
		const existing = folder ? this.app.vault.getAbstractFileByPath(folder) : null;
		if (existing && !(existing instanceof TFolder)) return this.fail(`“${folder}” is a file, not a folder.`);
		const target = normalizePath(`${folder}/${name}.md`);
		if (this.app.vault.getAbstractFileByPath(target)) {
			return this.fail(`“${name}” already exists in ${folder || "the vault root"}.`);
		}
		this.busy = true;
		try {
			if (folder && !existing) await this.app.vault.createFolder(folder);
			await this.app.fileManager.renameFile(this.file, target);
		} catch (error) {
			this.busy = false;
			return this.fail(`Couldn't save: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.finish(this.file);
		this.close();
	}

	private fail(message: string): void {
		this.errorEl.setText(message);
	}

	private finish(saved: TFile | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(saved);
	}
}

class AskToSaveModal extends Modal {
	private choice: CloseChoice = "cancel";

	constructor(
		app: App,
		name: string,
		private readonly resolve: (choice: CloseChoice) => void,
	) {
		super(app);
		this.setTitle(`Save “${name}” before closing?`);
		this.contentEl.createEl("p", { text: "It's a draft: if you don't save it, it's discarded." });
		const buttons = this.contentEl.createDiv("modal-button-container");
		new ButtonComponent(buttons).setButtonText("Don't save").onClick(() => this.choose("discard"));
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.choose("cancel"));
		new ButtonComponent(buttons)
			.setButtonText("Save…")
			.setCta()
			.onClick(() => this.choose("save"));
		// Enter saves, ⌘D doesn't — a Mac save prompt's keys.
		this.scope.register([], "Enter", () => {
			this.choose("save");
			return false;
		});
		this.scope.register(["Mod"], "D", () => {
			this.choose("discard");
			return false;
		});
	}

	onClose(): void {
		this.resolve(this.choice);
	}

	private choose(choice: CloseChoice): void {
		this.choice = choice;
		this.close();
	}
}

/** Folders to save into, fuzzy-matched on their path; the drafts folder isn't one. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private readonly input: HTMLInputElement,
	) {
		super(app, input);
		this.onSelect((folder) => {
			this.setValue(folder.isRoot() ? "" : folder.path);
			this.input.dispatchEvent(new Event("input"));
			this.close();
		});
	}

	protected getSuggestions(query: string): TFolder[] {
		const folders = this.app.vault
			.getAllFolders(true)
			.filter((folder) => folder.path !== DRAFTS_FOLDER && !folder.path.startsWith(`${DRAFTS_FOLDER}/`));
		const trimmed = query.trim();
		if (!trimmed) return folders.sort((a, b) => a.path.localeCompare(b.path));
		const match = prepareFuzzySearch(trimmed);
		return folders
			.map((folder) => ({ folder, result: match(folder.isRoot() ? "/" : folder.path) }))
			.filter((entry) => entry.result !== null)
			.sort((a, b) => (b.result?.score ?? 0) - (a.result?.score ?? 0))
			.map((entry) => entry.folder);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.isRoot() ? "/" : folder.path);
	}
}

function field(parent: HTMLElement, label: string, value: string, placeholder: string): HTMLInputElement {
	const row = parent.createEl("label", { cls: "drafts-save-field" });
	row.createSpan({ cls: "drafts-save-label", text: label });
	return row.createEl("input", { type: "text", value, attr: { placeholder, spellcheck: "false" } });
}

/** A folder path as typed — "", "/", "a/b/" — as the vault writes it, "" for the root. */
function normalizeFolder(value: string): string {
	const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
	return trimmed ? normalizePath(trimmed) : "";
}
