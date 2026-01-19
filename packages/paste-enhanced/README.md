# Paste Enhanced

An intelligent paste plugin for Obsidian that automatically detects your cursor context and formats pasted content accordingly.

## Features

- **Context-Aware Pasting**: Automatically detects whether you're in a code block or normal text
- **HTML to Markdown Conversion**: Converts rich HTML content (from browsers, documents) to clean Markdown
- **Code Block Preservation**: Preserves exact formatting when pasting into code blocks (indentation, line breaks)
- **GFM Support**: Supports GitHub Flavored Markdown including tables, task lists, and strikethrough
- **Auto-Link Plugin Compatible**: Works seamlessly with obsidian-auto-link-title plugin

## How It Works

### Pasting in Normal Text

When you paste HTML content (e.g., from a webpage):

**Original HTML:**
```html
<h2>Project Overview</h2>
<p>This is a <strong>demo</strong> project.</p>
<ul>
  <li>Feature A</li>
  <li>Feature B</li>
</ul>
```

**Converted to Markdown:**
```markdown
## Project Overview

This is a **demo** project.

- Feature A
- Feature B
```

### Pasting in Code Blocks

When your cursor is inside a code block, the plugin preserves the exact format:

- ✅ Indentation preserved
- ✅ Line breaks maintained
- ✅ No Markdown conversion

Perfect for pasting Python, JavaScript, or any indentation-sensitive code.

### Supported Conversions

- **Headings**: `<h1>` to `#`, `<h2>` to `##`, etc.
- **Lists**: Ordered and unordered lists
- **Tables**: HTML tables to Markdown tables (GFM)
- **Links**: `<a href="">` to `[text](url)`
- **Emphasis**: `<strong>` to `**bold**`, `<em>` to `*italic*`
- **Code**: `<code>` to `` `inline code` ``
- **Strikethrough**: `<del>` to `~~text~~` (GFM)
- **Task Lists**: `[ ]` and `[x]` checkboxes (GFM)

## Settings

Open **Settings → Paste Enhanced** to:

- **Enable/Disable**: Toggle the enhanced paste functionality on or off

## Installation

### From Obsidian Community Plugins

1. Open **Settings** in Obsidian
2. Go to **Community Plugins** and disable Safe Mode
3. Click **Browse** and search for "Paste Enhanced"
4. Click **Install**, then **Enable**

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` (if present) from the [latest release](https://github.com/YOUR-USERNAME/obsidian-paste-enhanced/releases)
2. Create a folder in your vault: `.obsidian/plugins/paste-enhanced/`
3. Copy the downloaded files into this folder
4. Reload Obsidian
5. Go to **Settings → Community Plugins** and enable "Paste Enhanced"

## Compatibility

- **Desktop**: Windows, macOS, Linux ✅
- **Mobile**: iOS, Android ✅
- **Minimum Obsidian version**: 0.15.0

## Known Limitations

- Plain URLs (without HTML) are left unchanged to allow other plugins like obsidian-auto-link-title to process them
- Markdown links in clipboard are not processed

## Development

```bash
# Install dependencies
npm install

# Start development build (watch mode)
npm run dev

# Create production build
npm run build
```

## Use Cases

- Copy content from websites and paste as clean Markdown
- Paste formatted documents from Google Docs or Word
- Preserve code formatting when sharing snippets
- Convert HTML emails to Markdown notes
- Copy tables from spreadsheets to Markdown format

## License

ISC License

Copyright (C) 2020-2026 by Dynalist Inc.
