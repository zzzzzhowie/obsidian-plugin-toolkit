import {
	ViewUpdate,
	PluginValue,
	EditorView,
	ViewPlugin,
} from '@codemirror/view';

// ============================================================
// 设置接口与默认值
// ============================================================

export interface ImageCaptionSettings {
	showFileNameAsCaption: boolean;
	captionAlign: 'left' | 'center' | 'right';
	captionStyle: 'italic' | 'normal';
	/**
	 * 可选的自定义提取正则。留空时走默认解析。
	 * 命中时优先取第 1 个捕获组，无捕获组则取整段匹配，作为 caption。
	 */
	captionRegex: string;
}

export const DEFAULT_SETTINGS: ImageCaptionSettings = {
	showFileNameAsCaption: false,
	captionAlign: 'center',
	captionStyle: 'italic',
	captionRegex: '',
};

// Live Preview 视图插件通过模块级引用读取当前设置，避免依赖已废弃的全局 app。
// 主插件在加载 / 保存设置时调用 setLiveSettings 同步引用。
let liveSettings: ImageCaptionSettings = DEFAULT_SETTINGS;

export function setLiveSettings(settings: ImageCaptionSettings): void {
	liveSettings = settings;
}

// ============================================================
// Caption 智能解析 Helper 函数
// ============================================================

// 尾部尺寸后缀，形如 "| 500"、"|500x300"（Obsidian 缩放语法）。
// 用正则整体切除，保留前面原文（含内部管道与空格），而不是 split/join 逐段重拼。
const SIZE_SUFFIX_RE = /\s*\|\s*\d+(?:x\d+)?\s*$/;
// 尾部裸管道，形如 "caption|" 或 "caption | "。
const TRAILING_PIPE_RE = /\s*\|\s*$/;

// 自定义正则的编译缓存：避免逐图 new RegExp，并优雅吞掉非法 pattern。
let cachedPattern: string | null = null;
let cachedRegex: RegExp | null = null;

function compileUserRegex(pattern: string): RegExp | null {
	if (!pattern) return null;
	if (pattern === cachedPattern) return cachedRegex;
	cachedPattern = pattern;
	try {
		cachedRegex = new RegExp(pattern);
	} catch {
		// 用户正则写错时不抛错、不影响渲染，退回默认解析
		cachedRegex = null;
	}
	return cachedRegex;
}

function getCleanFileName(src: string | null): string | null {
	if (!src) return null;
	const fileName = src.split('/').pop() || src;
	return decodeURIComponent(fileName.split('?')[0] ?? fileName);
}

/**
 * 切除尾部尺寸后缀，保留其前面的原始文本作为 caption。
 * "My caption|500"      -> "My caption"
 * "My caption | 500"    -> "My caption"
 * "A | B | 300"         -> "A | B"   （只吃尾部尺寸，内部管道保留）
 * "caption|"            -> "caption" （裸尾管道也清掉）
 */
function stripSizeSuffix(altText: string): string {
	return altText
		.replace(SIZE_SUFFIX_RE, '')
		.replace(TRAILING_PIPE_RE, '')
		.trim();
}

/**
 * 智能解析图片说明文字。
 * 优先级：自定义正则命中 > 默认「切尾部尺寸」解析。
 */
export function parseCaption(
	altText: string | null,
	settings: ImageCaptionSettings,
	srcText: string | null
): string | null {
	const showFileName = settings.showFileNameAsCaption;

	if (!altText || altText.trim() === '') {
		return showFileName ? getCleanFileName(srcText) : null;
	}

	// 1. 自定义正则提取（若配置且命中）——用户显式意图，直接采信，跳过后续兜底过滤
	const userRegex = compileUserRegex(settings.captionRegex);
	if (userRegex) {
		const match = altText.match(userRegex);
		if (match) {
			const extracted = (match[1] ?? match[0] ?? '').trim();
			return extracted === '' ? null : extracted;
		}
		// 配置了正则但没命中 -> 落回默认解析
	}

	// 2. 默认解析：切掉尾部尺寸后缀，取前面原文
	const caption = stripSizeSuffix(altText);

	if (caption === '') {
		return showFileName ? getCleanFileName(srcText) : null;
	}

	// 3. 唯一的兜底过滤：当 alt 恰好等于图片自身文件名时，它是空 alt（![](url)）时
	//    Obsidian 依据 src 自动回填的文件名，而非用户书写的说明 —— 不显示。
	//    其余任何非空 alt（含用户手写的 "image.png"，因其 ≠ src 上的时间戳文件名）
	//    一律原样展示。至于自动生成的默认 image.png 占位，由上游
	//    image-auto-upload-enhanced 的 imageDesc="removeDefault" 在粘贴时清空。
	if (!showFileName) {
		const cleanSrcName = getCleanFileName(srcText);
		if (cleanSrcName && cleanSrcName === caption) {
			return null;
		}
	}

	return caption;
}

/**
 * 让 caption 的宽度与图片一致。
 * caption 是块级元素（CSS 默认 width:100%），当它所在的容器比图片宽
 * （如表格单元格 .table-cell-wrapper 是 100% 单元格宽，而图片只有 300px）时，
 * align-center/left/right 会相对「整个容器」而非「图片」对齐，导致 caption 偏移。
 * 把 caption 显式设成图片的渲染宽度即可复刻 figure/figcaption 语义：
 * 对齐相对图片，超长文本也在图片宽度内换行。
 */
export function syncCaptionWidth(img: HTMLImageElement, captionEl: HTMLElement): void {
	const sync = () => {
		const w = img.getBoundingClientRect().width;
		captionEl.style.width = w ? `${w}px` : '';
	};
	sync();
	// 外链图片首次渲染时可能尚未加载完、渲染宽度为 0，加载完成后再同步一次
	if (!img.complete) {
		img.addEventListener('load', sync, { once: true });
	}
}

// ============================================================
// CodeMirror 6 实时预览静态视图插件
// ============================================================

class ImageCaptionLPPlugin implements PluginValue {
	private observer: MutationObserver;
	private view: EditorView;

	constructor(view: EditorView) {
		this.view = view;

		// 首次挂载时扫描
		this.scanAndInject(view.dom);

		// 使用 MutationObserver 监听 DOM 树的增减变化，确保在滚动或折叠动作后即时发现新图片。
		// 注意：scanAndInject 会向被监听的 view.dom 增删 .image-caption 节点，这些写入会以
		// 微任务再次触发本回调 —— 若不加防护即形成自反馈死循环（100% CPU 自旋）。
		// 修法：回调里先 disconnect（同时丢弃已排队的记录），扫描完再 observe，
		// 使扫描期间自身产生的 DOM 变更不被记录、不再递归。
		this.observer = new MutationObserver(() => {
			this.observer.disconnect();
			try {
				this.scanAndInject(this.view.dom);
			} finally {
				this.observer.observe(this.view.dom, {
					childList: true,
					subtree: true,
				});
			}
		});

		this.observer.observe(view.dom, {
			childList: true,
			subtree: true,
		});
	}

	update(update: ViewUpdate) {
		// 在文档内容改变或视口发生移动时重新扫描
		if (update.docChanged || update.viewportChanged) {
			this.scanAndInject(update.view.dom);
		}
	}

	destroy() {
		// 严防内存泄露：销毁时断开监听
		if (this.observer) {
			this.observer.disconnect();
		}
	}

	private getSettings(): ImageCaptionSettings {
		return liveSettings;
	}

	private scanAndInject(dom: HTMLElement) {
		const settings = this.getSettings();
		const imgs = dom.querySelectorAll('img');

		imgs.forEach((img: HTMLImageElement) => {
			// 获取相关的容器
			const wrapper = img.closest('.image-wrapper');
			// 表格单元格内的图片不能把外层 .cm-embed-block（整张 .cm-table-widget）
			// 当作自己的 embed 容器 —— 否则 caption 会被 appendChild 到表格外，且同表
			// 多张图共用同一节点、互相覆盖文本。此时强制走「紧跟图片」的行内路径。
			const inTableCell = !!img.closest('td, th, .table-cell-wrapper');
			const embedParent = inTableCell
				? null
				: (img.closest('.image-embed') || img.closest('.cm-embed-block'));

			// 1. 解析当前的 alt 和 src 元数据并计算最新的说明文字
			const altText = img.getAttribute('alt');
			const resolvedAlt = altText || (embedParent ? embedParent.getAttribute('alt') : null);
			const resolvedSrc = img.getAttribute('src') || (embedParent ? embedParent.getAttribute('src') : null);

			const captionText = parseCaption(resolvedAlt, settings, resolvedSrc);

			// 2. 检查 DOM 树中是否真正存在属于该图片的 caption 元素
			// 优先使用 embedParent 级别检查，覆盖 wrapper + embedParent 同时存在的场景
			let existingCaption: HTMLElement | null = null;
			if (embedParent) {
				existingCaption = embedParent.querySelector(':scope > .image-caption');
			}
			if (!existingCaption && wrapper) {
				const next = wrapper.nextElementSibling;
				if (next && next.classList.contains('image-caption')) {
					existingCaption = next as HTMLElement;
				}
			}
			if (!existingCaption && !wrapper && !embedParent) {
				const next = img.nextElementSibling;
				if (next && next.classList.contains('image-caption')) {
					existingCaption = next as HTMLElement;
				}
			}

			// 3. 反应式数据流处理
			if (existingCaption) {
				if (captionText) {
					// 文本变化时，实时更新文本内容
					if (existingCaption.textContent !== captionText) {
						existingCaption.setText(captionText);
					}
					// 响应式更新样式类
					this.applyStyleClasses(existingCaption, settings);
					syncCaptionWidth(img, existingCaption);
					if (embedParent) {
						embedParent.classList.add('has-caption');
					}
					img.dataset.hasCaption = 'true';
				} else {
					// 说明文字被删除，清理节点与相应标记
					existingCaption.remove();
					delete img.dataset.hasCaption;
					if (embedParent) {
						embedParent.classList.remove('has-caption');
					}
				}
				return;
			}

			// 4. 创建并注入全新 Caption 元素
			if (captionText) {
				img.dataset.hasCaption = 'true';

				// 严格使用 activeDocument，防止多开 Popout 报错
				const captionEl = activeDocument.createElement('div');
				captionEl.className = 'image-caption';
				captionEl.setText(captionText);
				this.applyStyleClasses(captionEl, settings);

				if (wrapper) {
					wrapper.after(captionEl);
				} else if (embedParent) {
					// 注入到容器内部最后
					if (!embedParent.querySelector(':scope > .image-caption')) {
						embedParent.appendChild(captionEl);
					}
				} else {
					img.after(captionEl);
				}

				syncCaptionWidth(img, captionEl);

				if (embedParent) {
					embedParent.classList.add('has-caption');
				}
			} else {
				if (embedParent) {
					embedParent.classList.remove('has-caption');
				}
			}
		});
	}

	private applyStyleClasses(el: HTMLElement, settings: ImageCaptionSettings) {
		el.className = 'image-caption';
		el.classList.add(`align-${settings.captionAlign}`);
		el.classList.add(`style-${settings.captionStyle}`);
	}
}

// ============================================================
// 导出静态扩展
// ============================================================

export const imageCaptionExtension = ViewPlugin.fromClass(ImageCaptionLPPlugin);
