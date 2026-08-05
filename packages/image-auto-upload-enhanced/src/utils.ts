import { extname, join } from "path-browserify";
import type { Readable } from "stream";

export interface IStringKeyMap<T> {
  [key: string]: T;
}

const IMAGE_EXT_LIST = [
  ".png",
  ".jpg",
  ".jpeg",
  ".bmp",
  ".gif",
  ".svg",
  ".tiff",
  ".webp",
  ".avif",
];

export function isAnImage(ext: string) {
  return IMAGE_EXT_LIST.includes(ext.toLowerCase());
}
export function isAssetTypeAnImage(path: string): Boolean {
  return isAnImage(extname(path));
}

export async function streamToString(stream: Readable) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  // @ts-ignore
  return Buffer.concat(chunks).toString("utf-8");
}

export function getUrlAsset(url: string) {
  const fileName = url.substring(1 + url.lastIndexOf("/"));
  return fileName.split("?")[0]!.split("#")[0]!;
}

export function getLastImage(list: string[]) {
  const reversedList = list.reverse();
  let lastImage: string | undefined;
  reversedList.forEach(item => {
    if (item && item.startsWith("http")) {
      lastImage = item;
    }
  });
  return lastImage;
}

interface AnyObj {
  [key: string]: any;
}

export function arrayToObject<T extends AnyObj>(
  arr: T[],
  key: string
): { [key: string]: T } {
  const obj: { [key: string]: T } = {};
  arr.forEach(element => {
    obj[element[key]] = element;
  });
  return obj;
}

export function bufferToArrayBuffer(buffer: Buffer) {
  const arrayBuffer = new ArrayBuffer(buffer.length);
  const view = new Uint8Array(arrayBuffer);
  for (let i = 0; i < buffer.length; i++) {
    view[i] = buffer[i]!;
  }
  return arrayBuffer;
}

export function arrayBufferToBuffer(arrayBuffer: ArrayBuffer) {
  const buffer = Buffer.alloc(arrayBuffer.byteLength);
  const view = new Uint8Array(arrayBuffer);
  for (let i = 0; i < buffer.length; ++i) {
    buffer[i] = view[i]!;
  }
  return buffer;
}

export function uuid() {
  return Math.random().toString(36).slice(2);
}

/**
 * Write pasted image bytes to the OS temp directory and return the paths.
 *
 * Named the way PicGo names its own clipboard temp files
 * (`YYYYMMDDHHmmssSSS.ext`), because with no rename plugin configured PicGo
 * derives the remote object key from the file name — reusing e.g. `image.png`
 * would overwrite an earlier upload.
 */
export async function writeImagesToTemp(
  fileList?: FileList | File[]
): Promise<string[]> {
  const { writeFile } = require("fs/promises") as typeof import("fs/promises");
  const { tmpdir } = require("os") as typeof import("os");

  // Take the list while the paste event is still dispatching: a DataTransfer's
  // file list is unreadable afterwards, and the first await below lands after it.
  const files = Array.from(fileList ?? []);

  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) {
      continue;
    }
    const name = `${timestamp()}${i === 0 ? "" : `-${i}`}${imageExt(file)}`;
    const path = join(tmpdir(), name);
    await writeFile(path, Buffer.from(await file.arrayBuffer()));
    paths.push(path);
  }
  return paths;
}

export async function removeTempFiles(paths: string[]) {
  const { unlink } = require("fs/promises") as typeof import("fs/promises");

  await Promise.all(
    paths.map(path =>
      unlink(path).catch((e: unknown) =>
        console.error("Could not remove temp file: ", path, e)
      )
    )
  );
}

function timestamp() {
  const now = new Date();
  const pad = (value: number, length = 2) =>
    String(value).padStart(length, "0");

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    pad(now.getMilliseconds(), 3),
  ].join("");
}

/** The pasted file's own extension when it has one, else the MIME subtype. */
function imageExt(file: File) {
  const ext = extname(file.name ?? "").toLowerCase();
  if (isAnImage(ext)) {
    return ext;
  }
  const fromMime = `.${(file.type.split("/")[1] ?? "").split("+")[0]}`;
  return isAnImage(fromMime) ? fromMime : ".png";
}
