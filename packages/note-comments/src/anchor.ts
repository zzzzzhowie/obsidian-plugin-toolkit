/**
 * Where a comment belongs, and how to find that place again after the note has changed.
 *
 * A comment is anchored the way the W3C Web Annotation model does it (and the way
 * Hypothesis anchors highlights on pages it does not control): the quoted text plus a little
 * of what surrounds it, and the offsets it was last seen at. The offsets are only ever a
 * hint. Notes are edited by hand, by Claudian and by another Mac through iCloud, so anything
 * trusted blindly would sooner or later highlight the wrong words.
 *
 * Offsets are UTF-16 code units over LF-normalised text — the same unit CodeMirror uses for
 * positions and JavaScript uses for string indices, so they convert both ways directly,
 * CJK and emoji included. Text read from disk must go through `normaliseNewlines` first.
 *
 * Nothing here knows about Obsidian or CodeMirror; it is plain string work so it can be
 * tested on its own.
 */

export interface Selectors {
	/** The commented text itself. */
	exact: string;
	/** Up to CONTEXT_CHARS of text immediately before it. */
	prefix: string;
	/** Up to CONTEXT_CHARS of text immediately after it. */
	suffix: string;
	/** Where it was last seen. A hint, verified before use. */
	start: number;
	end: number;
}

export interface Span {
	from: number;
	to: number;
}

export const CONTEXT_CHARS = 32;

/**
 * Agreeing context a match needs before it is trusted. Scored in weighted characters (see
 * `weight`) of prefix and suffix that still line up, so a single stray letter doesn't count
 * as corroboration.
 */
const MIN_EVIDENCE = 8;

/**
 * A quote this heavy (see `weight`) that occurs exactly once is distinctive enough to stand
 * on its own, even when everything around it has been rewritten. Lighter ones are not: a
 * two-letter quote that happens to appear once is as likely to be a different occurrence as
 * the original.
 */
const MIN_UNIQUE_LENGTH = 8;

/**
 * How far past the recorded context to look, in raw characters. Context is compared with
 * formatting stripped (see `isNoise`), and the markup a formatter adds — a blank line, a
 * `**`, a list marker — would otherwise push the words being compared out of the window.
 */
const CONTEXT_SLACK = 16;

/**
 * Characters a formatter adds, removes or moves without changing what the text says:
 * whitespace, Markdown's emphasis / code / heading / quote / link / table / list markup, the
 * corner brackets used to set off a term, and punctuation — a tidy-up pass puts commas into
 * a run-on sentence as readily as it adds blank lines. Ignored when comparing text.
 */
function isNoise(ch: string): boolean {
	return /[\s*_~=`#>[\]()|\-+「」『』，。、；：！？,.;:!?“”‘’"'…·]/.test(ch);
}

/**
 * What a character counts for when judging whether text is distinctive. A CJK character is
 * a syllable or a word — "沟通基本功" is five of them and says as much as an English phrase
 * twice as long — so it counts double. Counting them like Latin letters made a short
 * Chinese heading too "short" to trust even when it was the only one of its kind.
 */
function weight(ch: string): number {
	return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(ch) ? 2 : 1;
}

function weightOf(text: string): number {
	let total = 0;
	for (const ch of text) total += weight(ch);
	return total;
}

/** `text` without its formatting noise, and where each kept character came from. */
interface Stripped {
	text: string;
	/** `at[i]` is the offset in the original text of `text[i]`. */
	at: number[];
}

function strip(text: string, offset = 0): Stripped {
	let out = "";
	const at: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (isNoise(ch)) continue;
		out += ch;
		at.push(offset + i);
	}
	return { text: out, at };
}

/** Bound on occurrences scored, so a pathological note cannot stall opening it. */
const MAX_CANDIDATES = 500;

export function normaliseNewlines(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Record the selectors for `doc[from, to)`. */
export function captureSelectors(doc: string, from: number, to: number): Selectors {
	return {
		exact: doc.slice(from, to),
		prefix: doc.slice(Math.max(0, from - CONTEXT_CHARS), from),
		suffix: doc.slice(to, to + CONTEXT_CHARS),
		start: from,
		end: to,
	};
}

/**
 * Narrow a selection to what the user meant to comment on. A triple-click takes the trailing
 * newline with it and a drag often catches a space at either end; neither is part of the
 * phrase, and a quote that starts or ends in whitespace re-anchors worse. Returns null when
 * nothing but whitespace was selected.
 */
export function trimSpan(doc: string, from: number, to: number): Span | null {
	while (from < to && /\s/.test(doc.charAt(from))) from++;
	while (to > from && /\s/.test(doc.charAt(to - 1))) to--;
	return from < to ? { from, to } : null;
}

/**
 * Find where a comment belongs in `doc`, or null when it can't be found with confidence.
 *
 * Four steps, stopping at the first that answers:
 *
 * 1. The recorded position. Accepted only when the quote is still there *and* its context
 *    still agrees — text inserted further up can slide a different copy of a short word into
 *    exactly the old offsets, and a bare text match would then highlight the wrong one.
 * 2. Every occurrence of the quote, scored by how much of the recorded prefix and suffix
 *    still line up around it, ties going to the one nearest where it used to be. This is what
 *    finds a paragraph that was moved, or a note that grew above the comment.
 * 3. The same, with formatting ignored inside the quote too (see `isNoise`): a formatter that
 *    put a space between "AB" and "实验", bolded a word or wrapped a term in 「」 changed how
 *    the quote is written, not what it says.
 * 4. Otherwise nothing. The comment is kept, just not drawn — landing on the wrong words is
 *    worse than not landing, because it looks right.
 *
 * Context is always compared with formatting ignored, so a heading that went from `##` to
 * `#`, or a blank line added under it, doesn't count against the words around the quote.
 * Anything beyond that — a quote whose words were actually changed — is not guessed at.
 */
export function anchor(doc: string, selectors: Selectors): Span | null {
	const { exact } = selectors;
	if (exact.length === 0) return null;

	// A quote sitting at the very edges of the note has less context to offer, and cannot be
	// held to more than it has.
	const prefix = strip(selectors.prefix).text;
	const suffix = strip(selectors.suffix).text;
	const required = Math.min(MIN_EVIDENCE, weightOf(prefix) + weightOf(suffix));
	const context = { prefix, suffix, required };

	const { start, end } = selectors;
	if (
		start >= 0 &&
		end <= doc.length &&
		end - start === exact.length &&
		doc.slice(start, end) === exact &&
		contextScore(doc, { from: start, to: end }, context) >= required
	) {
		return { from: start, to: end };
	}

	const exactMatches: Span[] = [];
	// `i + 1`, not `i + exact.length`: occurrences can overlap ("aa" in "aaa" occurs twice).
	for (let i = doc.indexOf(exact); i !== -1; i = doc.indexOf(exact, i + 1)) {
		exactMatches.push({ from: i, to: i + exact.length });
		if (exactMatches.length >= MAX_CANDIDATES) break;
	}
	if (exactMatches.length > 0) return pick(doc, exactMatches, weightOf(strip(exact).text), start, context);

	const quote = strip(exact).text;
	// Formatting was all there was to it; there's nothing left to recognise it by.
	if (quote.length === 0) return null;
	const stripped = strip(doc);
	const looseMatches: Span[] = [];
	for (let i = stripped.text.indexOf(quote); i !== -1; i = stripped.text.indexOf(quote, i + 1)) {
		// From the first kept character to just past the last: markup at either end of the
		// quote is left out of the highlight, markup inside it stays in.
		const from = stripped.at[i];
		const last = stripped.at[i + quote.length - 1];
		if (from === undefined || last === undefined) break;
		looseMatches.push({ from, to: last + 1 });
		if (looseMatches.length >= MAX_CANDIDATES) break;
	}
	return looseMatches.length > 0 ? pick(doc, looseMatches, weightOf(quote), start, context) : null;
}

interface Context {
	/** Recorded prefix and suffix, formatting stripped. */
	prefix: string;
	suffix: string;
	/** Agreement needed to trust a match on context alone. */
	required: number;
}

/**
 * The best of `candidates` by context, ties going to the one nearest where the quote used to
 * start — or null when even the best isn't trustworthy.
 */
function pick(doc: string, candidates: Span[], quoteWeight: number, start: number, context: Context): Span | null {
	let best: Span | null = null;
	let bestScore = -1;
	for (const span of candidates) {
		const score = contextScore(doc, span, context);
		if (
			score > bestScore ||
			(score === bestScore && best && Math.abs(span.from - start) < Math.abs(best.from - start))
		) {
			best = span;
			bestScore = score;
		}
	}
	if (!best) return null;
	const corroborated = bestScore >= context.required;
	// Uniqueness alone only vouches for a quote with some weight to it. For a short one it
	// proves little — and "some context agrees" is no rescue either, because a single shared
	// letter scores. That is exactly how a one-letter quote got attached to an unrelated
	// letter elsewhere.
	const distinctive = candidates.length === 1 && quoteWeight >= MIN_UNIQUE_LENGTH;
	return corroborated || distinctive ? best : null;
}

/**
 * Weighted characters of recorded context that still agree around `span`: how much of the
 * prefix still leads into it, plus how much of the suffix still follows it, counted outward
 * from the quote until the first difference — with formatting ignored on both sides.
 */
function contextScore(doc: string, span: Span, context: Context): number {
	const beforeFrom = Math.max(0, span.from - context.prefix.length - CONTEXT_SLACK);
	const before = strip(doc.slice(beforeFrom, span.from)).text;
	const after = strip(doc.slice(span.to, span.to + context.suffix.length + CONTEXT_SLACK)).text;
	return weightOf(sharedTail(before, context.prefix)) + weightOf(sharedHead(after, context.suffix));
}

/** The common ending of two strings — how much of the prefix still leads into the quote. */
function sharedTail(a: string, b: string): string {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return a.slice(a.length - n);
}

/** The common beginning of two strings — how much of the suffix still follows the quote. */
function sharedHead(a: string, b: string): string {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return a.slice(0, n);
}
