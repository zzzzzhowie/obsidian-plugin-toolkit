import { Plugin } from "obsidian";

// Live Preview 表格编辑器的内部结构（非公开 API），只声明用到的部分。
interface TableCell {
	el: HTMLElement;
}

interface TableWidget {
	rows: TableCell[][];
	// 写成属性而不是方法签名：要把原型上的原函数存下来以便卸载时还原
	getClosestCell: (this: TableWidget, x: number, y: number) => TableCell;
}

type GetClosestCell = TableWidget["getClosestCell"];

// 原实现按顺序扫描，距离一变大就 break，默认各行屏幕坐标单调递增。
// 表头吸顶后第 0 行停在视口顶部，第 1 行早已滚出视口上方：扫到第 1 行距离暴涨直接 break，
// 拖选的落点永远被判成表头，选区被拉到第 0 行。这里改成全量扫描取最近。
function closestIndex(rects: DOMRect[], pos: number, axis: "x" | "y"): number {
	let best = 0;
	let bestDist = Infinity;
	for (const [i, rect] of rects.entries()) {
		const lo = axis === "y" ? rect.top : rect.left;
		const hi = axis === "y" ? rect.bottom : rect.right;
		// 命中取第一个：指针压在吸顶表头上时，表头排在被它盖住的正文行前面，和肉眼所见一致
		if (lo <= pos && pos <= hi) return i;
		const dist = Math.min(Math.abs(lo - pos), Math.abs(hi - pos));
		if (dist < bestDist) {
			best = i;
			bestDist = dist;
		}
	}
	return best;
}

function patchedGetClosestCell(original: GetClosestCell): GetClosestCell {
	return function (this: TableWidget, x, y) {
		const rows = this.rows.filter((r) => r.length > 0);
		const row = rows[closestIndex(rows.map((r) => (r[0] as TableCell).el.getBoundingClientRect()), y, "y")];
		const cell = row?.[closestIndex(row.map((c) => c.el.getBoundingClientRect()), x, "x")];
		return cell ?? original.call(this, x, y);
	};
}

export default class StickyTableHeaderPlugin extends Plugin {
	private patched: { proto: TableWidget; original: GetClosestCell; patch: GetClosestCell } | null = null;

	onload(): void {
		// 表格类没有导出，只能从实例上拿原型。getClosestCell 在 pointermove 里才调用，
		// 捕获阶段的 pointerdown 一定早于它。打上补丁（原型共享，所有表格、所有窗口都生效）就不再监听。
		const onPointerDown = (evt: PointerEvent): void => {
			if (this.patchFrom(evt.target)) document.removeEventListener("pointerdown", onPointerDown, true);
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		this.register(() => document.removeEventListener("pointerdown", onPointerDown, true));
	}

	onunload(): void {
		// 只还原自己装的那一层：之后别的插件若也包过一层，留着它不动。
		const patched = this.patched;
		if (patched && patched.proto.getClosestCell === patched.patch) patched.proto.getClosestCell = patched.original;
		this.patched = null;
	}

	/** Patch the table class from a press inside one of its tables; whether it's patched now. */
	private patchFrom(target: EventTarget | null): boolean {
		if (this.patched) return true;
		if (!(target instanceof Element)) return false;
		const widgetEl: (Element & { cmTile?: { widget?: unknown } }) | null = target.closest(".cm-table-widget");
		const widget = widgetEl?.cmTile?.widget as TableWidget | undefined;
		if (typeof widget?.getClosestCell !== "function") return false;
		const proto = Object.getPrototypeOf(widget) as TableWidget;
		const original = proto.getClosestCell;
		const patch = patchedGetClosestCell(original);
		this.patched = { proto, original, patch };
		proto.getClosestCell = patch;
		return true;
	}
}
