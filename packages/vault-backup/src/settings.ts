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
	machines: {},
};

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

		new Setting(containerEl)
			.setName("Back up now")
			.setDesc("Runs the same pass the timer runs, regardless of the interval.")
			.addButton((button) =>
				button
					.setButtonText("Back up now")
					.setCta()
					.onClick(() => {
						void this.plugin.backupNow("manual").then(() => {
							this.render();
						});
					}),
			);
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
