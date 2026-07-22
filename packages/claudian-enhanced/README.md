# Claudian Enhanced

Quality-of-life wrapper around the [Claudian](https://github.com/YishenTu/claudian) plugin (`realclaudian`). Adds a single command, **Toggle Claudian chat (focus input, keep selection)**, meant to be bound to a hotkey (e.g. `⌘L`).

## Behavior

| Situation | What happens |
|---|---|
| Claudian hidden / never opened | Reveals it and puts the caret in the chat input |
| Claudian showing | Switches its sidebar back to the **outline** tab — the dock stays open, Claudian's tab is kept alive (never detached), and the note stays the active pane so Claudian keeps carrying the selection |
| Text selected in the editor | Focus lands in the composer; Claudian carries the selection over as context and draws its own highlight |
| `Esc` with a selection | Cancels the 划词 — collapses the editor selection and returns focus to the editor, which makes Claudian release its carried context/highlight too |

So the hotkey flips the sidebar between Claudian and outline without ever closing the dock or destroying the chat tab.

## How it works

The guiding principle after a lot of iteration: **lean on Obsidian's native selection and Claudian's own highlight — draw nothing ourselves.** Earlier versions snapshotted the selection and painted a custom overlay; that double-stacked with Claudian's highlight and drifted from the native look, so it was all removed.

- **Toggle** — looks up the `claudian-view` leaf. If it's the visible tab, reveal the sidebar's `outline` leaf; otherwise reveal Claudian (or run `realclaudian:open-view` on the very first open).
- **Never closes the dock** — uses `revealLeaf` to switch tabs and calls `WorkspaceSidedock.expand()` as a guard; it never detaches the leaf or collapses the sidebar.
- **Focus** — polls for the *visible* `textarea.claudian-input` (Claudian keeps hidden composers for background tabs) and re-asserts focus until it sticks, beating Claudian's own post-render `rootEl.focus()`.
- **Generation guard** — every press bumps a counter so a stale focus loop from a previous press bails, preventing rapid `⌘L` from stacking loops.
- **Selection carry-over** — Claudian reads the selection only from the *active* `MarkdownView` via its own poll. When flipping to Outline we reveal the outline tab but immediately hand "active leaf" back to the note (`setActiveLeaf(note, { focus: false })`), so Claudian keeps seeing the note's selection and never drops the carried context. We do **not** touch the selection or draw any highlight — the visible highlight after `⌘L` is Claudian's own `.claudian-selection-highlight`.
- **Esc to cancel** — a window-level capture-phase `keydown` listener collapses the editor selection and refocuses the editor. Claudian's selection poll keeps its context alive only while focus is inside its sidebar, so moving focus out is what makes it release the context, chip, and highlight (on its next ~250 ms poll).

## Notes

- Depends on the Claudian plugin being installed and enabled. The view type (`claudian-view`), input selector (`textarea.claudian-input`), and open command (`realclaudian:open-view`) are Claudian internals — if a Claudian update changes them, update the constants at the top of `src/main.ts`.
- `styles.css` carries a single rule that blanks Claudian's `.claudian-selection-highlight` while the editor is focused, so it doesn't stack on top of the native selection during selecting. Native Obsidian selection is otherwise untouched.
- Desktop only.

## Build

```bash
pnpm --filter @obsidian-plugin-toolkit/claudian-enhanced build
```

The build syncs the `obsidian-plugin-claudian-enhanced/` output to the vault set by `OBSIDIAN_PLUGINS_DIR` in the repo `.env`. Point that at a vault where the Claudian plugin is installed.
