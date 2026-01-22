# Image Zoom

A simple Obsidian plugin that allows you to click on images and Mermaid diagrams to view them in a zoomed overlay.

## Features

- **Cmd/Ctrl + Click to Zoom**: Hold Cmd (Mac) or Ctrl (Windows/Linux) and click any image or Mermaid diagram to view it in an enlarged overlay
- **Toolbar Controls**:
  - Zoom in/out buttons with visual percentage display
  - Navigate between images in the same document
  - Keyboard shortcuts: Arrow keys for navigation, +/- for zoom (coming soon)
- **Trackpad Pinch to Zoom**: Use two-finger pinch gesture on trackpad to zoom in and out
- **Mouse Wheel Zoom**: Use your mouse wheel to zoom in and out on the image
- **Drag to Pan**: Click and drag the zoomed image to pan around
- **Quick Exit**: Press `Esc` or click the background to close the zoom view

## Installation

### From Obsidian Community Plugins (Coming Soon)
1. Open Settings → Community Plugins
2. Turn off Safe mode
3. Click Browse and search for "Image Zoom"
4. Click Install
5. Enable the plugin

### Manual Installation
1. Download the latest release
2. Extract the files to your vault's plugins folder: `<vault>/.obsidian/plugins/image-zoom/`
3. Reload Obsidian
4. Enable the plugin in Settings → Community Plugins

## Usage

Hold **Cmd** (Mac) or **Ctrl** (Windows/Linux) and click any image or Mermaid diagram in your markdown files to zoom in. Once zoomed:
- **Toolbar**: Use the bottom toolbar for:
  - **−/+** buttons to zoom out/in
  - **←/→** buttons to navigate between images (if multiple images in document)
  - View current zoom percentage and image position
- **Pinch**: Use two-finger pinch gesture on trackpad to zoom
- **Scroll**: Zoom in/out with mouse wheel
- **Drag**: Click and drag to pan the image, or use two-finger scroll on trackpad
- **Keyboard**: 
  - Arrow Left/Right: Navigate between images
  - Esc: Close zoom view
- **Exit**: Press `Esc` or click the background

**Supports:**
- Regular images (PNG, JPG, GIF, etc.)
- SVG images
- Mermaid diagrams

## License

MIT
