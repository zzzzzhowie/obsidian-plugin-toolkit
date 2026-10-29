/**
 * Code blocks named for a language Obsidian doesn't know, highlighted as one it does. JSON with
 * comments (```jsonc, VS Code's settings files) is JSON to both highlighters: the editor's JSON
 * mode and Reading view's Prism grammar already mark `//` and `/* *\/` comments, they just don't
 * answer to the name, so the block showed as plain text.
 */

import { loadPrism } from "obsidian";

/** A language the editor knows, as CodeMirror 5 lists it; the editor finds a fence's by name. */
interface ModeInfo {
	name: string;
	mime?: string;
	mimes?: string[];
	mode: string;
	ext?: string[];
	alias?: string[];
}

declare const CodeMirror: { modeInfo: ModeInfo[] };

/** A fence's language, the name its block is labelled with, and the language it's drawn as. */
const SAME_AS = [{ name: "jsonc", label: "JSONC", as: "json" }];

const named = (info: ModeInfo, name: string) =>
	info.name.toLowerCase() === name || (info.alias ?? []).includes(name);

/** Teaches both highlighters the names; the returned function takes them back. */
export function registerSameAsLanguages(): () => void {
	const modes: ModeInfo[] = [];
	for (const { name, label, as } of SAME_AS) {
		if (CodeMirror.modeInfo.some((info) => named(info, name))) continue;
		const base = CodeMirror.modeInfo.find((info) => named(info, as));
		// After the language it copies, so a lookup by its MIME type still finds that one.
		if (base) modes.push({ ...base, name: label, ext: [name], alias: [] });
	}
	CodeMirror.modeInfo.push(...modes);

	let prism: { languages: Record<string, unknown> } | undefined;
	const grammars: string[] = [];
	let undone = false;
	void loadPrism().then((loaded: { languages: Record<string, unknown> }) => {
		if (undone) return;
		prism = loaded;
		for (const { name, as } of SAME_AS) {
			if (prism.languages[name] || !prism.languages[as]) continue;
			prism.languages[name] = prism.languages[as];
			grammars.push(name);
		}
	});

	return () => {
		undone = true;
		for (const info of modes) CodeMirror.modeInfo.splice(CodeMirror.modeInfo.indexOf(info), 1);
		for (const name of grammars) delete prism?.languages[name];
	};
}
