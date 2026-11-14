import * as electron from "electron";
import { promises as fs } from "fs";
import { type App, Menu, Notice, Platform, type Plugin, type TFile, requestUrl } from "obsidian";
import { basename, extname, join } from "path";

/**
 * "Save image as…" in the menu Obsidian gives an image in a note (Copy image, Remove image,
 * Reset size): the image written where you choose, as the file it is — a vault image read from
 * the vault, an uploaded one fetched from its URL.
 *
 * Obsidian builds that menu in the image's own `contextmenu` handler, through `Menu.forEvent`,
 * which keeps one menu per event and shows it a moment later. A listener on the document hears
 * the same event after it: asked for that event's menu, it gets the one being built and adds
 * to it before it shows. An image Obsidian gave no menu (the event's default not prevented) is
 * left to whatever else handles it.
 */

interface ElectronRemote {
	app: { getPath(name: "downloads"): string };
	dialog: {
		showSaveDialog(window: unknown, options: { defaultPath: string; filters?: { name: string; extensions: string[] }[] }): Promise<{ canceled: boolean; filePath?: string }>;
	};
	getCurrentWindow(): unknown;
}

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"image/avif": "avif",
	"image/bmp": "bmp",
};

export function registerSaveImageAs(plugin: Plugin): void {
	if (!Platform.isDesktopApp) return;
	const { app } = plugin;
	plugin.registerDomEvent(document, "contextmenu", (event: MouseEvent) => {
		if (!event.defaultPrevented || !(event.target instanceof Element)) return;
		const img = event.target.closest(".markdown-source-view .image-embed img, .markdown-source-view img.image-embed, .markdown-preview-view img");
		if (!(img instanceof HTMLImageElement)) return;
		Menu.forEvent(event).addItem((item) =>
			item
				.setSection("image")
				.setTitle("Save image as…")
				.setIcon("lucide-download")
				.onClick(() => void saveAs(app, img)),
		);
	});
}

/** The vault file a note's image shows, when it shows one. */
function vaultFileOf(app: App, img: HTMLImageElement): TFile | null {
	const linktext = img.closest(".internal-embed")?.getAttribute("src");
	if (!linktext) return null;
	const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.containerEl.contains(img));
	const sourcePath = (leaf?.view as { file?: TFile } | undefined)?.file?.path ?? "";
	return app.metadataCache.getFirstLinkpathDest(linktext.replace(/[#|].*$/, ""), sourcePath);
}

/** The image's bytes and the name to suggest for them. */
async function read(app: App, img: HTMLImageElement): Promise<{ data: ArrayBuffer; name: string }> {
	const file = vaultFileOf(app, img);
	if (file) return { data: await app.vault.readBinary(file), name: file.name };
	const src = img.currentSrc || img.src;
	// A file on disk — `![](attachments/x.png)` is shown from its path, not as a vault embed.
	if (src.startsWith("app://")) {
		const path = decodeURIComponent(new URL(src).pathname);
		const bytes = await fs.readFile(path);
		return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), name: basename(path) };
	}
	if (!/^https?:/i.test(src)) return { data: await asPng(img), name: nameFor(src, "image/png") };
	const response = await requestUrl({ url: src });
	const type = response.headers["content-type"] ?? response.headers["Content-Type"] ?? "";
	return { data: response.arrayBuffer, name: nameFor(src, type.split(";")[0]?.trim() ?? "") };
}

/** Anything else on show (a data: URL, say): the picture as it was decoded, as a PNG. */
async function asPng(img: HTMLImageElement): Promise<ArrayBuffer> {
	const canvas = img.doc.createElement("canvas");
	canvas.width = img.naturalWidth;
	canvas.height = img.naturalHeight;
	canvas.getContext("2d")?.drawImage(img, 0, 0);
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	if (!blob) throw new Error("the image couldn't be drawn");
	return blob.arrayBuffer();
}

/** A file name from the URL's last path segment, with an extension from its type if it has none. */
function nameFor(src: string, type: string): string {
	let base = "";
	try {
		base = decodeURIComponent(new URL(src).pathname.split("/").pop() ?? "");
	} catch {
		// A data: URL or one that doesn't parse: named below.
	}
	base = base.replace(/[\\/:*?"<>|]/g, "_");
	if (!base) base = "image";
	if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += `.${EXTENSIONS[type] ?? "png"}`;
	return base;
}

async function saveAs(app: App, img: HTMLImageElement): Promise<void> {
	try {
		const { data, name } = await read(app, img);
		// @electron/remote, as Obsidian exposes it; not in Electron's own types any more.
		const remote = (electron as unknown as { remote: ElectronRemote }).remote;
		const ext = extname(name).slice(1);
		const { canceled, filePath } = await remote.dialog.showSaveDialog(remote.getCurrentWindow(), {
			defaultPath: join(remote.app.getPath("downloads"), name),
			filters: ext ? [{ name: "Image", extensions: [ext] }] : undefined,
		});
		if (canceled || !filePath) return;
		await fs.writeFile(filePath, new Uint8Array(data));
		new Notice(`Saved to ${filePath}`);
	} catch (error) {
		console.error("image-auto-upload-enhanced: couldn't save the image", error);
		new Notice("Couldn't save the image");
	}
}
