# File Explorer Enhancements

Enhanced file explorer for Obsidian with three powerful features: pinned items, folder notes, and file count display.

## Features

### 📌 Pinned Items
Pin your most frequently used files and folders to the top of the file explorer for instant access.

- Right-click any file or folder and select "📌 Pin to top"
- Pinned items appear at the top of your file explorer
- Unpin with a single click on the × button
- Persistent across Obsidian restarts

### 📝 Folder Notes
Automatically recognize and integrate folder notes into your workflow.

- Create a markdown file with the same name as a folder (e.g., `Projects/Projects.md`)
- The folder name will be underlined to indicate it has a folder note
- Click the folder name to open the folder note
- The folder note file is automatically hidden from the file list
- Right-click folders to create or open folder notes

### 🔢 File Count Display
See the number of files in each folder at a glance.

- Shows total file count including all subfolders
- Compact badge display on the right side
- Updates automatically as you add, move, or delete files
- Can be toggled on/off in settings

## How to Use

### Pinning Items

1. **Right-click** on any file or folder in the file explorer
2. Select **"📌 Pin to top"** from the context menu
3. The item appears immediately at the top

**To unpin:**
- Click the **×** button on the pinned item, or
- Right-click and select **"📌 Unpin"**

### Folder Notes

**To create a folder note:**
1. Create a markdown file with the same name as the folder
   - Example: For folder `Projects`, create `Projects/Projects.md`
2. The folder name will automatically be underlined
3. Click the folder name to open the note

**To use:**
- **Click folder name** → Opens the folder note
- **Click elsewhere on folder row** → Expands/collapses the folder
- **Right-click folder** → Context menu with "Create/Open folder note" option

### File Count

- Automatically displayed on the right side of each folder
- Shows total number of files (including subfolders)
- Can be toggled in Settings → File Explorer Enhancements

## Settings

Open **Settings → File Explorer Enhancements** to:

- **Show folder notes**: Toggle folder note detection and display
- **Show file count**: Toggle file count badges
- **Manage pinned items**: View and remove pinned items

## Installation

### From Obsidian Community Plugins

1. Open **Settings** in Obsidian
2. Go to **Community Plugins** and disable Safe Mode
3. Click **Browse** and search for "File Explorer Enhancements"
4. Click **Install**, then **Enable**

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/YOUR-USERNAME/obsidian-file-explorer-enhancements/releases)
2. Create a folder in your vault: `.obsidian/plugins/file-explorer-enhancements/`
3. Copy the downloaded files into this folder
4. Reload Obsidian
5. Go to **Settings → Community Plugins** and enable "File Explorer Enhancements"

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

## Known Issues

- Folder notes require the markdown file to have exactly the same name as the folder
- File count may take a moment to appear on first load or after sidebar toggle

## Roadmap

- [ ] Customizable folder note file names
- [ ] Option to show only direct file count (exclude subfolders)
- [ ] Drag and drop to reorder pinned items
- [ ] Folder note templates

## Support

If you encounter any issues or have feature requests, please [open an issue](https://github.com/YOUR-USERNAME/obsidian-file-explorer-enhancements/issues) on GitHub.

## License

MIT

## Credits

Created for the Obsidian community
