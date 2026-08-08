import { realpathSync } from "fs";
import { hostname } from "os";
import { FileSystemAdapter, Notice, Plugin, setIcon } from "obsidian";

import { describeGitFailure, runBackup, type BackupOutcome } from "./backup";
import { GitRunner } from "./git";
import { DEFAULT_SETTINGS, VaultBackupSettingTab, type VaultBackupSettings } from "./settings";

/**
 * Per-machine state lives in Obsidian's local storage, which is scoped to this
 * vault on this computer and is not part of the vault folder. That is the whole
 * trick behind machine-specific backup: data.json travels with iCloud, this does
 * not.
 */
const ENABLED_KEY = "vault-backup:enabled";
const LAST_OK_KEY = "vault-backup:last-ok";
const LAST_ERROR_KEY = "vault-backup:last-error";

/** How often the timer wakes up to decide whether a backup is due. */
const TICK_MS = 30_000;

type RunReason = "timer" | "startup" | "manual";

type Status = "disabled" | "idle" | "running" | "error";

export default class VaultBackupPlugin extends Plugin {
	settings: VaultBackupSettings = { ...DEFAULT_SETTINGS };
	readonly machineName: string = hostname();

	private statusEl: HTMLElement | null = null;
	private running = false;
	private lastAttemptAt = 0;
	/** null until the first check finishes. False keeps the plugin fully inert. */
	private repoRoot: boolean | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new VaultBackupSettingTab(this.app, this));

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("vault-backup-status-bar");
		this.statusEl.addEventListener("click", () => {
			void this.backupNow("manual");
		});

		this.addCommand({
			id: "backup-now",
			name: "Back up now (commit and push)",
			callback: () => {
				void this.backupNow("manual");
			},
		});

		this.addCommand({
			id: "toggle-machine",
			name: "Toggle backup on this machine",
			callback: () => {
				void this.setEnabledHere(!this.isEnabledHere()).then(() => {
					new Notice(
						this.isEnabledHere()
							? `Vault backup is now on for ${this.machineName}.`
							: `Vault backup is now off for ${this.machineName}.`,
					);
				});
			},
		});

		this.renderStatus();

		// One wake-up loop drives both the startup run and the interval, so a
		// settings change takes effect on the next tick without re-arming timers.
		this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));

		// Vaults that are not themselves a git repository — a second vault that only
		// receives synced plugin code, say — get no timer, no status bar item and no
		// git calls at all. Nothing to opt out of, because nothing ever starts.
		void this.refreshRepoState().then(() => {
			if (!this.repoRoot || !this.isEnabledHere()) return;

			const delay = Math.max(0, this.settings.startupDelaySeconds) * 1000;
			const timer = window.setTimeout(() => {
				void this.backupNow("startup");
			}, delay);
			this.register(() => {
				window.clearTimeout(timer);
			});
		});
	}

	/** True only when the vault folder is itself the root of a git work tree. */
	isRepoRoot(): boolean | null {
		return this.repoRoot;
	}

	/**
	 * A vault nested inside someone else's repository must not be committed by
	 * accident, so the work tree root has to be the vault root itself.
	 */
	async refreshRepoState(): Promise<boolean> {
		const vaultPath = this.vaultPath();
		if (!vaultPath) {
			this.repoRoot = false;
			this.renderStatus();
			return false;
		}

		const git = new GitRunner(this.settings.gitPath, vaultPath, 15_000);
		try {
			const top = await git.run(["rev-parse", "--show-toplevel"]);
			this.repoRoot = samePath(top.stdout.trim(), vaultPath);
		} catch {
			this.repoRoot = false;
		}
		this.renderStatus();
		return this.repoRoot;
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<VaultBackupSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.renderStatus();
	}

	isEnabledHere(): boolean {
		return this.app.loadLocalStorage(ENABLED_KEY) === true;
	}

	async setEnabledHere(enabled: boolean): Promise<void> {
		this.app.saveLocalStorage(ENABLED_KEY, enabled);
		// Mirror the choice into the shared settings purely so the other machines
		// can show who is meant to be backing up. It is never read as the gate.
		this.settings.machines[this.machineName] = { enabled, updatedAt: Date.now() };
		await this.saveSettings();

		if (enabled) {
			this.lastAttemptAt = 0;
		}
		this.renderStatus();
	}

	lastSuccessAt(): number | null {
		const value: unknown = this.app.loadLocalStorage(LAST_OK_KEY);
		return typeof value === "number" ? value : null;
	}

	lastError(): string | null {
		const value: unknown = this.app.loadLocalStorage(LAST_ERROR_KEY);
		return typeof value === "string" && value.length > 0 ? value : null;
	}

	/**
	 * Runs a backup pass. Manual runs are allowed on machines that are opted out,
	 * because asking for one is an explicit decision; only the timer respects the
	 * per-machine switch.
	 */
	async backupNow(reason: RunReason): Promise<void> {
		if (this.running) {
			if (reason === "manual") new Notice("Vault backup: a backup is already running.");
			return;
		}

		const vaultPath = this.vaultPath();
		if (!vaultPath) {
			if (reason === "manual") new Notice("Vault backup: this vault is not on the local filesystem.");
			return;
		}

		// Re-checked here rather than trusted from load, so initialising a repo does
		// not require an Obsidian restart.
		if (!(await this.refreshRepoState())) {
			if (reason === "manual") {
				new Notice(
					`Vault backup: ${this.app.vault.getName()} is not a git repository, so there is nothing to back up. The plugin stays inactive here.`,
					10_000,
				);
			}
			return;
		}

		this.running = true;
		this.lastAttemptAt = Date.now();
		this.renderStatus();

		const git = new GitRunner(
			this.settings.gitPath,
			vaultPath,
			Math.max(10, this.settings.commandTimeoutSeconds) * 1000,
		);

		try {
			const outcome = await runBackup(git, {
				commitMessage: this.settings.commitMessage,
				push: this.settings.push,
				machineName: this.machineName,
			});
			this.app.saveLocalStorage(LAST_OK_KEY, Date.now());
			this.app.saveLocalStorage(LAST_ERROR_KEY, null);
			if (outcome.warning) new Notice(`Vault backup: ${outcome.warning}`, 10_000);
			if (reason === "manual") new Notice(`Vault backup: ${summarise(outcome)}`);
		} catch (error) {
			const detail = describeGitFailure(error);
			this.app.saveLocalStorage(LAST_ERROR_KEY, detail);
			console.error("Vault backup failed", error);
			new Notice(`Vault backup failed\n\n${detail}`, 15_000);
		} finally {
			this.running = false;
			this.renderStatus();
		}
	}

	private tick(): void {
		// Keeps the "backed up 12m ago" label honest between runs.
		this.renderStatus();

		if (this.repoRoot !== true) return;
		if (this.running || !this.isEnabledHere()) return;

		const minutes = this.settings.intervalMinutes;
		if (minutes <= 0) return;
		if (Date.now() - this.lastAttemptAt < minutes * 60_000) return;

		void this.backupNow("timer");
	}

	private vaultPath(): string | null {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
	}

	private renderStatus(): void {
		const el = this.statusEl;
		if (!el) return;

		// No repository, no status bar item: a vault that only carries the synced
		// plugin code should look like the plugin is not there.
		if (this.repoRoot === false) {
			el.empty();
			el.hide();
			return;
		}
		el.show();

		const status = this.currentStatus();
		el.empty();
		el.removeClass("vault-backup-error");

		const icon = el.createSpan({ cls: "vault-backup-icon" });
		setIcon(icon, ICONS[status]);
		el.createSpan({ text: this.statusText(status) });

		if (status === "error") el.addClass("vault-backup-error");
		el.setAttribute("aria-label", this.tooltip(status));
	}

	private currentStatus(): Status {
		if (this.running) return "running";
		if (!this.isEnabledHere()) return "disabled";
		return this.lastError() ? "error" : "idle";
	}

	private statusText(status: Status): string {
		switch (status) {
			case "running":
				return "Backing up…";
			case "disabled":
				return "Backup off";
			case "error":
				return "Backup failed";
			case "idle":
				return relativeTime(this.lastSuccessAt());
		}
	}

	private tooltip(status: Status): string {
		const lines = [`Vault backup — ${this.machineName}`];
		if (status === "disabled") {
			lines.push("This machine is opted out; the timer will not commit or push.");
		} else if (this.settings.intervalMinutes > 0) {
			lines.push(`Every ${this.settings.intervalMinutes} min, push ${this.settings.push ? "on" : "off"}.`);
		} else {
			lines.push("Timer is off; manual backups only.");
		}
		const error = this.lastError();
		if (error) lines.push(error);
		lines.push("Click to back up now.");
		return lines.join("\n");
	}
}

const ICONS: Record<Status, string> = {
	disabled: "circle-slash",
	idle: "check-circle",
	running: "refresh-cw",
	error: "alert-triangle",
};

function samePath(a: string, b: string): boolean {
	if (a.length === 0 || b.length === 0) return false;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return a === b;
	}
}

function summarise(outcome: BackupOutcome): string {
	const parts: string[] = [];
	parts.push(outcome.committed ? `committed ${outcome.changed} path(s)` : "nothing to commit");
	if (outcome.pushed > 0) parts.push(`pushed ${outcome.pushed} commit(s)`);
	return parts.join(", ");
}

function relativeTime(timestamp: number | null): string {
	if (timestamp === null) return "Not backed up yet";

	const minutes = Math.floor((Date.now() - timestamp) / 60_000);
	if (minutes < 1) return "Backed up just now";
	if (minutes < 60) return `Backed up ${minutes}m ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `Backed up ${hours}h ago`;
	return `Backed up ${Math.floor(hours / 24)}d ago`;
}
