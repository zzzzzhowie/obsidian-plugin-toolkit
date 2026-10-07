import { Editor } from "obsidian";
import { IMAGE_URL_REGEX, MARKDOWN_LINK_REGEX, URL_REGEX } from "./patterns";

export class CheckIf {
  public static isMarkdownLinkAlready(editor: Editor): boolean {
    let cursor = editor.getCursor();

    // Check if the characters before the url are ]( to indicate a markdown link
    var titleEnd = editor.getRange(
      { ch: cursor.ch - 2, line: cursor.line },
      { ch: cursor.ch, line: cursor.line }
    );

    return titleEnd == "]("
  }

  public static isAfterQuote(editor: Editor): boolean {
    let cursor = editor.getCursor();

    // Check if the characters before the url are " or ' to indicate we want the url directly
    // This is common in elements like <a href="linkhere"></a>
    var beforeChar = editor.getRange(
      { ch: cursor.ch - 1, line: cursor.line },
      { ch: cursor.ch, line: cursor.line }
    );

    return beforeChar == "\"" || beforeChar == "'"
  }

  public static isUrl(text: string): boolean {
    let urlRegex = new RegExp(URL_REGEX);
    return urlRegex.test(text);
  }

  public static isImage(text: string): boolean {
    let imageRegex = new RegExp(IMAGE_URL_REGEX);
    return imageRegex.test(text);
  }

  public static isLinkedUrl(text: string): boolean {
    let urlRegex = new RegExp(MARKDOWN_LINK_REGEX);
    return urlRegex.test(text);
  }
}
