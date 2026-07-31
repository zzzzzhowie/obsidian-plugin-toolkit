export interface Match {
	from: number;
	to: number;
}

/**
 * Plain-substring scan. Returns every non-overlapping occurrence in document order.
 *
 * Case-insensitive mode lowercases the haystack and indexes into it directly, so the
 * offsets it reports are only valid while lowercasing is length-preserving. A few
 * code points break that (U+0130 "İ" lowercases to two code units); when it happens
 * we fall back to a case-sensitive scan instead of reporting shifted positions.
 */
export function findInText(haystack: string, needle: string, caseSensitive: boolean): Match[] {
	if (!needle) return [];

	let hay = haystack;
	let ned = needle;
	if (!caseSensitive) {
		const lowered = haystack.toLowerCase();
		if (lowered.length === haystack.length) {
			hay = lowered;
			ned = needle.toLowerCase();
		}
	}

	const matches: Match[] = [];
	let at = hay.indexOf(ned);
	while (at !== -1) {
		matches.push({ from: at, to: at + ned.length });
		at = hay.indexOf(ned, at + ned.length);
	}
	return matches;
}

/** Index of the first match at or after `pos`, or 0 when there is nothing after it. */
export function matchIndexNear(matches: Match[], pos: number): number {
	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		if (match && match.from >= pos) return i;
	}
	return 0;
}
