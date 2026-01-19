# Copy Path

A simple Obsidian plugin that copies the absolute path of the current file with optional header anchor using a keyboard shortcut.

## Features

- **Quick Copy**: Copy absolute path with a single keyboard shortcut
- **Quoted Paths**: Automatically wraps paths in double quotes for easy use in terminals
- **Header Anchors**: If your cursor is on a heading, the path includes the header anchor
- **Cross-Platform**: Works on Windows, macOS, and Linux

## Usage

### Keyboard Shortcut

- **macOS**: `Cmd + Option + C`
- **Windows/Linux**: `Ctrl + Alt + C`

### Examples

When you press the keyboard shortcut:

**On a regular line:**
```
"/Users/username/Documents/MyVault/notes/project.md"
```

**On a heading:**
```
"/Users/username/Documents/MyVault/notes/project.md#Project-Overview"
```

The path is automatically copied to your clipboard and a notification appears.

## Use Cases

- Quickly reference files in terminal commands
- Share exact file locations with collaborators
- Create file references for external tools
- Link directly to specific sections in files

## Installation

### From Obsidian Community Plugins

1. Open **Settings** in Obsidian
2. Go to **Community Plugins** and disable Safe Mode
3. Click **Browse** and search for "Copy Path"
4. Click **Install**, then **Enable**

### Manual Installation

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/YOUR-USERNAME/obsidian-copy-path/releases)
2. Create a folder in your vault: `.obsidian/plugins/copy-path/`
3. Copy the downloaded files into this folder
4. Reload Obsidian
5. Go to **Settings → Community Plugins** and enable "Copy Path"

## Compatibility

- **Desktop**: Windows, macOS, Linux ✅
- **Mobile**: iOS, Android ✅
- **Minimum Obsidian version**: 0.15.0

## Development

```bash
# Install dependencies
npm install

# Start development build (watch mode)
npm run dev

# Create production build
npm run build
```

## License

ISC License

Copyright (C) 2020-2026 by Dynalist Inc.
