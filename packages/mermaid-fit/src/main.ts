import { Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	MermaidFitSettings,
	MermaidFitSettingTab,
} from "./settings";

export default class MermaidFitPlugin extends Plugin {
	settings: MermaidFitSettings;

	/** Watches the workspace for newly rendered Mermaid SVGs. */
	private observer: MutationObserver | null = null;
	/** Coalesces bursts of mutations into a single processing pass. */
	private rafHandle: number | null = null;
	/** Debounce timer for window resize. */
	private resizeTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new MermaidFitSettingTab(this.app, this));

		// Process diagrams that already exist once the layout is ready.
		this.app.workspace.onLayoutReady(() => this.processAll());

		// Mermaid renders asynchronously, so watch the workspace for added SVGs.
		const root =
			document.querySelector(".workspace") ?? document.body;
		this.observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.addedNodes.length > 0) {
					this.scheduleProcess();
					return;
				}
			}
		});
		this.observer.observe(root, { childList: true, subtree: true });

		// Re-process when leaves are rearranged (split/close/switch).
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.scheduleProcess())
		);

		// Viewport height changes alter the target height, so recompute.
		this.registerDomEvent(window, "resize", () => {
			if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
			this.resizeTimer = window.setTimeout(() => this.processAll(), 150);
		});
	}

	onunload() {
		this.observer?.disconnect();
		this.observer = null;
		if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
		if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
		// Leave the DOM as we found it.
		this.clearAll();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MermaidFitSettings>
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Coalesce mutation bursts into one pass on the next frame. */
	private scheduleProcess() {
		if (this.rafHandle !== null) return;
		this.rafHandle = requestAnimationFrame(() => {
			this.rafHandle = null;
			this.processAll();
		});
	}

	/** (Re)apply the height constraint to every rendered Mermaid diagram. */
	processAll() {
		if (!this.settings.enabled) {
			this.clearAll();
			return;
		}
		const targetH = window.innerHeight * (this.settings.maxHeightVh / 100);
		const svgs = document.querySelectorAll<SVGSVGElement>(".mermaid svg");
		svgs.forEach((svg) => this.fitSvg(svg, targetH));
	}

	/**
	 * Cap the diagram's height to `targetH` by capping its max-width derived
	 * from the viewBox aspect ratio. A px max-width clamps the SVG even when a
	 * theme forces `width: 100% !important`, since max-width and width are
	 * independent properties. Wide diagrams get a max-width larger than the
	 * container, so they're unaffected and still fill the width.
	 */
	private fitSvg(svg: SVGSVGElement, targetH: number) {
		const vb = svg.viewBox.baseVal;
		if (!vb || vb.width === 0 || vb.height === 0) return;
		const aspect = vb.width / vb.height; // width / height
		svg.style.maxWidth = `${Math.round(targetH * aspect)}px`;
		svg.style.height = "auto";
		svg.dataset.mermaidFit = "1";
	}

	/** Remove every constraint this plugin applied. */
	private clearAll() {
		document
			.querySelectorAll<SVGSVGElement>("svg[data-mermaid-fit]")
			.forEach((svg) => {
				svg.style.removeProperty("max-width");
				svg.style.removeProperty("height");
				delete svg.dataset.mermaidFit;
			});
	}
}
