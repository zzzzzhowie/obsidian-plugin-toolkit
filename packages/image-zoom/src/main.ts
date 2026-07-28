import { Platform, Plugin } from "obsidian";

export default class ImageZoomPlugin extends Plugin {
  private get isMobile(): boolean {
    // Platform.isMobile is true only in the actual Obsidian mobile app; the old
    // touch heuristic also fired on touchscreen laptops and wrongly disabled the
    // desktop Cmd-click flow there.
    return Platform.isMobile;
  }
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
    // The zoom overlay is used on every platform now.
    this.createZoomOverlay();

    if (this.isMobile) {
      // Mobile: a plain tap opens our overlay in place of Obsidian's native
      // image viewer (see registerMobileZoom). Pinch/pan already work via the
      // touch handlers in setupZoomAndDrag.
      this.registerMobileZoom();
      return;
    }

    // Desktop: Cmd/Ctrl-click to zoom, plus a zoom-in cursor hint on hover.
    this.registerDesktopZoom();
    this.registerDesktopCursor();
  }

  /**
   * The element a click/tap over `target` should zoom, or null if none.
   * Handles Excalidraw images, regular embedded images (inside a markdown/image
   * leaf), and Mermaid SVGs — the shared rule for both platforms.
   */
  private zoomTargetFor(
    target: HTMLElement,
  ): HTMLImageElement | SVGElement | null {
    if (target.tagName === "IMG") {
      const isExcalidraw =
        target.classList.contains("excalidraw-svg") ||
        target.classList.contains("excalidraw-embedded-img");
      if (isExcalidraw) return target as HTMLImageElement;

      const parent = target.closest(
        '.workspace-leaf-content[data-type="markdown"], .workspace-leaf-content[data-type="image"]',
      );
      if (parent) return target as HTMLImageElement;
    }

    const svgElement = target.closest("svg");
    if (svgElement) {
      const mermaidContainer = svgElement.closest(".mermaid");
      if (mermaidContainer) {
        const parent = mermaidContainer.closest(
          '.workspace-leaf-content[data-type="markdown"]',
        );
        if (parent) return svgElement as SVGElement;
      }
    }

    return null;
  }

  private openZoom(el: HTMLImageElement | SVGElement) {
    if (el instanceof SVGElement) this.showZoomedSVG(el);
    else this.showZoomedImage(el);
  }

  private registerDesktopZoom() {
    this.registerDomEvent(document, "click", (event: MouseEvent) => {
      // Desktop: require Cmd (Mac) or Ctrl (Windows/Linux) to trigger zoom.
      if (!event.metaKey && !event.ctrlKey) return;
      const el = this.zoomTargetFor(event.target as HTMLElement);
      if (!el) return;
      this.openZoom(el);
      event.preventDefault();
      event.stopPropagation();
    });
  }

  private registerDesktopCursor() {
    // Show a zoom-in cursor while Cmd/Ctrl is held over a zoomable target.
    this.registerDomEvent(document, "mousemove", (event: MouseEvent) => {
      const el = this.zoomTargetFor(event.target as HTMLElement);
      if (!el) return;
      el.style.cursor = event.metaKey || event.ctrlKey ? "zoom-in" : "";
    });
  }

  private registerMobileZoom() {
    // Capture phase + stopImmediatePropagation: run before, and suppress,
    // Obsidian's built-in mobile image viewer so a tap opens our overlay
    // instead. Non-image taps fall through untouched.
    this.registerDomEvent(
      document,
      "click",
      (event: MouseEvent) => {
        const el = this.zoomTargetFor(event.target as HTMLElement);
        if (!el) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.openZoom(el);
      },
      { capture: true },
    );
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

    // Close on backdrop tap (mobile). The image container is flex:1/90vw and
    // fills most of the screen, so a tap in the black area around the image
    // lands on the container, not the overlay — checking only the overlay never
    // closed it. Treat a tap (negligible movement) on either the overlay or the
    // container's empty area as a backdrop tap. Movement means a pan/pinch on
    // the image, not a dismiss, so we skip those; taps on the image itself and
    // the toolbar are left to their own handlers.
    let tapX = 0;
    let tapY = 0;
    let tapMoved = false;
    this.zoomOverlay.addEventListener(
      "touchstart",
      (e) => {
        const t = e.touches[0];
        if (t) {
          tapX = t.clientX;
          tapY = t.clientY;
          tapMoved = false;
        }
      },
      { passive: true, capture: true },
    );
    this.zoomOverlay.addEventListener(
      "touchmove",
      (e) => {
        const t = e.touches[0];
        if (
          t &&
          (Math.abs(t.clientX - tapX) > 10 || Math.abs(t.clientY - tapY) > 10)
        ) {
          tapMoved = true;
        }
      },
      { passive: true, capture: true },
    );
    this.zoomOverlay.addEventListener(
      "touchend",
      (e) => {
        if (tapMoved) return;
        const target = e.target as HTMLElement;
        if (
          target === this.zoomOverlay ||
          target.classList.contains("image-zoom-container")
        ) {
          this.closeZoom();
        }
      },
      { capture: true },
    );

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

      // Calculate initial scale so the image fills 80% of the viewport
      // while still fitting entirely within it.
      const viewportWidth = window.innerWidth * 0.9; // 90vw
      const viewportHeight = window.innerHeight * 0.9; // 90vh

      // Scale to fit the viewport — use the smaller ratio so the whole image is visible
      const scaleByWidth = viewportWidth / naturalWidth;
      const scaleByHeight = viewportHeight / naturalHeight;
      const fitScale = Math.min(scaleByWidth, scaleByHeight);

      // Then scale up to ~80 % of the viewport if the image is very small
      // but never reduce below fitScale (never let it overflow)
      const expandedScale = Math.min(scaleByWidth, scaleByHeight) * 0.85;
      const initialScale = Math.max(fitScale, expandedScale);
      this.scale = initialScale;

      // Use the natural size as the CSS base size so transform: scale()
      // has a real reference point. maxWidth/maxHeight are handled by
      // the container CSS; don't let inline styles fight the transform.
      this.currentImage.style.width = `${naturalWidth}px`;
      this.currentImage.style.height = `${naturalHeight}px`;
      this.currentImage.style.maxWidth = "none";
      this.currentImage.style.maxHeight = "none";
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
        this.scale = Math.max(0.1, Math.min(this.scale, 50));
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

    // ── Touch support (mobile) ──────────────────────────────────────────────
    // Tracks the last distance between two fingers for pinch-to-zoom
    let lastTouchDist = 0;
    // Tracks the last single-finger position for drag-to-pan
    let lastTouchX = 0;
    let lastTouchY = 0;

    const getTouchDist = (touches: TouchList): number => {
      const t0 = touches[0];
      const t1 = touches[1];
      if (!t0 || !t1) return 0;
      const dx = t0.clientX - t1.clientX;
      const dy = t0.clientY - t1.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    container.addEventListener("touchstart", (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        // Pinch start — record initial distance
        lastTouchDist = getTouchDist(e.touches);
      } else if (e.touches.length === 1) {
        // Single-finger drag start
        const t0 = e.touches[0];
        if (t0) {
          lastTouchX = t0.clientX;
          lastTouchY = t0.clientY;
        }
      }
    }, { passive: false });

    container.addEventListener("touchmove", (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        // Pinch-to-zoom
        const newDist = getTouchDist(e.touches);
        if (lastTouchDist > 0) {
          const pinchRatio = newDist / lastTouchDist;
          this.scale *= pinchRatio;
          this.scale = Math.max(0.1, Math.min(this.scale, 50));
          this.updateImageTransform(true);
          this.updateToolbar();
        }
        lastTouchDist = newDist;
      } else if (e.touches.length === 1) {
        // Single-finger pan
        const t0 = e.touches[0];
        if (t0) {
          const dx = t0.clientX - lastTouchX;
          const dy = t0.clientY - lastTouchY;
          this.translateX += dx;
          this.translateY += dy;
          lastTouchX = t0.clientX;
          lastTouchY = t0.clientY;
          this.updateImageTransform(true);
        }
      }
    }, { passive: false });

    container.addEventListener("touchend", (e: TouchEvent) => {
      // When lifting fingers, reset distance tracker so the next
      // pinch starts cleanly (avoids a jump if one finger lifts first)
      if (e.touches.length < 2) {
        lastTouchDist = 0;
      }
      // Lifting one finger of a pinch leaves one finger down. The single-finger
      // pan reads lastTouchX/Y, which are stale from before the pinch, so its
      // first delta would be huge and jump the image. Re-anchor the pan origin
      // to the remaining finger so panning resumes from where it actually is.
      if (e.touches.length === 1) {
        const t0 = e.touches[0];
        if (t0) {
          lastTouchX = t0.clientX;
          lastTouchY = t0.clientY;
        }
      }
    });
  }

  private createToolbar() {
    this.toolbar = this.zoomOverlay!.createDiv("image-zoom-toolbar");

    // Zoom out button
    const zoomOutBtn = this.toolbar.createEl("button");
    zoomOutBtn.textContent = "−";
    zoomOutBtn.setAttribute("aria-label", "Zoom out");
    zoomOutBtn.addEventListener("click", () => this.zoomBy(0.9));

    // Reset button
    const resetBtn = this.toolbar.createEl("button", { cls: "zoom-reset-btn" });
    resetBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
    resetBtn.setAttribute("aria-label", "Reset to 100%");
    resetBtn.addEventListener("click", () => this.resetZoom());

    // Zoom info
    const zoomInfo = this.toolbar.createEl("span");
    zoomInfo.className = "zoom-info";
    zoomInfo.textContent = "100%";

    // Zoom in button
    const zoomInBtn = this.toolbar.createEl("button");
    zoomInBtn.textContent = "+";
    zoomInBtn.setAttribute("aria-label", "Zoom in");
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
    this.scale = Math.max(0.1, Math.min(this.scale, 50));
    this.updateImageTransform();
    this.updateToolbar();
  }

  private resetZoom() {
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
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
