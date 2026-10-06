import { type App, PluginSettingTab, Setting } from "obsidian";

import { formatTimestamp } from "./backup";
import type VaultBackupPlugin from "./main";

/** What one machine last reported. Shared across machines, for visibility only. */
export interface MachineRecord {
	enabled: boolean;
	updatedAt: number;
}

export interface VaultBackupSettings {
	/** Minutes between automatic backups. 0 disables the timer. */
	intervalMinutes: number;
	/** Supports {{date}} and {{host}}. */
	commitMessage: string;
	/** Push after committing. Off means local commits only. */
	push: boolean;
	/** Seconds to wait after Obsidian starts before the first backup. */
	startupDelaySeconds: number;
	/** Absolute path, or a bare name to be resolved through PATH. */
	gitPath: string;
	/** Abort a git command that runs longer than this. */
	commandTimeoutSeconds: number;
	/**
	 * Paths kept out of the backup, gitignore-style, one pattern per entry. Applied as git
	 * pathspecs, so they are matched the same way `git add <pattern>` would match.
	 *
	 * Deliberately not the vault's own `.gitignore`: that file is the user's, it is itself
	 * committed, and it could not untrack anything that is already in the repo.
	 */
	ignorePatterns: string[];
	/** Machine name -> last known opt-in state. Never used as the gate. */
	machines: Record<string, MachineRecord>;
}

export const DEFAULT_SETTINGS: VaultBackupSettings = {
	intervalMinutes: 30,
	commitMessage: "vault backup: {{date}}",
	push: true,
	startupDelaySeconds: 60,
	gitPath: "git",
	commandTimeoutSeconds: 120,
	// Empty here on purpose — the real default depends on where this vault keeps its config
	// folder, so it is filled in at load time. See defaultIgnorePatterns.
	ignorePatterns: [],
	machines: {},
};

/**
 * What a vault with no ignore list of its own starts with: build output and chat session
 * metadata. All of it is rewritten constantly, all of it is reproducible, and none of it is
 * worth anything in a restore.
 *
 * Plugin `data.json` files are deliberately absent — those hold settings, which are exactly
 * what a restore wants back. `.DS_Store` is absent too: a global gitignore already covers it
 * on this machine, and a pattern per annoyance is how an ignore list stops being readable.
 *
 * `configDir` rather than a hardcoded `.obsidian`, because a vault can be told to keep its
 * configuration somewhere else, and then every pattern below would quietly match nothing.
 */
export function defaultIgnorePatterns(configDir: string): string[] {
	return [
		".claudian/sessions/",
		`${configDir}/plugins/*/main.js`,
		`${configDir}/plugins/*/styles.css`,
		`${configDir}/plugins/*/manifest.json`,
		// The one plugin `data.json` worth naming individually. It is a list of the files
		// you last opened, rewritten on every navigation — it was the single most committed
		// path in this vault, appearing in 36 of 50 consecutive backups. Four real
		// preferences (omittedPaths, omittedTags, updateOn, omitBookmarks) live in the same
		// file and go with it; git cannot keep half a file, and four settings that take
		// seconds to re-enter are worth trading for that much noise.
		`${configDir}/plugins/recent-files-obsidian/data.json`,
		// Quick Open's recently opened list, for the same reason: rewritten on every file
		// opened, and it holds nothing but that list.
		`${configDir}/plugins/yeyan-quick-open/data.json`,
		// Drafts' unsaved notes. Whatever is worth keeping gets saved into the vault proper,
		// and is backed up from there; the rest is scratch, rewritten on every keystroke.
		"_drafts/",
	];
}

/**
 * Split the textarea into patterns. Blank lines and `#` comments are dropped so the box can
 * be annotated the way a `.gitignore` can.
 */
export function parseIgnorePatterns(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

export class VaultBackupSettingTab extends PluginSettingTab {
	private readonly plugin: VaultBackupPlugin;

	constructor(app: App, plugin: VaultBackupPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.render();
		// Cheap enough to re-check every time the tab opens, and it keeps the notice
		// above honest if a repository was created since Obsidian started.
		void this.plugin.refreshRepoState().then(() => {
			this.render();
		});
	}

	private render(): void {
		const { containerEl } = this;
		containerEl.empty();

		if (this.plugin.isRepoRoot() === false) {
			containerEl.createDiv({
				cls: "vault-backup-status vault-backup-status-error",
				text:
					`This vault is not a git repository, so Vault backup is inactive here — no timer, no commits, no pushes. ` +
					`Nothing below has any effect until the vault folder itself is a git work tree.`,
			});
		}

		new Setting(containerEl)
			.setName(`Back up from this machine (${this.plugin.machineName})`)
			.setDesc(
				"Stored on this computer only, never in data.json, so it never travels between computers. Leave it off on every machine except the one that should own the backup.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.isEnabledHere()).onChange((value) => {
					void this.plugin.setEnabledHere(value).then(() => {
						this.render();
					});
				}),
			);

		new Setting(containerEl)
			.setName("Backup interval")
			.setDesc("Minutes between automatic backups. 0 turns the timer off and leaves only the manual command.")
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.intervalMinutes))
					.onChange((value) => {
						const minutes = Number(value);
						if (!Number.isFinite(minutes) || minutes < 0) return;
						this.plugin.settings.intervalMinutes = Math.floor(minutes);
						void this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Push after committing")
			.setDesc("Turn off to keep commits local. Nothing else changes.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.push).onChange((value) => {
					this.plugin.settings.push = value;
					void this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Commit message")
			.setDesc("{{date}} becomes the local timestamp, {{host}} the machine name.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.commitMessage)
					.setValue(this.plugin.settings.commitMessage)
					.onChange((value) => {
						this.plugin.settings.commitMessage = value.trim() || DEFAULT_SETTINGS.commitMessage;
						void this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Ignore list")
			.setDesc(
				"One gitignore-style pattern per line. Matching paths stay on disk but are " +
					"dropped from the backup — anything already committed is untracked on the " +
					"next run, so it also disappears from the remote.",
			)
			.addTextArea((text) =>
				text
					.setPlaceholder(`${this.app.vault.configDir}/plugins/*/main.js`)
					.setValue(this.plugin.settings.ignorePatterns.join("\n"))
					.onChange((value) => {
						this.plugin.settings.ignorePatterns = parseIgnorePatterns(value);
						void this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Startup delay")
			.setDesc("Seconds to wait after Obsidian launches before the first backup, so file sync can settle first.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.startupDelaySeconds)).onChange((value) => {
					const seconds = Number(value);
					if (!Number.isFinite(seconds) || seconds < 0) return;
					this.plugin.settings.startupDelaySeconds = Math.floor(seconds);
					void this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Git executable")
			.setDesc("Leave as `git` unless Obsidian cannot find it on PATH, then use an absolute path.")
			.addText((text) =>
				text.setValue(this.plugin.settings.gitPath).onChange((value) => {
					this.plugin.settings.gitPath = value.trim() || "git";
					void this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Command timeout")
			.setDesc("Seconds before a hung Git command is killed and reported as a failure.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.commandTimeoutSeconds)).onChange((value) => {
					const seconds = Number(value);
					if (!Number.isFinite(seconds) || seconds < 10) return;
					this.plugin.settings.commandTimeoutSeconds = Math.floor(seconds);
					void this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Status").setHeading();
		this.renderStatus(containerEl);
	}

	private renderStatus(containerEl: HTMLElement): void {
		const box = containerEl.createDiv({ cls: "vault-backup-status" });

		const lastOk = this.plugin.lastSuccessAt();
		box.createDiv({
			text: lastOk
				? `Last successful backup: ${formatTimestamp(new Date(lastOk))}`
				: "Last successful backup: never on this machine",
		});

		const lastError = this.plugin.lastError();
		if (lastError) {
			box.createDiv({ cls: "vault-backup-status-error", text: `Last error: ${lastError}` });
		}

		const names = Object.keys(this.plugin.settings.machines).sort();
		if (names.length > 0) {
			const known = names.map((name) => {
				const record = this.plugin.settings.machines[name];
				return `${name}: ${record?.enabled ? "on" : "off"}`;
			});
			box.createDiv({ text: `Machines seen by this vault — ${known.join(", ")}` });
		}
	}
}
