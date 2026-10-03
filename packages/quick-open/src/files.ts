import type { TFile } from "obsidian";

// How a file is named and pictured, in the Go to File list and the new-tab list alike.

/** Notes by their name alone, as everywhere else in Obsidian; other files with their extension. */
export function displayName(file: TFile): string {
	return file.extension === "md" ? file.basename : file.name;
}

/** The folder a file is in, or "" at the vault root. */
export function folderOf(file: TFile): string {
	const parent = file.parent?.path ?? "/";
	return parent === "/" ? "" : parent;
}

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "ogg", "flac", "webm", "3gp"]);
const VIDEO = new Set(["mp4", "mov", "mkv", "ogv"]);

export function iconFor(file: TFile): string {
	const ext = file.extension.toLowerCase();
	if (ext === "md") return "file-text";
	if (ext === "canvas") return "layout-dashboard";
	if (ext === "base") return "table";
	if (ext === "pdf") return "file-type";
	if (IMAGE.has(ext)) return "image";
	if (AUDIO.has(ext)) return "file-audio";
	if (VIDEO.has(ext)) return "file-video";
	return "file";
}
