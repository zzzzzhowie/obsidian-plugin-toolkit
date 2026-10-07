import { join } from "path-browserify";

import { getLastImage } from "../utils";
import { normalizePath, FileSystemAdapter } from "obsidian";

import type imageAutoUploadPlugin from "../main";
import type { Image } from "../types";
import type { PluginSettings } from "../setting";
import type { Uploader } from "./types";

export default class PicGoCoreUploader implements Uploader {
  settings: PluginSettings;
  plugin: imageAutoUploadPlugin;

  constructor(plugin: imageAutoUploadPlugin) {
    this.settings = plugin.settings;
    this.plugin = plugin;
  }

  private async uploadFiles(fileList: Array<Image> | Array<string>) {
    const basePath = (
      this.plugin.app.vault.adapter as FileSystemAdapter
    ).getBasePath();

    const list = fileList.map(item => {
      if (typeof item === "string") {
        return item;
      } else {
        return normalizePath(join(basePath, item.path));
      }
    });

    const length = list.length;
    const res = await this.run(["upload", ...list]);
    const splitList = res.split("\n");
    const splitListLength = splitList.length;

    const data = splitList.splice(splitListLength - 1 - length, length);

    if (res.includes("PicGo ERROR")) {
      console.error("PicGo-Core upload failed", res);

      return {
        success: false,
        msg: "失败",
        result: [] as string[],
      };
    } else {
      return {
        success: true,
        result: data,
      };
    }
  }

  // PicGo-Core 上传处理
  private async uploadFileByClipboard() {
    const res = await this.run(["upload"]);
    const splitList = res.split("\n");
    const lastImage = getLastImage(splitList);

    if (lastImage) {
      return {
        success: true,
        msg: "success",
        result: [lastImage],
      };
    } else {
      return {
        success: false,
        msg: `"Please check PicGo-Core config"\n${res}`,
        result: [],
      };
    }
  }

  /**
   * Run PicGo-Core and collect what it printed. The CLI and its arguments are passed as
   * an argument list, never through a shell: file paths used to be pasted into a shell
   * command inside double quotes, where `$(…)` and backticks still run, so an image named
   * after a command ran that command on upload. A stuck CLI gives up after two minutes
   * instead of leaving "Uploading…" in the note for good.
   */
  private run(args: string[]): Promise<string> {
    const { execFile } = require("child_process") as typeof import("child_process");
    const cli = this.settings.picgoCorePath || "picgo";
    return new Promise((resolve) => {
      execFile(cli, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        // PicGo reports its own failures on stdout ("PicGo ERROR"), which callers look for;
        // a failure to run at all is passed on the same way.
        resolve(error ? `${stdout}\nPicGo ERROR: ${stderr || error.message}` : stdout);
      });
    });
  }

  async upload(fileList: Array<Image> | Array<string>) {
    return this.uploadFiles(fileList);
  }
  async uploadByClipboard(_fileList?: FileList) {
    return this.uploadFileByClipboard();
  }
}
