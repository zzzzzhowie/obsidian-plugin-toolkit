# Caption (Enhanced)

Show elegant captions under images in both **Live Preview** and **Reading Mode** — for local images, wiki embeds (`![[img.png|caption]]`), and external image hosts (`![caption](https://...)`).

Enhanced fork of `wk image caption`, aligned to the toolkit build system.

## Caption source

The caption is derived from the image alt text / wiki alias, with the Obsidian resize suffix stripped:

| Alt text | Caption |
|---|---|
| `My caption` | `My caption` |
| `My caption\|500` | `My caption` |
| `My caption \| 500` | `My caption` |
| `A \| B \| 300` | `A \| B` |
| `image.png` | *(suppressed)* |

Only a **trailing** `|<size>` (e.g. `500`, `500x300`) is removed, so captions that legitimately contain `|` are preserved.

## Editing a caption, and links in it

Images and Excalidraw drawings (`![[Drawing.excalidraw|caption|600]]`, the caption in its alias) alike; Mermaid (Enhanced)'s diagram captions use the same button, dialog and rendering, from `shared/caption.ts`.

In Live Preview an image's action buttons (Zoom in, Edit this block) gain a **caption button** that edits its caption in a small dialog; empty removes it.

A caption is the image's alt or alias, as Obsidian's own is, and a link goes in it as markdown — `![[HSA Portal](https://account.example.com)|500x490](img)` shows the image with "HSA Portal" under it, linked there, in both Live Preview and Reading Mode. That's CommonMark (an image's alt may hold a link) and Reading Mode parses it; Live Preview doesn't — it takes the inner link for the image — so there this plugin draws such an image itself, with Obsidian's look, and its Edit button shows the markdown as written. A `[[note]]` in a caption is written `[note](<note>)`, since its `]]` would end a wiki embed. A bare url works too (`HSA Portal https://…` links the words), as do `**bold**`, `*italic*` and `` `code` ``.

## Settings

- **Show image file name as caption** — fall back to the file name when there's no alt/alias.
- **Caption text alignment** — left / center / right.
- **Caption text style** — italic / normal.
- **Caption extraction regex** — optional. Extract the caption from the alt text with a custom pattern; the first capture group (or whole match) becomes the caption. Overrides the default parsing when it matches. Example: `^(.*?)\s*\|` keeps only the text before the first `|`.

## Develop

```bash
pnpm dev:caption-enhanced      # watch + symlink into your vault
pnpm build:caption-enhanced    # type-check + production build
```
