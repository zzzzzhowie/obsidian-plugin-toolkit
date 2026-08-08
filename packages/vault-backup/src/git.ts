import { execFile } from "child_process";

export interface GitResult {
	stdout: string;
	stderr: string;
}

export class GitError extends Error {
	constructor(
		message: string,
		readonly args: readonly string[],
		readonly stderr: string,
	) {
		super(message);
		this.name = "GitError";
	}
}

/** Thin promise wrapper around the git CLI, pinned to one working tree. */
export class GitRunner {
	constructor(
		private readonly gitPath: string,
		private readonly cwd: string,
		private readonly timeoutMs: number,
	) {}

	run(args: string[]): Promise<GitResult> {
		return new Promise((resolve, reject) => {
			execFile(
				this.gitPath,
				args,
				{
					cwd: this.cwd,
					timeout: this.timeoutMs,
					maxBuffer: 16 * 1024 * 1024,
					env: {
						...process.env,
						// Never block on an interactive prompt: Obsidian has no terminal
						// attached, so a prompt would hang the backup forever instead of
						// failing loudly.
						GIT_TERMINAL_PROMPT: "0",
						GIT_ASKPASS: "",
						SSH_ASKPASS: "",
					},
				},
				(error, stdout, stderr) => {
					if (error) {
						const detail = stderr.trim() || stdout.trim() || error.message;
						reject(new GitError(detail, args, stderr));
						return;
					}
					resolve({ stdout, stderr });
				},
			);
		});
	}

	/** Runs git and reports success/failure instead of throwing. */
	async probe(args: string[]): Promise<boolean> {
		try {
			await this.run(args);
			return true;
		} catch {
			return false;
		}
	}
}
