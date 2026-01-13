# Image Converter

A minimal Obsidian plugin that allows you to drag-resize images in markdown files.

## Features

- **Drag Resize**: Resize images by dragging the edges
- **Scroll Wheel Resize**: Resize images using scroll wheel with modifier key
- **Non-destructive**: Changes are saved to markdown link parameters

## Installation

### From Obsidian Community Plugins

1. Open **Settings** in Obsidian
2. Go to **Community Plugins** and disable Safe Mode
3. Click **Browse** and search for "Image Converter"
4. Click **Install**, then **Enable**

### Manual Installation

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/YOUR-USERNAME/obsidian-image-converter/releases)
2. Create a folder in your vault: `.obsidian/plugins/image-converter/`
3. Copy the downloaded files into this folder
4. Reload Obsidian
5. Go to **Settings → Community Plugins** and enable "Image Converter"

## Usage

1. Open a markdown file with images
2. Hover over an image edge to see resize handles
3. Drag the handles to resize the image
4. Or hold Shift (or configured modifier) and scroll to resize

## Settings

Open **Settings → Image Converter** to configure:

- **Enable image drag resize**: Toggle the feature on/off
- **Scroll-wheel resize modifier**: Key to hold while scrolling (Shift, Control, Alt, Meta)
- **Scroll-wheel resize sensitivity**: How sensitive the scroll resize is

## Compatibility

- **Desktop**: Windows, macOS, Linux ✅
- **Mobile**: iOS, Android ✅
- **Minimum Obsidian version**: 0.15.0

## Development

```bash
# Install dependencies
pnpm install

# Start development build (watch mode)
pnpm dev

# Create production build
pnpm build
```

## License

MIT
