// ============================================================
// An image's markdown, read and rewritten for its caption
// ============================================================

/**
 * The size in an alt or alias: a trailing `|500` or `| 500x300`, or the whole of it — `![578](img)`
 * is how Obsidian writes a width it was dragged to on an image with no caption.
 */
const SIZE_RE = /(?:^|\s*\|)\s*(\d+(?:x\d+)?)\s*$/;
/** A url as pasted into a caption. */
const URL_RE = /^https?:\/\/\S+$/;

/**
 * `![alt](url "title")`, from the image's first character. The alt may hold brackets one
 * level deep, as CommonMark allows — a link: `![see [V](https://…)](img)`.
 */
const MARKDOWN_IMAGE_RE =
	/^!\[((?:[^[\]\\]|\\.|\[(?:[^[\]\\]|\\.)*\])*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?\s*\)/;
/** `![[target|alias]]`, from the embed's first character. An alias may hold `[text](url)`. */
const WIKI_IMAGE_RE = /^!\[\[(.*?)\]\]/;

export interface ImageSource {
	kind: 'markdown' | 'wiki';
	/** Where the image's markdown starts and ends in the document. */
	from: number;
	to: number;
	/** The alt (markdown) or alias (wiki), its size suffix included. */
	alt: string;
	/** A markdown image's title, unquoted; null for none (and for a wiki embed). */
	title: string | null;
	/** The url (markdown, as written) or link target (wiki). */
	target: string;
}

/** The image whose markdown starts at `from` in `text`, or null if none does. */
export function readImage(text: string, from: number): ImageSource | null {
	const rest = text.slice(from);
	// Markdown first: `![[V](https://…)](img)` starts like a wiki embed and isn't one.
	const md = MARKDOWN_IMAGE_RE.exec(rest);
	if (md) {
		const quoted = md[3];
		return {
			kind: 'markdown',
			from,
			to: from + md[0].length,
			alt: md[1] ?? '',
			target: md[2] ?? '',
			title: quoted ? quoted.slice(1, -1).replace(/\\(["'\\])/g, '$1') : null,
		};
	}
	const wiki = WIKI_IMAGE_RE.exec(rest);
	if (!wiki) return null;
	const inner = wiki[1] ?? '';
	const bar = inner.indexOf('|');
	return {
		kind: 'wiki',
		from,
		to: from + wiki[0].length,
		target: bar < 0 ? inner : inner.slice(0, bar),
		alt: bar < 0 ? '' : inner.slice(bar + 1),
		title: null,
	};
}

/** Every image in a stretch of markdown, in order. */
export function readImages(text: string): ImageSource[] {
	const images: ImageSource[] = [];
	let at = text.indexOf('![');
	while (at >= 0) {
		const image = readImage(text, at);
		if (image) images.push(image);
		at = text.indexOf('![', image ? image.to : at + 2);
	}
	return images;
}

/** A url or link target as compared across markdown and the page: unbracketed, decoded. */
export function sameTarget(a: string, b: string): boolean {
	const norm = (t: string): string => {
		const bare = t.trim().replace(/^<(.*)>$/, '$1');
		try {
			return decodeURI(bare);
		} catch {
			return bare;
		}
	};
	return norm(a) === norm(b);
}

/** The size suffix of an alt or alias (`500`, `500x300`), or null. */
export function sizeOf(alt: string): string | null {
	return SIZE_RE.exec(alt)?.[1] ?? null;
}


/** The alt or alias without its size suffix. */
function altCaption(alt: string): string {
	return alt.replace(SIZE_RE, '').trim();
}


/**
 * The caption as written, as the dialog shows it: the alt or alias, without the size. A
 * markdown image with a title — how links were written before they went in the alt — reads
 * as the same caption would now: its alt then the title's url, or the title alone.
 */
export function captionOf(image: ImageSource): string {
	const text = altCaption(image.alt);
	const title = image.kind === 'markdown' ? image.title?.trim() : '';
	if (!title) return text;
	if (!text) return title;
	return URL_RE.test(title) ? `${text} ${title}` : `[${text}](<${title}>)`;
}

/** Whether an alt holds brackets — a link in it — which Live Preview can't parse (see nested.ts). */
export function hasNestedBrackets(alt: string): boolean {
	return /[[\]]/.test(alt);
}

/**
 * The image's markdown with `caption` as its caption, its size kept.
 *
 * The caption is the alt or alias, written as typed, links included, as CommonMark has it:
 * `![see [V](https://…)|500](img)`. Reading view parses that; Live Preview doesn't, and is
 * drawn right by this plugin (see nested.ts). A `[[link]]` goes in as `[text](<target>)`,
 * the same link — its `]]` would end a wiki embed, and is no link inside an alt.
 */
export function withCaption(image: ImageSource, caption: string): string {
	const text = caption
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) => `[${label ?? target}](<${target}>)`);
	const size = sizeOf(image.alt);
	if (image.kind === 'wiki') {
		const parts = [image.target, text, size].filter((part): part is string => !!part);
		return `![[${parts.join('|')}]]`;
	}
	return `![${[text, size].filter(Boolean).join('|')}](${image.target})`;
}
