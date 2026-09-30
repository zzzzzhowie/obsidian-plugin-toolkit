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
 * Agreeing context a match needs before it is trusted. Scored as characters of prefix and
 * suffix that still line up, so a single stray letter doesn't count as corroboration.
 */
const MIN_EVIDENCE = 8;

/**
 * A quote this long that occurs exactly once is distinctive enough to stand on its own, even
 * when everything around it has been rewritten. Shorter ones are not: a two-character quote
 * that happens to appear once is as likely to be a different occurrence as the original.
 */
const MIN_UNIQUE_LENGTH = 8;

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
 * Three steps, stopping at the first that answers:
 *
 * 1. The recorded position. Accepted only when the quote is still there *and* its context
 *    still agrees — text inserted further up can slide a different copy of a short word into
 *    exactly the old offsets, and a bare text match would then highlight the wrong one.
 * 2. Every occurrence of the quote, scored by how much of the recorded prefix and suffix
 *    still line up around it, ties going to the one nearest where it used to be. This is what
 *    finds a paragraph that was moved, or a note that grew above the comment.
 * 3. Otherwise nothing. The comment is kept, just not drawn — landing on the wrong words is
 *    worse than not landing, because it looks right.
 *
 * A quote that was itself rewritten is not searched for fuzzily; it simply fails step 2.
 */
export function anchor(doc: string, selectors: Selectors): Span | null {
	const { exact } = selectors;
	if (exact.length === 0) return null;

	// A quote sitting at the very edges of the note has less context to offer, and cannot be
	// held to more than it has.
	const required = Math.min(MIN_EVIDENCE, selectors.prefix.length + selectors.suffix.length);

	const { start, end } = selectors;
	if (
		start >= 0 &&
		end <= doc.length &&
		end - start === exact.length &&
		doc.slice(start, end) === exact &&
		contextScore(doc, start, selectors) >= required
	) {
		return { from: start, to: end };
	}

	const candidates: number[] = [];
	// `i + 1`, not `i + exact.length`: occurrences can overlap ("aa" in "aaa" occurs twice).
	for (let i = doc.indexOf(exact); i !== -1; i = doc.indexOf(exact, i + 1)) {
		candidates.push(i);
		if (candidates.length >= MAX_CANDIDATES) break;
	}
	if (candidates.length === 0) return null;

	let best = -1;
	let bestScore = -1;
	for (const at of candidates) {
		const score = contextScore(doc, at, selectors);
		if (
			score > bestScore ||
			(score === bestScore && Math.abs(at - start) < Math.abs(best - start))
		) {
			best = at;
			bestScore = score;
		}
	}

	const corroborated = bestScore >= required;
	// Uniqueness alone only vouches for a long quote. For a short one it proves little — and
	// "some context agrees" is no rescue either, because a single shared space scores. That
	// is exactly how a one-letter quote got attached to an unrelated letter elsewhere.
	const distinctive = candidates.length === 1 && exact.length >= MIN_UNIQUE_LENGTH;
	if (!corroborated && !distinctive) return null;
	return { from: best, to: best + exact.length };
}

/** Characters of recorded context that still agree around a match starting at `at`. */
function contextScore(doc: string, at: number, selectors: Selectors): number {
	const { prefix, suffix, exact } = selectors;
	const before = doc.slice(Math.max(0, at - prefix.length), at);
	const afterStart = at + exact.length;
	const after = doc.slice(afterStart, afterStart + suffix.length);
	return sharedTail(before, prefix) + sharedHead(after, suffix);
}

/** Length of the common ending — how much of the prefix still leads into the quote. */
function sharedTail(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

/** Length of the common beginning — how much of the suffix still follows the quote. */
function sharedHead(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}
