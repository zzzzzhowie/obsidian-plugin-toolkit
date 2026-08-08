# Vault Backup

Periodic `git commit` + `git push` for an Obsidian vault. Deliberately small: no
pull, no merge, no conflict UI, no source-control view — just a timer, a status
bar item, and two commands.

## Why it exists

A vault that is also a git repository and is also synced (iCloud, Dropbox,
Obsidian Sync) has one specific hazard: every machine sees the same
`.obsidian/` folder, so "turn backup off on the laptop" is not something plugin
settings can express — `data.json` travels with the vault, and turning the
plugin off turns it off everywhere.

This plugin keeps the on/off switch in Obsidian's local storage, which is scoped
to one vault on one computer and never leaves it. One machine owns the backup;
the others load the plugin, show `Backup off`, and never touch git.

## What one backup pass does

1. `git status --porcelain` — nothing dirty, nothing to do.
2. `git add -A`, then commit if anything actually got staged.
3. `git rev-list --count @{u}..HEAD`, and push only if the remote is behind.

Every step is a no-op when there is nothing to do, so running it on a timer is
cheap. Failures are never silent: the status bar turns into `Backup failed`, a
notice shows the git output, and the settings tab keeps the last error.

Common failures get a plain-language hint in front of the raw git text —
iCloud-evicted files (`short read`), a missing upstream, a rejected push because
another machine owns the branch, SSH keys, a git binary that is not on
Obsidian's `PATH`.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Back up from this machine | off | Per machine. Not stored in `data.json`. |
| Backup interval | 30 min | `0` disables the timer, manual command still works. |
| Push after committing | on | Off keeps commits local. |
| Commit message | `vault backup: {{date}}` | Also supports `{{host}}`. |
| Startup delay | 60 s | Lets file sync settle before the first pass. |
| Git executable | `git` | Absolute path if Obsidian cannot find it. |
| Command timeout | 120 s | A hung git command is killed and reported. |

## Commands

- **Back up now (commit and push)** — runs a pass regardless of the timer or the
  per-machine switch, because asking for it is explicit.
- **Toggle backup on this machine** — flips the local switch.

## Build

```bash
pnpm build:vault-backup
```
