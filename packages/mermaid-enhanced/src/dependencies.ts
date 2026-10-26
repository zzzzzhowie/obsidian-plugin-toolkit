import type { Plugin } from "obsidian";

/**
 * Hover a flowchart's box and its connections stand out — the edges into and out of it, their
 * labels and the boxes at their other ends — while the rest fades back; hover an edge or its
 * label and that edge and its two ends do. As Mermaid's own editor shows a diagram's
 * dependencies. In a note and in the zoom alike: the zoom shows a copy of the note's diagram,
 * or one drawn for it by the same renderer, and the listener is the document's.
 *
 * Obsidian (1.15) draws flowcharts with a renderer of its own ("pele"): boxes are
 * `.pele-node[data-id]`, groups `.pele-cluster[data-id]`, edges
 * `.pele-edge[data-id="L_<from>_<to>_<n>"]`, and an edge's label `.pele-edge-label` with the
 * edge's id. Ids can hold underscores, so an edge's ends are told by the ids the diagram has.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
/** On the diagram while something in it is hovered: what isn't lit fades (styles.css). */
const ON_CLS = "mermaid-deps-on";
/** On what is lit: the hovered box or edge and what it connects. */
const LIT_CLS = "is-dep";
/** A wide, unseen copy of an edge's line, so an edge a pixel or two wide can be hovered. */
const HIT_CLS = "mermaid-deps-hit";

interface Edge {
	from: string;
	to: string;
	/** The edge and its label, if it has one. */
	parts: Element[];
}

interface Diagram {
	/** Boxes and groups, by id. */
	ends: Map<string, Element>;
	edges: Map<string, Edge>;
}

export class DiagramDependencies {
	/** Each diagram looked at, indexed once; null for one with no edges to show. */
	private readonly diagrams = new WeakMap<SVGSVGElement, Diagram | null>();
	/** What is lit now, and in which diagram. */
	private lit: { svg: SVGSVGElement; key: string; elements: Element[] } | null = null;

	register(plugin: Plugin): void {
		plugin.registerDomEvent(document, "pointerover", (event) => this.onPointerOver(event), { passive: true });
		plugin.register(() => this.clear());
	}

	private onPointerOver(event: PointerEvent): void {
		const target = event.target instanceof Element ? event.target : null;
		const svg = target?.closest<SVGSVGElement>("svg.pele") ?? null;
		const diagram = svg ? this.diagramOf(svg) : null;
		if (!svg || !diagram || !target) {
			this.clear();
			return;
		}
		const found = this.connectionsAt(target, diagram);
		if (!found) {
			this.clear();
			return;
		}
		if (this.lit?.svg === svg && this.lit.key === found.key) return;
		this.clear();
		svg.classList.add(ON_CLS);
		for (const element of found.elements) element.classList.add(LIT_CLS);
		this.lit = { svg, key: found.key, elements: found.elements };
	}

	/** What hovering `target` lights: a box and everything it connects to, or an edge and its ends. */
	private connectionsAt(target: Element, diagram: Diagram): { key: string; elements: Element[] } | null {
		const edgeEl = target.closest(".pele-edge, .pele-edge-label");
		const edgeId = edgeEl?.getAttribute("data-id");
		const edge = edgeId ? diagram.edges.get(edgeId) : undefined;
		if (edgeId && edge) {
			const ends = [diagram.ends.get(edge.from), diagram.ends.get(edge.to)].filter((el): el is Element => !!el);
			return { key: `edge:${edgeId}`, elements: [...edge.parts, ...ends] };
		}
		// A group's label stands for the group; its background is just where boxes sit.
		const box = target.closest(".pele-node") ?? target.closest(".pele-cluster-label")?.closest(".pele-cluster");
		const id = box?.getAttribute("data-id");
		if (!box || !id) return null;
		const elements: Element[] = [box];
		for (const { from, to, parts } of diagram.edges.values()) {
			if (from !== id && to !== id) continue;
			elements.push(...parts);
			const other = diagram.ends.get(from === id ? to : from);
			if (other) elements.push(other);
		}
		return { key: `box:${id}`, elements };
	}

	/** Index a diagram's boxes and edges the first time the pointer is over it. */
	private diagramOf(svg: SVGSVGElement): Diagram | null {
		const known = this.diagrams.get(svg);
		if (known !== undefined) return known;
		const ends = new Map<string, Element>();
		for (const el of Array.from(svg.querySelectorAll(".pele-node[data-id], .pele-cluster[data-id]"))) {
			const id = el.getAttribute("data-id");
			if (id) ends.set(id, el);
		}
		const labels = new Map<string, Element[]>();
		for (const el of Array.from(svg.querySelectorAll(".pele-edge-label[data-id]"))) {
			const id = el.getAttribute("data-id") ?? "";
			labels.set(id, [...(labels.get(id) ?? []), el]);
		}
		const edges = new Map<string, Edge>();
		for (const el of Array.from(svg.querySelectorAll(".pele-edge[data-id]"))) {
			const id = el.getAttribute("data-id") ?? "";
			const pair = endsOf(id, ends);
			if (!pair) continue;
			edges.set(id, { from: pair[0], to: pair[1], parts: [el, ...(labels.get(id) ?? [])] });
			addHitArea(el);
		}
		const diagram = edges.size > 0 ? { ends, edges } : null;
		this.diagrams.set(svg, diagram);
		return diagram;
	}

	private clear(): void {
		if (!this.lit) return;
		this.lit.svg.classList.remove(ON_CLS);
		for (const element of this.lit.elements) element.classList.remove(LIT_CLS);
		this.lit = null;
	}
}

/** An edge id's two ends: `L_<from>_<to>_<n>`, split where both halves are ids the diagram has. */
function endsOf(edgeId: string, ends: Map<string, Element>): [string, string] | null {
	const body = /^L_(.+)_\d+$/.exec(edgeId)?.[1];
	if (!body) return null;
	for (let at = body.indexOf("_"); at > 0; at = body.indexOf("_", at + 1)) {
		const from = body.slice(0, at);
		const to = body.slice(at + 1);
		if (ends.has(from) && ends.has(to)) return [from, to];
	}
	return null;
}

/** Put a wide, unseen copy of the edge's line in it, once (a copy of a diagram has it already). */
function addHitArea(edge: Element): void {
	if (edge.querySelector(`:scope > .${HIT_CLS}`)) return;
	const line = Array.from(edge.children).find((child) => child.tagName === "path" && !child.classList.contains("pele-marker"));
	const d = line?.getAttribute("d");
	if (!d) return;
	const hit = document.createElementNS(SVG_NS, "path");
	hit.setAttribute("d", d);
	hit.setAttribute("class", HIT_CLS);
	edge.appendChild(hit);
}
