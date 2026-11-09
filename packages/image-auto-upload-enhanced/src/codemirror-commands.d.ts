// Obsidian ships @codemirror/commands at runtime (it's external in the build); only the two
// commands this plugin runs are typed here, rather than adding the package for its types.
declare module "@codemirror/commands" {
	import type { EditorView } from "@codemirror/view";
	export function undo(view: EditorView): boolean;
	export function redo(view: EditorView): boolean;
}
