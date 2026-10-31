import { type ChangeDesc, Text } from "@codemirror/state";

/** Lines a reference points at, as a span of the note's text. */
interface Span {
	from: number;
	to: number;
	/** Lines past the note's last (a Removed reference to what followed it): the line after the last while at the end. */
	after: boolean;
	/** The note changed in a way this span couldn't follow (outside any editor): its lines may be off. */
	stale: boolean;
}

/** One note's text as the spans following it stand on it, and those spans. */
interface Version {
	/** Null while the note is still being read. */
	doc: Text | null;
	spans: Set<Span>;
}

/**
 * Keep the lines a reply's references point at on the same text while the note is edited
 * after it: lines deleted above them move them up, lines added move them down, so a list of
 * suggestions stays right while they're worked through one by one.
 *
 * A reference's lines are taken as a span of the note's text the first time it's shown — on
 * the note as it is then, which for a reply is the note it just wrote about. Each edit after
 * that is mapped through the span, but only an edit made to that very text: one starting from
 * any other (the note changed where no editor saw it — on disk with the note closed, on
 * another device) leaves the spans stale, and they say so rather than point somewhere wrong.
 * Kept in memory: after a restart a reference is its line numbers again.
 */
export class LineTracker {
	private readonly versions = new Map<string, Version>();
	private readonly spans = new Map<string, Span>();

	/**
	 * Follow lines `start`–`end` (1-based) of the note at `path` under `key`, from `doc` — the
	 * note's text in an open editor, else a read of the file. Once per key: shown again, a
	 * reference keeps the span it has, however the note has moved since.
	 */
	follow(key: string, path: string, start: number, end: number, doc: () => Text | Promise<Text>): void {
		if (this.spans.has(key) || !start) return;
		const span: Span = { from: 0, to: 0, after: false, stale: false };
		this.spans.set(key, span);
		let version = this.versions.get(path);
		const place = (text: Text): void => {
			// Past the end (a Removed reference to the lines after the last): the end.
			const first = start > text.lines ? null : text.line(start);
			span.after = !first;
			span.from = first ? first.from : text.length;
			span.to = first ? text.line(Math.min(Math.max(end, start), text.lines)).to : text.length;
		};
		if (version?.doc) {
			place(version.doc);
			version.spans.add(span);
			return;
		}
		if (!version) {
			version = { doc: null, spans: new Set() };
			this.versions.set(path, version);
		}
		const pending = version;
		const loaded = doc();
		const ready = (text: Text): void => {
			// An editor's update may have set it meanwhile; the spans waiting stand on that one.
			pending.doc ??= text;
			place(pending.doc);
			pending.spans.add(span);
		};
		if (loaded instanceof Text) ready(loaded);
		else void loaded.then(ready, () => this.spans.delete(key));
	}

	/**
	 * Lines `key` points at now, or null for a key not followed. Given the note as it is, also
	 * whether that's what the span stands on: if not, it changed where no editor saw it.
	 */
	lines(key: string, path: string, doc?: Text): { start: number; end: number; stale: boolean } | null {
		const span = this.spans.get(key);
		const version = this.versions.get(path);
		if (!span || !version?.doc) return null;
		const stale = span.stale || (!!doc && version.doc !== doc && !version.doc.eq(doc));
		const text = version.doc;
		if (span.after && span.from >= text.length) return { start: text.lines + 1, end: text.lines + 1, stale };
		return { start: text.lineAt(Math.min(span.from, text.length)).number, end: text.lineAt(Math.min(span.to, text.length)).number, stale };
	}

	/**
	 * An edit to the note at `path`, from `before` to `after`. Mapped only when it starts from
	 * the text the spans stand on; the same edit seen again — the note open in a second pane,
	 * which is handed it too — is already in. Anything else, and the spans can't follow: stale.
	 */
	edited(path: string, before: Text, after: Text, changes: ChangeDesc): void {
		const version = this.versions.get(path);
		if (!version?.doc) return;
		if (version.doc === before || version.doc.eq(before)) {
			for (const span of version.spans) {
				// Text put in right at either end stays outside the lines.
				span.from = changes.mapPos(span.from, 1);
				span.to = Math.max(span.from, changes.mapPos(span.to, -1));
			}
			version.doc = after;
			return;
		}
		if (version.doc === after || version.doc.eq(after)) return;
		for (const span of version.spans) span.stale = true;
		// Lines followed from now on stand on the note as it is.
		this.versions.set(path, { doc: after, spans: new Set() });
	}
}
