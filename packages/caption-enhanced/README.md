# Caption (enhanced)

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
