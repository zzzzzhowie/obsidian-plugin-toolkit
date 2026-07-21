import { Editor, EditorPosition } from "obsidian";
import { DEFAULT_SETTINGS } from "./settings";

interface WordBoundaries {
  start: { line: number; ch: number };
  end: { line: number; ch: number };
}

export class EditorExtensions {
  public static getSelectedText(editor: Editor): string {
    if (!editor.somethingSelected()) {
      let wordBoundaries = this.getWordBoundaries(editor);
      editor.setSelection(wordBoundaries.start, wordBoundaries.end);
    }
    return editor.getSelection();
  }

  private static cursorWithinBoundaries(
    cursor: EditorPosition,
    match: RegExpMatchArray
  ): boolean {
    let startIndex = match.index ?? 0;
    let endIndex = startIndex + (match[0]?.length ?? 0);

    return startIndex <= cursor.ch && cursor.ch <= endIndex;
  }

  private static getWordBoundaries(editor: Editor): WordBoundaries {
    let cursor = editor.getCursor();

    // If its a normal URL token this is not a markdown link
    // In this case we can simply overwrite the link boundaries as-is
    let lineText = editor.getLine(cursor.line);

    // First check if we're in a link
    let linksInLine = lineText.matchAll(DEFAULT_SETTINGS.linkLineRegex);

    for (let match of linksInLine) {
      if (this.cursorWithinBoundaries(cursor, match)) {
        const index = match.index ?? 0;
        return {
          start: { line: cursor.line, ch: index },
          end: { line: cursor.line, ch: index + (match[0]?.length ?? 0) },
        };
      }
    }

    // If not, check if we're in just a standard ol' URL.
    let urlsInLine = lineText.matchAll(DEFAULT_SETTINGS.lineRegex);

    for (let match of urlsInLine) {
      if (this.cursorWithinBoundaries(cursor, match)) {
        const index = match.index ?? 0;
        return {
          start: { line: cursor.line, ch: index },
          end: { line: cursor.line, ch: index + (match[0]?.length ?? 0) },
        };
      }
    }

    return {
      start: cursor,
      end: cursor,
    };
  }

  public static getEditorPositionFromIndex(
    content: string,
    index: number
  ): EditorPosition {
    let substr = content.slice(0, index);

    let l = 0;
    let offset = -1;
    let r = -1;
    for (; (r = substr.indexOf("\n", r + 1)) !== -1; l++, offset = r);
    offset += 1;

    let ch = content.slice(offset, index).length;

    return { line: l, ch: ch };
  }
}
