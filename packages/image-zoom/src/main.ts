import { Plugin } from "obsidian";

export default class ImageZoomPlugin extends Plugin {
  private zoomOverlay: HTMLElement | null = null;
  private currentImage: HTMLImageElement | null = null;
  private scale = 1;
  private isDragging = false;
  private startX = 0;
  private startY = 0;
  private translateX = 0;
  private translateY = 0;
  private imageList: HTMLImageElement[] = [];
  private currentIndex = 0;
  private toolbar: HTMLElement | null = null;

  async onload() {
    // Create zoom overlay container
    this.createZoomOverlay();

    // Register click handler for images and SVGs
    this.registerDomEvent(document, "click", (event: MouseEvent) => {
      const target = event.target as HTMLElement;

      // Only trigger zoom if Cmd (Mac) or Ctrl (Windows/Linux) is pressed
      if (!event.metaKey && !event.ctrlKey) {
        return;
      }

      // Check for IMG elements
      if (target.tagName === "IMG") {
        // Check if it's an Excalidraw image
        const isExcalidraw =
          target.classList.contains("excalidraw-svg") ||
          target.classList.contains("excalidraw-embedded-img");

        if (isExcalidraw) {
          this.showZoomedImage(target as HTMLImageElement);
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        // For regular images, check parent container
        const parent = target.closest(
          '.workspace-leaf-content[data-type="markdown"], .workspace-leaf-content[data-type="image"]',
        );
        if (parent) {
          this.showZoomedImage(target as HTMLImageElement);
          event.preventDefault();
          event.stopPropagation();
        }
      }

      // Check for SVG elements (Mermaid diagrams)
      const svgElement = target.closest("svg");
      if (svgElement) {
        const mermaidContainer = svgElement.closest(".mermaid");
        if (mermaidContainer) {
          const parent = mermaidContainer.closest(
            '.workspace-leaf-content[data-type="markdown"]',
          );
          if (parent) {
            this.showZoomedSVG(svgElement as SVGElement);
            event.preventDefault();
            event.stopPropagation();
          }
        }
      }
    });

    // Handle cursor change on hover when Cmd is pressed
    this.registerDomEvent(document, "mousemove", (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const isCmdPressed = event.metaKey || event.ctrlKey;

      // Check if hovering over an image
      if (target.tagName === "IMG") {
        // Check if it's an Excalidraw image
        const isExcalidraw =
          target.classList.contains("excalidraw-svg") ||
          target.classList.contains("excalidraw-embedded-img");

        if (isExcalidraw) {
          (target as HTMLElement).style.cursor = isCmdPressed ? "zoom-in" : "";
        } else {
          // For regular images, check parent container
          const parent = target.closest(
            '.workspace-leaf-content[data-type="markdown"], .workspace-leaf-content[data-type="image"]',
          );
          if (parent) {
            (target as HTMLElement).style.cursor = isCmdPressed
              ? "zoom-in"
              : "";
          }
        }
      }

      // Check if hovering over SVG
      const svgElement = target.closest("svg");
      if (svgElement && svgElement instanceof SVGElement) {
        const mermaidContainer = svgElement.closest(".mermaid");
        if (mermaidContainer) {
          if (isCmdPressed) {
            svgElement.style.cursor = "zoom-in";
          } else {
            svgElement.style.cursor = "";
          }
        }
      }
    });
  }

  onunload() {
    if (this.zoomOverlay) {
      this.zoomOverlay.remove();
      this.zoomOverlay = null;
    }
  }

  private createZoomOverlay() {
    this.zoomOverlay = document.body.createDiv("image-zoom-overlay");
    this.zoomOverlay.style.display = "none";

    // Close on overlay click (not on children)
    this.zoomOverlay.addEventListener("click", (e) => {
      if (e.target === this.zoomOverlay) {
        this.closeZoom();
      }
    });

    // Prevent click-through by stopping propagation
    this.zoomOverlay.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });

    // Add keyboard handler for ESC key only
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.zoomOverlay?.style.display === "flex") {
        this.closeZoom();
      }
    });
  }

  private showZoomedImage(img: HTMLImageElement) {
    if (!this.zoomOverlay) return;

    // Reset state
    this.translateX = 0;
    this.translateY = 0;

    // Clear previous content
    this.zoomOverlay.empty();

    // Create image container
    const container = this.zoomOverlay.createDiv("image-zoom-container");

    // For Excalidraw images (blob URLs), clone the original element to preserve the blob reference
    const isExcalidraw =
      img.classList.contains("excalidraw-svg") ||
      img.classList.contains("excalidraw-embedded-img");

    if (isExcalidraw) {
      this.currentImage = img.cloneNode(true) as HTMLImageElement;

      // For Excalidraw blob images, we need to set explicit dimensions
      // Use the natural dimensions of the original image
      const naturalWidth = img.naturalWidth || img.width;
      const naturalHeight = img.naturalHeight || img.height;

      // Calculate initial scale to ensure image is visible
      // Target: fill at least 60% of viewport width or height
      const viewportWidth = window.innerWidth * 0.9; // 90vw
      const viewportHeight = window.innerHeight * 0.9; // 90vh
      const targetSize = 0.6; // Target 60% of viewport

      const scaleByWidth = (viewportWidth * targetSize) / naturalWidth;
      const scaleByHeight = (viewportHeight * targetSize) / naturalHeight;

      // Use the smaller scale to ensure image fits
      // Allow upscaling for small images, but cap at 10x (1000%) maximum zoom
      const initialScale = Math.min(10, Math.max(scaleByWidth, scaleByHeight));
      this.scale = initialScale;

      // Reset styles that might interfere with zoom display
      this.currentImage.style.maxWidth = "90vw";
      this.currentImage.style.maxHeight = "90vh";
      this.currentImage.style.width = `${naturalWidth}px`;
      this.currentImage.style.height = `${naturalHeight}px`;
      this.currentImage.style.objectFit = "contain";

      container.appendChild(this.currentImage);
    } else {
      // For regular images, use default 1x scale
      this.scale = 1;
      // For regular images, create a new element
      this.currentImage = container.createEl("img", {
        attr: {
          src: img.src,
          alt: img.alt || "",
        },
      });
    }

    this.setupZoomAndDrag(container);

    // Create toolbar
    this.createToolbar();

    // Show overlay
    this.zoomOverlay.style.display = "flex";
  }

  private setupZoomAndDrag(container: HTMLElement) {
    this.updateImageTransform();

    // Add trackpad gesture support
    container.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();

      // ctrlKey indicates pinch-to-zoom gesture on trackpad
      const isPinch = e.ctrlKey;

      if (isPinch) {
        // Pinch gesture: zoom in/out
        const delta = e.deltaY > 0 ? 0.98 : 1.02;
        this.scale *= delta;
        this.scale = Math.max(0.5, Math.min(this.scale, 10));
        this.updateImageTransform(true); // Disable transition for smooth pinch
        this.updateToolbar();
      } else {
        // Two-finger scroll: pan the image
        // Increase sensitivity for smoother panning (1.5x speed)
        this.translateX -= e.deltaX * 1.5;
        this.translateY -= e.deltaY * 1.5;
        this.updateImageTransform(true); // Pass true to disable transition
      }
    });

    // Add drag support with proper event cleanup
    let mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
    let mouseUpHandler: (() => void) | null = null;

    const startDrag = (e: MouseEvent) => {
      e.preventDefault();
      this.isDragging = true;
      this.startX = e.clientX - this.translateX;
      this.startY = e.clientY - this.translateY;
      container.style.cursor = "grabbing";

      // Create and bind move handler
      mouseMoveHandler = (e: MouseEvent) => {
        if (!this.isDragging) {
          return;
        }
        this.translateX = e.clientX - this.startX;
        this.translateY = e.clientY - this.startY;
        this.updateImageTransform();
      };

      // Create and bind up handler
      mouseUpHandler = () => {
        this.isDragging = false;
        container.style.cursor = "grab";

        // Clean up event listeners
        if (mouseMoveHandler) {
          document.removeEventListener("mousemove", mouseMoveHandler);
          mouseMoveHandler = null;
        }
        if (mouseUpHandler) {
          document.removeEventListener("mouseup", mouseUpHandler);
          mouseUpHandler = null;
        }
      };

      // Bind listeners immediately
      document.addEventListener("mousemove", mouseMoveHandler);
      document.addEventListener("mouseup", mouseUpHandler);
    };

    container.addEventListener("mousedown", startDrag);
    container.style.cursor = "grab";
  }

  private createToolbar() {
    this.toolbar = this.zoomOverlay!.createDiv("image-zoom-toolbar");

    // Zoom out button
    const zoomOutBtn = this.toolbar.createEl("button");
    zoomOutBtn.textContent = "−";
    zoomOutBtn.addEventListener("click", () => this.zoomBy(0.9));

    // Zoom info
    const zoomInfo = this.toolbar.createEl("span");
    zoomInfo.className = "zoom-info";
    zoomInfo.textContent = "100%";

    // Zoom in button
    const zoomInBtn = this.toolbar.createEl("button");
    zoomInBtn.textContent = "+";
    zoomInBtn.addEventListener("click", () => this.zoomBy(1.1));

    this.updateToolbar();
  }

  private updateToolbar() {
    if (!this.toolbar) return;

    const zoomInfo = this.toolbar.querySelector(".zoom-info");
    if (zoomInfo) {
      zoomInfo.textContent = `${Math.round(this.scale * 100)}%`;
    }
  }

  private zoomBy(factor: number) {
    this.scale *= factor;
    this.scale = Math.max(0.5, Math.min(this.scale, 10));
    this.updateImageTransform();
    this.updateToolbar();
  }

  private updateImageTransform(disableTransition = false) {
    if (this.currentImage) {
      // Disable transition during trackpad pan for smoother experience
      if (disableTransition) {
        this.currentImage.style.transition = "none";
      } else {
        this.currentImage.style.transition = "";
      }
      this.currentImage.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
    }
  }

  private closeZoom() {
    if (this.zoomOverlay) {
      this.zoomOverlay.style.display = "none";
      this.zoomOverlay.empty();
      this.currentImage = null;
      this.isDragging = false;
      this.toolbar = null;
    }
  }

  private showZoomedSVG(svg: SVGElement) {
    if (!this.zoomOverlay) return;

    // Reset state
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;

    // Clear previous content
    this.zoomOverlay.empty();

    // Create container
    const container = this.zoomOverlay.createDiv("image-zoom-container");

    // Clone the SVG to avoid modifying the original
    const svgClone = svg.cloneNode(true) as SVGElement;

    // Set SVG to fill container while maintaining aspect ratio
    svgClone.style.maxWidth = "100%";
    svgClone.style.maxHeight = "100%";
    svgClone.style.width = "auto";
    svgClone.style.height = "auto";

    container.appendChild(svgClone);
    this.currentImage = svgClone as any; // Reuse the same transform logic

    this.setupZoomAndDrag(container);

    // Create toolbar (without navigation for SVG)
    this.createToolbar();

    // Show overlay
    this.zoomOverlay.style.display = "flex";
  }
}
