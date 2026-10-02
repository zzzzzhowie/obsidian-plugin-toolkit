import { Platform, Plugin, TFile } from "obsidian";

import { FileHistory } from "./history";
import { QuickOpenModal } from "./modal";

export default class QuickOpenPlugin extends Plugin {
	private history!: FileHistory;

	async onload(): Promise<void> {
		this.history = new FileHistory(this);
		await this.history.load();

		this.addCommand({
			id: "go-to-file",
			name: "Go to file",
			icon: "search",
			// VS Code's Go to File. The command palette moves to Cmd/Ctrl+Shift+P, as in VS Code.
			// eslint-disable-next-line obsidianmd/commands/no-default-hotkeys -- a personal plugin, not published
			hotkeys: [{ modifiers: ["Mod"], key: "P" }],
			callback: () => this.openQuickOpen(),
		});

		if (Platform.isMobile) {
			// The search button in the middle of the mobile navbar opens the core quick switcher,
			// from a click listener on the button itself. Catch the click on its way down and
			// open this instead; Cmd/Ctrl+O and the core switcher are left as they are.
			this.registerDomEvent(
				document,
				"click",
				(evt) => {
					const target = evt.target instanceof Element ? evt.target : null;
					if (!target?.closest(".mobile-navbar-action-quick-switcher")) return;
					evt.preventDefault();
					evt.stopImmediatePropagation();
					this.openQuickOpen();
				},
				{ capture: true },
			);
		}

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) this.history.record(file);
			}),
		);
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.history.rename(oldPath, file.path)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.history.delete(file.path)));
		this.registerEvent(
			this.app.workspace.on("quit", (tasks) => {
				tasks.add(() => this.history.flush());
			}),
		);

		// Obsidian's own recent list is only there once the workspace has loaded.
		this.app.workspace.onLayoutReady(() => {
			if (this.history.isEmpty) void this.history.seed();
			const active = this.app.workspace.getActiveFile();
			if (active instanceof TFile) this.history.record(active);
		});
	}

	/** Another device's list arrived through sync: merge it, don't take it over. */
	async onExternalSettingsChange(): Promise<void> {
		this.history.mergeExternal(await this.loadData());
	}

	onunload(): void {
		void this.history.flush();
	}

	private openQuickOpen(): void {
		const modal = new QuickOpenModal(this.app, this.history);
		modal.open();
		// Read the file again too. Obsidian only reports a change to data.json when its file
		// watcher sees one, and on a phone a copy iCloud delivered in the background can go
		// unnoticed — the list then stayed as it was until the app restarted. Whatever is on
		// disk is folded in here; the list shows at once and catches up if something arrived.
		void this.loadData().then((data) => {
			if (this.history.mergeExternal(data)) modal.refresh();
		});
	}
}
