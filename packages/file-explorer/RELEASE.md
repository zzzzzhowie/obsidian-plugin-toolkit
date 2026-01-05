# Release Checklist

## ✅ Completed Preparations

- [x] Removed all console.log debug code
- [x] Removed test data files (data.json)
- [x] Created .gitignore file
- [x] Verified versions.json file
- [x] Updated README.md
- [x] Final build test passed

## 📝 Steps You Need to Complete Manually

### 1. Update Author Information in manifest.json

Open `manifest.json` and modify the following fields:

```json
{
  "author": "Your Name",
  "authorUrl": "https://github.com/your-username",
  "fundingUrl": "Your sponsorship link (optional, can be removed if not needed)"
}
```

### 2. Create GitHub Repository

1. Visit https://github.com/new
2. Repository name suggestion: `obsidian-pinned-items`
3. Set to Public
4. Don't initialize README (we already have one)

### 3. Push Code to GitHub

```bash
cd "/path/to/your/plugin/directory"

# Initialize git
git init
git add .
git commit -m "Initial commit: Pinned Items Plugin v1.0.0"

# Connect to your GitHub repository (replace with your username)
git remote add origin https://github.com/your-username/obsidian-pinned-items.git
git branch -M main
git push -u origin main
```

### 4. Create GitHub Release

1. On the GitHub repository page, click **"Releases"** → **"Create a new release"**
2. **Tag version**: Enter `1.0.0` (Note: Don't add v prefix!)
3. **Release title**: `1.0.0`
4. **Description**: Copy the following content

```markdown
# Pinned Items Plugin v1.0.0

First release! A simple yet powerful plugin that lets you pin important files and folders to the top of your file explorer.

## ✨ Features

- 📌 Right-click menu to pin/unpin files and folders
- ⚡ Quick access to frequently used files
- 🎯 Support for iOS and Android tap operations
- 🎨 Clean and compact interface design
- 💾 Automatically save pinned state
- 🔄 Easily manage pinned items

## 🎯 Usage

1. Right-click any file or folder in the file explorer
2. Select "📌 Pin to top"
3. Pinned items will appear at the top of the file explorer

## 📱 Cross-platform Support

- Windows, macOS, Linux
- iOS, Android
```

5. **Upload assets**: Drag and drop the following 3 files
   - `main.js`
   - `manifest.json`
   - `styles.css`

6. Click **"Publish release"**

### 5. (Optional) Submit to Obsidian Community Plugins

If you want your plugin to appear in Obsidian's community plugin list:

1. Fork this repository: https://github.com/obsidianmd/obsidian-releases
2. Edit `community-plugins.json`, add at the end:

```json
{
  "id": "pinned-items-plugin",
  "name": "Pinned Items",
  "author": "Your Name",
  "description": "Pin files and folders to the top of your file explorer for quick access.",
  "repo": "your-username/obsidian-pinned-items"
}
```

3. Create Pull Request
4. Wait for Obsidian team review (usually takes a few days to weeks)

## 📦 Release File Checklist

Make sure the following files are in the release:

- [x] `main.js` (build output)
- [x] `manifest.json` 
- [x] `styles.css`
- [x] `README.md` (in repository)
- [x] `versions.json` (in repository)
- [x] `LICENSE` (recommended to add if not already present)

## 🎉 Done!

After completing the above steps, your plugin is officially released!

Users can install it in the following ways:
1. Manually download from your GitHub Release page
2. If submitted to community, install from Obsidian's community plugin list

## 📊 Future Maintenance

When you need to release a new version:

1. Update code
2. Modify `version` in `manifest.json`
3. Update `versions.json` to add new version
4. Run `npm run build`
5. Create new GitHub Release
6. Upload new `main.js`, `manifest.json`, `styles.css`
