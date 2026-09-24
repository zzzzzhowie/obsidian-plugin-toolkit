import { GitError, GitRunner } from "./git";

export interface BackupOptions {
	commitMessage: string;
	push: boolean;
	machineName: string;
	/** Paths to keep out of the backup. gitignore-style; see runBackup. */
	ignorePatterns: readonly string[];
}

export interface BackupOutcome {
	/** Number of paths that were dirty when the run started, ignored ones excluded. */
	changed: number;
	committed: boolean;
	pushed: number;
	/** Paths the ignore list removed from the repository on this run. */
	untracked: number;
	/** Non-fatal thing the user should still know about, if any. */
	warning: string | null;
}

/**
 * One backup pass: drop whatever the ignore list covers, stage everything else, commit if
 * there is anything to commit, then push whatever the remote is missing. Every step is a
 * no-op when there is nothing to do, so this is safe to call on a timer.
 *
 * The ignore list is applied as git pathspecs rather than written into a `.gitignore`.
 * Three reasons: the vault's `.gitignore` is the user's file and is itself committed, this
 * vault's `.git` is a pointer file so there is no local `info/exclude` to reach for without
 * resolving it, and — the decisive one — neither of those can do anything about a path that
 * is *already* in the repository. `rm --cached` is what actually stops an existing file from
 * being backed up, and `--ignore-unmatch` makes it a no-op once that has happened, so the
 * whole pass stays idempotent on a timer.
 */
export async function runBackup(git: GitRunner, options: BackupOptions): Promise<BackupOutcome> {
	await git.run(["rev-parse", "--is-inside-work-tree"]);

	const patterns = options.ignorePatterns.filter((pattern) => pattern.trim().length > 0);
	// `-- .` first, so the exclusions narrow the whole work tree rather than nothing.
	const scope = patterns.length > 0 ? ["--", ".", ...patterns.map((p) => `:(exclude)${p}`)] : [];

	let untracked = 0;
	if (patterns.length > 0) {
		// Files stay on disk — only the index entry goes.
		await git.run(["rm", "-r", "--cached", "--ignore-unmatch", "-q", "--", ...patterns]);
		const removed = await git.run(["diff", "--cached", "--name-only", "--diff-filter=D"]);
		untracked = countLines(removed.stdout);
	}

	const status = await git.run(["status", "--porcelain", ...scope]);
	const changed = countLines(status.stdout);

	let committed = false;
	// `untracked` matters on its own: the first run after a pattern is added has a repository
	// to correct even when not a single file changed.
	if (changed > 0 || untracked > 0) {
		await git.run(["add", "-A", ...scope]);
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

	return { changed, committed, pushed, untracked, warning };
}

function countLines(output: string): number {
	return output.split("\n").filter((line) => line.trim().length > 0).length;
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
	// Checked before the credential cases below, because git appends "Could not read from
	// remote repository" to *every* transport failure. Matching on that line alone reported
	// a dropped connection as a key problem and sent the reader off to audit their SSH setup
	// while the real answer was to try again.
	if (
		text.includes("connection reset") ||
		text.includes("connection closed") ||
		text.includes("connection refused") ||
		text.includes("timed out") ||
		text.includes("network is unreachable") ||
		text.includes("broken pipe") ||
		text.includes("kex_exchange_identification") ||
		text.includes("could not resolve host") ||
		text.includes("remote end hung up")
	) {
		return "The connection to the remote dropped. Nothing is wrong with this vault — the next run retries on its own, and the commit is already safe locally.";
	}
	if (text.includes("permission denied") || text.includes("publickey")) {
		return "The remote refused the SSH key. Check it with `ssh -T git@github.com` from a terminal — note that a key sitting in ~/.ssh is used directly and does not have to be in the agent.";
	}
	if (text.includes("could not read username") || text.includes("authentication failed")) {
		return "The remote asked for credentials, which cannot be entered from here. Switch the remote to SSH or store a credential helper.";
	}
	if (text.includes("could not read from remote repository")) {
		return "The remote could not be read, and git gave no more detail than that. Check the network first, then that the remote URL still points somewhere you have access to.";
	}
	if (text.includes("index.lock")) {
		return "Another git process is holding the index lock. If nothing else is running, delete the stale index.lock file.";
	}
	return null;
}
