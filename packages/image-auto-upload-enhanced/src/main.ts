import {
  MarkdownView,
  Plugin,
  Editor,
  EditorPosition,
  Menu,
  MenuItem,
  TFile,
  normalizePath,
  Notice,
  addIcon,
  MarkdownFileInfo,
} from "obsidian";
import { resolve, basename, dirname } from "path-browserify";

import {
  isAssetTypeAnImage,
  arrayToObject,
  imageSizeOf,
  type ImageSize,
} from "./utils";
import { downloadAllImageFiles } from "./download";
import { UploaderManager } from "./uploader/index";
import { PicGoDeleter } from "./deleter";
import Helper from "./helper";
import { t } from "./lang/helpers";
import { SettingTab, PluginSettings, DEFAULT_SETTINGS } from "./setting";

import type { Image } from "./types";

/**
 * How long to wait before checking whether a write actually landed. Only has to outlast
 * the `setTimeout` Obsidian's table-cell editor re-dispatches through; a delay this short
 * is invisible next to the upload it follows.
 */
const RETRY_DELAY = 50;

export default class imageAutoUploadPlugin extends Plugin {
  settings: PluginSettings;
  helper: Helper;
  editor: Editor;
  picGoDeleter: PicGoDeleter;

  async loadSettings() {
    this.settings = Object.assign(DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {}

  async onload() {
    await this.loadSettings();

    this.helper = new Helper(this.app);
    this.picGoDeleter = new PicGoDeleter(this);

    addIcon(
      "upload",
      `<svg t="1636630783429" class="icon" viewBox="0 0 100 100" version="1.1" p-id="4649" xmlns="http://www.w3.org/2000/svg">
      <path d="M 71.638 35.336 L 79.408 35.336 C 83.7 35.336 87.178 38.662 87.178 42.765 L 87.178 84.864 C 87.178 88.969 83.7 92.295 79.408 92.295 L 17.249 92.295 C 12.957 92.295 9.479 88.969 9.479 84.864 L 9.479 42.765 C 9.479 38.662 12.957 35.336 17.249 35.336 L 25.019 35.336 L 25.019 42.765 L 17.249 42.765 L 17.249 84.864 L 79.408 84.864 L 79.408 42.765 L 71.638 42.765 L 71.638 35.336 Z M 49.014 10.179 L 67.326 27.688 L 61.835 32.942 L 52.849 24.352 L 52.849 59.731 L 45.078 59.731 L 45.078 24.455 L 36.194 32.947 L 30.702 27.692 L 49.012 10.181 Z" p-id="4650" fill="#8a8a8a"></path>
    </svg>`
    );

    this.addSettingTab(new SettingTab(this.app, this));

    this.addCommand({
      id: "Upload all images",
      name: "Upload all images",
      checkCallback: (checking: boolean) => {
        let leaf = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (leaf) {
          if (!checking) {
            this.uploadAllFile();
          }
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "Download all images",
      name: "Download all images",
      checkCallback: (checking: boolean) => {
        let leaf = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (leaf) {
          if (!checking) {
            downloadAllImageFiles(this);
          }
          return true;
        }
        return false;
      },
    });
    this.setupPasteHandler();
    this.registerFileMenu();
    this.registerSelection();
  }

  /**
   * 获取当前使用的上传器
   */
  getUploader() {
    const uploader = new UploaderManager(this.settings.uploader, this);

    return uploader;
  }

  /**
   * 上传图片
   */
  upload(images: Image[] | string[]) {
    let uploader = this.getUploader();
    return uploader.upload(images);
  }

  /**
   * 通过剪贴板上传图片
   */
  uploadByClipboard(fileList?: FileList) {
    let uploader = this.getUploader();
    return uploader.uploadByClipboard(fileList);
  }

  registerSelection() {
    this.registerEvent(
      this.app.workspace.on(
        "editor-menu",
        (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
          if (this.app.workspace.getLeavesOfType("markdown").length === 0) {
            return;
          }
          const selection = editor.getSelection();
          if (selection) {
            const markdownRegex = /!\[.*\]\((.*)\)/g;
            const markdownMatch = markdownRegex.exec(selection);
            if (markdownMatch && markdownMatch.length > 1) {
              const markdownUrl = markdownMatch[1];
              if (
                markdownUrl &&
                this.settings.uploadedImages.find(
                  (item: { imgUrl: string }) => item.imgUrl === markdownUrl
                )
              ) {
                this.addRemoveMenu(menu, markdownUrl, editor);
              }
            }
          }
        }
      )
    );
  }

  addRemoveMenu = (menu: Menu, imgPath: string, editor: Editor) => {
    menu.addItem((item: MenuItem) =>
      item
        .setIcon("trash-2")
        .setTitle(t("Delete image using PicList"))
        .onClick(async () => {
          try {
            const selectedItem = this.settings.uploadedImages.find(
              (item: { imgUrl: string }) => item.imgUrl === imgPath
            );
            if (selectedItem) {
              const res = await this.picGoDeleter.deleteImage([selectedItem]);
              if (res.success) {
                new Notice(t("Delete successfully"));
                const selection = editor.getSelection();
                if (selection) {
                  editor.replaceSelection("");
                }
                this.settings.uploadedImages =
                  this.settings.uploadedImages.filter(
                    (item: { imgUrl: string }) => item.imgUrl !== imgPath
                  );
                this.saveSettings();
              } else {
                new Notice(t("Delete failed"));
              }
            }
          } catch {
            new Notice(t("Error, could not delete"));
          }
        })
    );
  };

  registerFileMenu() {
    this.registerEvent(
      this.app.workspace.on(
        "file-menu",
        (menu: Menu, file: TFile, source: string, leaf) => {
          if (source === "canvas-menu") return;
          if (!isAssetTypeAnImage(file.path)) return;

          menu.addItem((item: MenuItem) => {
            item
              .setTitle(t("upload"))
              .setIcon("upload")
              .onClick(() => {
                if (!(file instanceof TFile)) {
                  return;
                }
                this.fileMenuUpload(file);
              });
          });
        }
      )
    );
  }

  fileMenuUpload(file: TFile) {
    let imageList: Image[] = [];
    const fileArray = this.helper.getAllFiles();

    for (const match of fileArray) {
      const imageName = match.name;
      const encodedUri = match.path;

      const fileName = basename(decodeURI(encodedUri));

      if (file && file.name === fileName) {
        if (isAssetTypeAnImage(file.path)) {
          imageList.push({
            path: file.path,
            name: imageName,
            source: match.source,
            file: file,
          });
        }
      }
    }

    if (imageList.length === 0) {
      new Notice(t("Can not find image file"));
      return;
    }

    this.upload(imageList).then(res => {
      if (!res.success) {
        new Notice("Upload error");
        return;
      }

      let uploadUrlList = res.result;
      this.replaceImage(imageList, uploadUrlList);
    });
  }

  filterFile(fileArray: Image[]) {
    const imageList: Image[] = [];

    for (const match of fileArray) {
      if (match.path.startsWith("http")) {
        if (this.settings.workOnNetWork) {
          if (
            !this.helper.hasBlackDomain(
              match.path,
              this.settings.newWorkBlackDomains
            )
          ) {
            imageList.push({
              path: match.path,
              name: match.name,
              source: match.source,
            });
          }
        }
      } else {
        imageList.push({
          path: match.path,
          name: match.name,
          source: match.source,
        });
      }
    }

    return imageList;
  }

  /**
   * 替换上传的图片
   */
  replaceImage(imageList: Image[], uploadUrlList: string[]) {
    // Rebuild per line so we can tell whether each occurrence sits in a table
    // row and escape the size-suffix pipe there (never split on `|`).
    let lines = this.helper.getValue().split("\n");

    imageList.map(item => {
      const uploadImage = uploadUrlList.shift();

      lines = lines.map(line => {
        if (!line.includes(item.source)) return line;
        let name = this.handleName(item.name);
        if (this.lineIsTableRow(line, item.source)) {
          name = this.escapeAltPipes(name);
        }
        return line.split(item.source).join(`![${name}](${uploadImage})`);
      });
    });

    this.helper.setValue(lines.join("\n"));

    if (this.settings.deleteSource) {
      imageList.map(image => {
        if (image.file && !image.path.startsWith("http")) {
          this.app.fileManager.trashFile(image.file);
        }
      });
    }
  }

  /**
   * 上传所有图片
   */
  uploadAllFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice(t("Can not find image file"));
      return;
    }
    const fileMap = arrayToObject(this.app.vault.getFiles(), "name");
    const filePathMap = arrayToObject(this.app.vault.getFiles(), "path");
    let imageList: (Image & { file: TFile | null })[] = [];
    const fileArray = this.filterFile(this.helper.getAllFiles());

    for (const match of fileArray) {
      const imageName = match.name;
      const uri = decodeURI(match.path);

      if (uri.startsWith("http")) {
        imageList.push({
          path: match.path,
          name: imageName,
          source: match.source,
          file: null,
        });
      } else {
        const fileName = basename(uri);
        let file: TFile | undefined | null;
        // 优先匹配绝对路径
        if (filePathMap[uri]) {
          file = filePathMap[uri];
        }

        // 相对路径
        if ((!file && uri.startsWith("./")) || uri.startsWith("../")) {
          const filePath = normalizePath(
            resolve(dirname(activeFile.path), uri)
          );

          file = filePathMap[filePath];
        }

        // 尽可能短路径
        if (!file) {
          file = fileMap[fileName];
        }

        if (file) {
          if (isAssetTypeAnImage(file.path)) {
            imageList.push({
              path: normalizePath(file.path),
              name: imageName,
              source: match.source,
              file: file,
            });
          }
        }
      }
    }

    if (imageList.length === 0) {
      new Notice(t("Can not find image file"));
      return;
    } else {
      new Notice(`Have found ${imageList.length} images`);
    }

    this.upload(imageList).then(res => {
      let uploadUrlList = res.result;
      if (imageList.length !== uploadUrlList.length) {
        new Notice(
          t("Warning: upload files is different of reciver files from api")
        );
        return;
      }
      const currentFile = this.app.workspace.getActiveFile();
      if (activeFile.path !== currentFile?.path) {
        new Notice(t("File has been changedd, upload failure"));
        return;
      }

      this.replaceImage(imageList, uploadUrlList);
    });
  }

  setupPasteHandler() {
    this.registerEvent(
      this.app.workspace.on(
        "editor-paste",
        (evt: ClipboardEvent, editor: Editor, markdownView: MarkdownView) => {
          const allowUpload = this.helper.getFrontmatterValue(
            "image-auto-upload",
            this.settings.uploadByClipSwitch
          );

          if (!evt.clipboardData) {
            return;
          }
          let files = evt.clipboardData.files;
          if (!allowUpload) {
            return;
          }

          const clipboardData = evt.clipboardData;

          // 剪贴板中是图片文件时进行上传，优先处理（避免与下方网络图片分支重复插入）
          if (this.canUpload(clipboardData)) {
            evt.preventDefault();
            this.uploadFileAndEmbedImgurImage(
              editor,
              async (editor: Editor, pasteId: string) => {
                let res: any;
                res = await this.uploadByClipboard(clipboardData.files);

                if (!res.success) {
                  this.handleFailedUpload(editor, pasteId, res.msg);
                  return;
                }
                const url = res.result[0];

                return url;
              },
              clipboardData
            ).catch(e => console.error("Paste upload failed: ", e));
            return;
          }

          // 剪贴板内容含 http 图片链接时，上传到 OSS 并只保留 OSS 地址
          if (this.settings.workOnNetWork) {
            const clipboardValue = clipboardData.getData("text/plain");
            const imageList = this.helper
              .getImageLink(clipboardValue)
              .filter(image => image.path.startsWith("http"))
              .filter(
                image =>
                  !this.helper.hasBlackDomain(
                    image.path,
                    this.settings.newWorkBlackDomains
                  )
              );

            if (imageList.length !== 0) {
              // 自行插入剪贴板内容并阻止 Obsidian 默认插入，确保 source 精确匹配，
              // 上传完成后把原始地址替换为 OSS 地址（不会残留原图）
              evt.preventDefault();
              editor.replaceSelection(clipboardValue);
              this.upload(imageList).then(res => {
                this.replaceImage(imageList, res.result);
              });
            }
          }
        }
      )
    );
    this.registerEvent(
      this.app.workspace.on(
        "editor-drop",
        async (evt: DragEvent, editor: Editor, markdownView: MarkdownView) => {
          // when ctrl key is pressed, do not upload image, because it is used to set local file
          if (evt.ctrlKey) {
            return;
          }
          const allowUpload = this.helper.getFrontmatterValue(
            "image-auto-upload",
            this.settings.uploadByClipSwitch
          );

          if (!allowUpload) {
            return;
          }

          if (!evt.dataTransfer) {
            return;
          }
          let files = evt.dataTransfer.files;
          if (files.length !== 0 && files[0]?.type.startsWith("image")) {
            let sendFiles: Array<string> = [];
            let files = evt.dataTransfer.files;
            Array.from(files).forEach((item, index) => {
              const filePath = (item as File & { path?: string }).path;
              if (filePath) {
                sendFiles.push(filePath);
              } else {
                const { webUtils } = require("electron");
                const path = webUtils.getPathForFile(item);
                sendFiles.push(path);
              }
            });
            evt.preventDefault();

            const data = await this.upload(sendFiles);

            if (data.success) {
              data.result.map((value: string, index: number) => {
                let pasteId = (Math.random() + 1).toString(36).substr(2, 5);
                this.insertTemporaryText(editor, pasteId);
                this.embedMarkDownImage(
                  editor,
                  pasteId,
                  value,
                  files[index]?.name ?? ""
                );
              });
            } else {
              new Notice("Upload error");
            }
          }
        }
      )
    );
  }

  canUpload(clipboardData: DataTransfer) {
    this.settings.applyImage;
    const files = clipboardData.files;
    const text = clipboardData.getData("text");

    const hasImageFile =
      files.length !== 0 && !!files[0]?.type.startsWith("image");
    if (hasImageFile) {
      if (!!text) {
        return this.settings.applyImage;
      } else {
        return true;
      }
    } else {
      return false;
    }
  }

  async uploadFileAndEmbedImgurImage(
    editor: Editor,
    callback: Function,
    clipboardData: DataTransfer
  ) {
    let pasteId = (Math.random() + 1).toString(36).substr(2, 5);
    if (!this.insertTemporaryText(editor, pasteId)) {
      new Notice(t("Could not write to the note, paste again"));
      return;
    }
    // Read off the event synchronously: a DataTransfer is unreadable once the paste
    // has finished dispatching, though the File it handed over stays valid.
    const file = clipboardData.files[0] ?? null;
    const name = file?.name ?? "";
    // Measured alongside the upload rather than before it, so it costs no latency.
    const size = file ? imageSizeOf(file) : Promise.resolve(null);

    try {
      const url = await callback(editor, pasteId);
      this.embedMarkDownImage(editor, pasteId, url, name, await size);
    } catch (e) {
      this.handleFailedUpload(editor, pasteId, e);
    }
  }

  /**
   * Acknowledge the paste right away, before any upload work: the placeholder is
   * the only feedback the user gets while the request is in flight.
   *
   * Returns false when the text never made it into the document, so the caller
   * can skip an upload whose result would have nowhere to land.
   */
  insertTemporaryText(editor: Editor, pasteId: string): boolean {
    const progressText = imageAutoUploadPlugin.progressTextFor(pasteId);

    // No trailing newline: inside a table row it splits the row in two, and
    // Obsidian's table editor then rewrites the whole table — padding header and
    // every row out to the widest one, which permanently adds a column. The
    // line break for normal paragraphs is added when the image replaces this.
    try {
      editor.replaceSelection(progressText);
    } catch (e) {
      console.error("Could not insert the upload placeholder: ", e);
      return false;
    }

    // Deliberately not verified here. Inside a table cell the text does not land in
    // this document at all: Obsidian's cell editor filters the change out and
    // re-dispatches it into the cell's own editor a task later, so reading the
    // document now always says "missing" and any second write we made on that belief
    // was a duplicate — and the one that produced the "change set … wrong length"
    // crashes. If it really never lands, the upload still has somewhere to go, since
    // embedMarkDownImage falls back to the cursor.
    return true;
  }

  /**
   * Plain text, not image markdown: `![...]()` has no src to render, so Live
   * Preview and table cells both fall back to showing the raw syntax.
   */
  private static progressTextFor(id: string) {
    return `Uploading image... (${id})`;
  }

  embedMarkDownImage(
    editor: Editor,
    pasteId: string,
    imageUrl: any,
    name: string = "",
    size: ImageSize | null = null
  ) {
    let progressText = imageAutoUploadPlugin.progressTextFor(pasteId);
    const at = imageAutoUploadPlugin.findText(editor, progressText);
    if (at === null) {
      this.embedAtCursor(editor, imageUrl, name, size);
      return;
    }

    this.replaceText(
      editor,
      progressText,
      this.imageMarkdown(editor.getLine(at.line), at.ch, progressText, {
        imageUrl,
        name,
        size,
      })
    );
  }

  /**
   * The placeholder is gone — the paste was undone, the note was closed, or the
   * insert got rolled back. An upload that already finished shouldn't be thrown
   * away, so place the image at the cursor while the note is still in front.
   */
  private embedAtCursor(
    editor: Editor,
    imageUrl: any,
    name: string,
    size: ImageSize | null
  ) {
    if (this.helper.getEditor() !== editor) {
      new Notice(`${t("Uploaded, but the note is gone")}: ${imageUrl}`);
      console.warn("Uploaded image had nowhere to go: ", imageUrl);
      return;
    }

    const cursor = editor.getCursor("to");
    editor.replaceSelection(
      this.imageMarkdown(editor.getLine(cursor.line), cursor.ch, "", {
        imageUrl,
        name,
        size,
      })
    );
  }

  /**
   * In a table row the size-suffix pipe would be read as a cell separator, and a
   * newline would split the row, so images in one cell are joined with `<br>`.
   * Everywhere else each image still gets its own line.
   *
   * `placeholder` is the text about to be replaced at `ch`, excluded from the
   * table check because it may itself carry a pipe.
   */
  private imageMarkdown(
    line: string,
    ch: number,
    placeholder: string,
    image: { imageUrl: any; name: string; size: ImageSize | null }
  ) {
    const name = this.handleName(image.name, image.size);

    return this.lineIsTableRow(line, placeholder)
      ? `${imageAutoUploadPlugin.cellSeparator(line, ch)}![${this.escapeAltPipes(name)}](${image.imageUrl})`
      : `![${name}](${image.imageUrl})\n`;
  }

  /** `<br>` when the table cell already holds content right before `ch`. */
  private static cellSeparator(line: string, ch: number): string {
    const cellStart = line.lastIndexOf("|", Math.max(ch - 1, 0)) + 1;
    const before = line.slice(cellStart, ch).trim();
    return before === "" || before.endsWith("<br>") ? "" : "<br>";
  }

  /**
   * Escape literal pipes (leaving any already escaped) so image markdown is safe
   * inside a table cell: `![|500](url)` -> `![\|500](url)`.
   */
  escapeAltPipes(alt: string): string {
    return alt.replace(/(?<!\\)\|/g, "\\|");
  }

  /**
   * Whether `line` is a Markdown table row. The image markdown itself carries a
   * pipe (its size suffix), so strip that occurrence first; a remaining pipe
   * means real cell separators are present.
   */
  lineIsTableRow(line: string, imageMarkup: string): boolean {
    const rest = imageMarkup ? line.replace(imageMarkup, "") : line;
    return rest.includes("|");
  }

  /**
   * Position of the first occurrence of `target`, or null.
   *
   * The placeholder is located by text, never by a position remembered from
   * before the upload: while the request is in flight Obsidian's table editor can
   * re-serialize the table under us, which invalidates any stored coordinate.
   */
  static findText(editor: Editor, target: string): EditorPosition | null {
    const lines = editor.getValue().split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ch = lines[i]!.indexOf(target);
      if (ch !== -1) return { line: i, ch };
    }
    return null;
  }

  handleFailedUpload(editor: Editor, pasteId: string, reason: any) {
    new Notice(reason?.message ?? String(reason));
    console.error("Failed request: ", reason);
    let progressText = imageAutoUploadPlugin.progressTextFor(pasteId);
    this.replaceText(editor, progressText, "⚠️upload failed, check dev console");
  }

  handleName(name: string, size: ImageSize | null = null) {
    const imageSizeSuffix = this.sizeSuffix(size);

    if (this.settings.imageDesc === "origin") {
      return `${name}${imageSizeSuffix}`;
    } else if (this.settings.imageDesc === "none") {
      return "";
    } else if (this.settings.imageDesc === "removeDefault") {
      if (name === "image.png") {
        return imageSizeSuffix;
      } else {
        return `${name}${imageSizeSuffix}`;
      }
    } else {
      return `${name}${imageSizeSuffix}`;
    }
  }

  /**
   * The `|500` from settings, upgraded to `|500x281` once the image's own pixel size is
   * known.
   *
   * Width alone leaves the height unknown until the upload has been downloaded again, so
   * the image occupies no vertical space and then suddenly takes hundreds of pixels,
   * shoving everything below it — the scroll jump after a paste, and inside a table it
   * takes the whole block with it. Obsidian parses a `<w>x<h>` suffix into real `width`
   * and `height` attributes, so the box is reserved from the first paint.
   *
   * Only a plain `|<number>` is upgraded: anything else the user has configured is theirs,
   * and with no suffix at all the image is meant to render at its natural size.
   */
  private sizeSuffix(size: ImageSize | null): string {
    const suffix = this.settings.imageSizeSuffix || "";
    if (!size) return suffix;
    const width = suffix.match(/^\|(\d+)$/)?.[1];
    if (!width) return suffix;

    const height = Math.round((Number(width) * size.height) / size.width);
    return height > 0 ? `|${width}x${height}` : suffix;
  }

  /**
   * Swap the first occurrence of `target` for `replacement`.
   *
   * One write, then — if the text is still there a moment later — one more, through the
   * escape hatch below. Never two in the same tick: a write inside a table cell is not
   * applied to this document at all. Obsidian's cell editor filters it out, rewrites it
   * into cell-relative coordinates against the cell's text *as it is now*, and dispatches
   * it into the cell's own editor from a `setTimeout`. Checking immediately therefore
   * always reads "not replaced", and writing again on that belief queues a second
   * translated change set that no longer matches the cell — which is the
   * "Applying change set to a document with the wrong length" crash, thrown from inside
   * Obsidian's own timeout where nothing can catch it.
   */
  private replaceText(editor: Editor, target: string, replacement: string) {
    const at = imageAutoUploadPlugin.findText(editor, target);
    if (at === null) return false;

    try {
      editor.replaceRange(replacement, at, {
        line: at.line,
        ch: at.ch + target.length,
      });
    } catch (e) {
      console.error("Could not replace the upload placeholder: ", e);
    }

    // Long enough for the cell editor's own dispatch to have run.
    window.setTimeout(() => {
      const from = editor.getValue().indexOf(target);
      if (from === -1) return; // it landed
      this.dispatchEdit(editor, from, from + target.length, replacement);
    }, RETRY_DELAY);

    return true;
  }

  /**
   * Apply one change through the editor's own CodeMirror view, marked as a `set` user
   * event.
   *
   * That marking is the point: Obsidian's table-cell change filter passes a `set`
   * straight through (tearing its cell editor down first), so the change lands in this
   * document synchronously instead of being translated and re-dispatched into a cell
   * editor a task later. It is still a single-range change, so unlike replacing the
   * whole document — which is what this used to fall back to — the view keeps its scroll
   * position and its undo history.
   *
   * Offsets are plain document offsets, which is exactly what `indexOf` on the editor's
   * value returns.
   */
  private dispatchEdit(
    editor: Editor,
    from: number,
    to: number,
    insert: string
  ): boolean {
    const cm = (editor as unknown as { cm?: { dispatch(spec: unknown): void } }).cm;
    if (!cm) return false;
    try {
      cm.dispatch({
        changes: { from, to, insert },
        userEvent: "set",
        scrollIntoView: false,
      });
    } catch (e) {
      console.error("Could not write to the editor: ", e);
      return false;
    }
    return true;
  }
}
