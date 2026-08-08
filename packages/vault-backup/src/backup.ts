import { GitError, GitRunner } from "./git";

export interface BackupOptions {
	commitMessage: string;
	push: boolean;
	machineName: string;
}

export interface BackupOutcome {
	/** Number of paths that were dirty when the run started. */
	changed: number;
	committed: boolean;
	pushed: number;
	/** Non-fatal thing the user should still know about, if any. */
	warning: string | null;
}

/**
 * One backup pass: stage everything, commit if there is anything to commit, then
 * push whatever the remote is missing. Every step is a no-op when there is
 * nothing to do, so this is safe to call on a timer.
 */
export async function runBackup(git: GitRunner, options: BackupOptions): Promise<BackupOutcome> {
	await git.run(["rev-parse", "--is-inside-work-tree"]);

	const status = await git.run(["status", "--porcelain"]);
	const changed = status.stdout.split("\n").filter((line) => line.trim().length > 0).length;

	let committed = false;
	if (changed > 0) {
		await git.run(["add", "-A"]);
		// `add -A` can end up staging nothing (e.g. only ignored files were dirty),
		// and `commit` fails on an empty index, so ask git directly.
		const hasStaged = !(await git.probe(["diff", "--cached", "--quiet"]));
		if (hasStaged) {
			await git.run(["commit", "-m", renderMessage(options.commitMessage, options.machineName)]);
			committed = true;
		}
	}

	let pushed = 0;
	let warning: string | null = null;
	if (options.push) {
		const upstream = await git.probe(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
		if (!upstream) {
			warning = "Current branch has no upstream, so nothing was pushed. Run `git push -u origin <branch>` once.";
		} else {
			const ahead = await git.run(["rev-list", "--count", "@{u}..HEAD"]);
			pushed = Number.parseInt(ahead.stdout.trim(), 10) || 0;
			if (pushed > 0) await git.run(["push"]);
		}
	}

	return { changed, committed, pushed, warning };
}

export function renderMessage(template: string, machineName: string): string {
	return template
		.split("{{date}}")
		.join(formatTimestamp(new Date()))
		.split("{{host}}")
		.join(machineName);
}

export function formatTimestamp(date: Date): string {
	const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
	);
}

/**
 * Turns a raw git failure into something actionable. The generic message is kept
 * as the second line so nothing is hidden.
 */
export function describeGitFailure(error: unknown): string {
	if (!(error instanceof GitError)) {
		return error instanceof Error ? error.message : String(error);
	}

	const raw = error.stderr.trim() || error.message;
	const hint = hintFor(raw);
	return hint ? `${hint}\n\n${raw}` : raw;
}

function hintFor(raw: string): string | null {
	const text = raw.toLowerCase();

	if (text.includes("enoent")) {
		return "The git executable could not be started. Set an absolute path in the plugin settings (`which git` in a terminal shows it).";
	}
	if (text.includes("short read")) {
		return "iCloud evicted a file's contents, so git could not read it. Open the vault folder in Finder, right-click it and choose 'Keep Downloaded', then retry.";
	}
	if (text.includes("not a git repository")) {
		return "This vault is not a git repository on this machine. Check that the directory the .git pointer file references actually exists here.";
	}
	if (text.includes("non-fast-forward") || text.includes("rejected")) {
		return "The remote has commits this machine does not. Another computer is pushing to the same branch — give each machine its own branch, or pull once by hand.";
	}
	if (text.includes("permission denied (publickey)") || text.includes("could not read from remote repository")) {
		return "SSH could not authenticate. Check that the key is loaded (`ssh -T git@github.com` from a terminal).";
	}
	if (text.includes("could not read username") || text.includes("authentication failed")) {
		return "The remote asked for credentials, which cannot be entered from here. Switch the remote to SSH or store a credential helper.";
	}
	if (text.includes("index.lock")) {
		return "Another git process is holding the index lock. If nothing else is running, delete the stale index.lock file.";
	}
	return null;
}
