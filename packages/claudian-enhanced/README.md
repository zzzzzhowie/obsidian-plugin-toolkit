# Claudian Enhanced

Quality-of-life wrapper around the [Claudian](https://github.com/YishenTu/claudian) plugin (`realclaudian`). Adds a single command, **Toggle Claudian chat (focus input, keep selection)**, meant to be bound to a hotkey (e.g. `⌘L`).

## Behavior

| Situation | What happens |
|---|---|
| Claudian hidden / never opened | Reveals it and puts the caret in the chat input |
| Claudian showing | Switches its sidebar back to the **outline** tab — the dock stays open and Claudian's tab is kept alive (never detached) |
| Text selected in the editor | Focus lands in the composer while the selection stays visibly highlighted; Claudian carries it over as context |

So the hotkey flips the sidebar between Claudian and outline without ever closing the dock or destroying the chat tab.

## How it works

- **Toggle** — looks up the `claudian-view` leaf. If it's the visible tab, reveal the sidebar's `outline` leaf; otherwise reveal Claudian (or run `realclaudian:open-view` on the very first open).
- **Never closes the dock** — uses `revealLeaf` to switch tabs and calls `WorkspaceSidedock.expand()` as a guard; it never detaches the leaf or collapses the sidebar.
- **Focus** — polls for the *visible* `textarea.claudian-input` (Claudian keeps hidden composers for background tabs) and re-asserts focus until it sticks, beating Claudian's own post-render `rootEl.focus()`.
- **Generation guard** — every press bumps a counter so a stale focus loop from a previous press bails, preventing rapid `⌘L` from stacking loops (which caused selection jitter).
- **Selection carry-over** — handled natively by Claudian's continuous selection poll; this plugin only injects a small CSS rule so the editor selection stays highlighted while the editor is unfocused.

## Notes

- Depends on the Claudian plugin being installed and enabled. The view type (`claudian-view`), input selector (`textarea.claudian-input`), and open command (`realclaudian:open-view`) are Claudian internals — if a Claudian update changes them, update the constants at the top of `src/main.ts`.
- Desktop only.

## Build

```bash
pnpm --filter @obsidian-plugin-toolkit/claudian-enhanced build
```

The build syncs the `obsidian-plugin-claudian-enhanced/` output to the vault set by `OBSIDIAN_PLUGINS_DIR` in the repo `.env`. Point that at a vault where the Claudian plugin is installed.
