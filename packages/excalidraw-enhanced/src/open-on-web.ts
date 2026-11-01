import { type App, Notice, requestUrl, type TFile, type View } from "obsidian";

/**
 * Open a drawing on excalidraw.com, as its "Shareable link" does: the scene is compressed,
 * encrypted with a fresh AES-GCM key, posted to Excalidraw's JSON store, and opened as
 * `https://excalidraw.com/#json=<id>,<key>`. The key stays in the URL's fragment, so the store
 * only ever holds ciphertext. A snapshot: edits on the web don't come back to the vault.
 *
 * The format is excalidraw-app's `exportToBackend` / `compressData` (packages/excalidraw/data/encode.ts).
 */
const BACKEND_POST = "https://json.excalidraw.com/api/v2/post/";
const WEB_APP = "https://excalidraw.com/";

/** The few fields of Excalidraw's elements and scene this needs. */
interface SceneElement {
	type: string;
	isDeleted?: boolean;
	fileId?: string | null;
}
interface Scene {
	elements: readonly SceneElement[];
	appState?: { viewBackgroundColor?: string; gridSize?: number | null };
}

/** Excalidraw's view: its live scene, unsaved strokes included. */
export interface ExcalidrawView extends View {
	file: TFile | null;
	excalidrawAPI?: {
		getSceneElements(): readonly SceneElement[];
		getAppState(): Scene["appState"];
	};
}

/** The bit of ExcalidrawAutomate this uses: Excalidraw publishes it on `window`. */
interface ExcalidrawAutomate {
	isExcalidrawFile(file: TFile): boolean;
	getSceneFromFile(file: TFile): Promise<Scene | null>;
}

function automate(): ExcalidrawAutomate | null {
	return (window as unknown as { ExcalidrawAutomate?: ExcalidrawAutomate }).ExcalidrawAutomate ?? null;
}

export function isDrawing(app: App, file: TFile | null): file is TFile {
	if (!file || file.extension !== "md") return false;
	const ea = automate();
	if (ea) return ea.isExcalidrawFile(file);
	return !!app.metadataCache.getFileCache(file)?.frontmatter?.["excalidraw-plugin"];
}

/** The drawing's scene: from a view it's open in (what's on screen), else read from the file. */
async function sceneOf(app: App, file: TFile): Promise<Scene | null> {
	for (const leaf of app.workspace.getLeavesOfType("excalidraw")) {
		const view = leaf.view as ExcalidrawView;
		if (view.file?.path === file.path && view.excalidrawAPI) {
			return { elements: view.excalidrawAPI.getSceneElements(), appState: view.excalidrawAPI.getAppState() };
		}
	}
	return (await automate()?.getSceneFromFile(file)) ?? null;
}

export async function openOnWeb(app: App, file: TFile): Promise<void> {
	const notice = new Notice("Uploading the drawing to Excalidraw web…", 0);
	try {
		const scene = await sceneOf(app, file);
		if (!scene) throw new Error("couldn't read the drawing");
		const elements = scene.elements.filter((element) => !element.isDeleted);
		const json = JSON.stringify({
			type: "excalidraw",
			version: 2,
			source: WEB_APP,
			elements,
			appState: {
				viewBackgroundColor: scene.appState?.viewBackgroundColor ?? "#ffffff",
				gridSize: scene.appState?.gridSize ?? null,
			},
		});
		const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["encrypt", "decrypt"]);
		const keyString = (await crypto.subtle.exportKey("jwk", key)).k;
		if (!keyString) throw new Error("couldn't make a key");
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const encoder = new TextEncoder();
		const body = concatBuffers(encoder.encode("null"), encoder.encode(json));
		const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await deflate(body)));
		const info = encoder.encode(JSON.stringify({ version: 2, compression: "pako@1", encryption: "AES-GCM" }));
		const payload = concatBuffers(info, iv, encrypted);

		const response = await requestUrl({
			url: BACKEND_POST,
			method: "POST",
			contentType: "application/octet-stream",
			body: payload.buffer,
			throw: false,
		});
		const result = response.json as { id?: string; error_class?: string } | null;
		if (!result?.id) {
			throw new Error(result?.error_class === "RequestTooLargeError" ? "the drawing is too large" : `upload failed (${response.status})`);
		}
		const url = `${WEB_APP}#json=${result.id},${keyString}`;
		window.open(url);
		await navigator.clipboard.writeText(url);
		// Images live in the vault and the share link's store doesn't hold them.
		const images = elements.filter((element) => element.type === "image").length;
		notice.setMessage(
			images
				? `Opened on excalidraw.com, link copied. ${images} image${images > 1 ? "s" : ""} (images, embedded notes, LaTeX) can't go along.`
				: "Opened on excalidraw.com, link copied.",
		);
	} catch (error) {
		notice.setMessage(`Couldn't open on excalidraw.com: ${error instanceof Error ? error.message : String(error)}`);
	}
	window.setTimeout(() => notice.hide(), 6000);
}

/** zlib deflate, as pako's default: what excalidraw.com inflates. */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
	const Stream = (window as unknown as { CompressionStream: new (format: string) => TransformStream<Uint8Array, Uint8Array> })
		.CompressionStream;
	const stream = new Blob([data]).stream().pipeThrough(new Stream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Excalidraw's chunk format: a uint32 version (1), then each chunk as a uint32 length and its bytes. */
function concatBuffers(...buffers: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(4 + 4 * buffers.length + buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0));
	const view = new DataView(out.buffer);
	let cursor = 0;
	view.setUint32(cursor, 1);
	cursor += 4;
	for (const buffer of buffers) {
		view.setUint32(cursor, buffer.byteLength);
		cursor += 4;
		out.set(buffer, cursor);
		cursor += buffer.byteLength;
	}
	return out;
}
