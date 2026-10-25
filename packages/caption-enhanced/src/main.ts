import { App, type MarkdownPostProcessorContext, Plugin, PluginSettingTab, Setting } from 'obsidian';
import {
	imageCaptionExtension,
	ImageCaptionSettings,
	DEFAULT_SETTINGS,
	embedSourceOf,
	FIGURES,
	parseCaption,
	setLiveSettings,
	syncCaptionWidth,
} from './extension';
import { setCaptionContent, setRenderContext } from './caption-content';
import { nestedImageExtension } from './nested';
import { captionOf, type ImageSource, readImages, sameTarget } from './source';

// ============================================================
// 插件主入口类
// ============================================================

/** How long an image embed is watched for its <img> before it's given up on. */
const EMBED_WAIT_MS = 10_000;

export default class CaptionEnhancedPlugin extends Plugin {
	settings: ImageCaptionSettings;
	/** Image embeds still waiting for their <img>; each is let go once it arrives, on unload, or after EMBED_WAIT_MS. */
	private readonly embedWatchers = new Set<MutationObserver>();
	/** Captions of markdown images with a title, by the element showing each (its embed, else the <img>); see lookUpTitles. */
	private readonly titles = new WeakMap<Element, string>();

	async onload() {
		await this.loadSettings();
		// Captions with a link in them are rendered as markdown, under this plugin's lifetime.
		setRenderContext({ app: this.app, component: this });

		// 1. 注册 Live Preview 模式编辑器扩展
		this.registerEditorExtension([imageCaptionExtension, nestedImageExtension]);

		// 2. 注册 Reading Mode (阅读模式) Markdown 渲染后处理器
		this.registerMarkdownPostProcessor((el, ctx) => {
			// A. 处理 embed 异步渲染图片 — every embed, not just an image one: an embed is
			// `image-embed` only once its file has loaded, which is after this runs. The image is
			// the embed's own <img>, never one inside an embedded note; an embed that turns out
			// to be a note, PDF or audio is let go as soon as it shows which.
			const embeds = el.matches('.internal-embed')
				? [el]
				: Array.from(el.querySelectorAll<HTMLElement>('.internal-embed'));

			embeds.forEach((embedEl) => {
				const img = ownImage(embedEl);
				if (img) {
					this.injectReadingCaption(img, embedEl, ctx.sourcePath);
				} else if (!isOtherEmbed(embedEl)) {
					// 一次性监听 embed 容器内的 img 异步塞入动作，防范内存泄露
					const observer = new MutationObserver(() => {
						const loadedImg = ownImage(embedEl);
						if (loadedImg) {
							this.injectReadingCaption(loadedImg, embedEl, ctx.sourcePath);
							this.letGo(observer);
						} else if (isOtherEmbed(embedEl)) {
							this.letGo(observer);
						}
					});
					observer.observe(embedEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
					this.embedWatchers.add(observer);
					window.setTimeout(() => this.letGo(observer), EMBED_WAIT_MS);
				}
			});

			// B. 处理普通的 Markdown 本地与外链图床图片
			const imgs = el.querySelectorAll<HTMLElement>(FIGURES);
			imgs.forEach((img: HTMLElement) => {
				// 自动排除已经包含在 Wiki embed 内部的图片，防止重复注入 — an image embed's own; an
				// image inside a transcluded note is an ordinary image of that note.
				const embed = img.closest<HTMLElement>('.internal-embed');
				if (embed && ownImage(embed) === img) {
					return;
				}
				this.injectReadingCaption(img, null, ctx.sourcePath);
			});

			void this.lookUpTitles(el, ctx);
		});

		// 3. 注册设置控制台面板
		this.addSettingTab(new CaptionEnhancedSettingTab(this.app, this));
	}

	/**
	 * A markdown image's title, where a caption with a link in it is written (see withCaption).
	 * The rendered <img> doesn't carry it, so it's read from the markdown: the section's when
	 * Obsidian says which lines it came from, else the note's. The page's images and the
	 * markdown's are paired in order, each to the next one with the same target.
	 */
	private async lookUpTitles(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
		// An embed processed on its own, once loaded, was paired with the section it's in.
		if (el.matches('.internal-embed')) return;
		// Any embed, not just an image one: an embed is `image-embed` only once its file has
		// loaded, after this runs. A note's embed pairs with its own `![[note]]`.
		const slots = Array.from(el.querySelectorAll<HTMLElement>(`.internal-embed, ${FIGURES}`)).filter(
			(slot) => !(slot.matches(FIGURES) && slot.closest('.internal-embed')),
		);
		if (slots.length === 0) return;
		const info = ctx.getSectionInfo(el);
		let text: string | null = null;
		if (info) {
			text = info.text.split('\n').slice(info.lineStart, info.lineEnd + 1).join('\n');
		} else {
			const file = this.app.vault.getFileByPath(ctx.sourcePath);
			if (file) text = await this.app.vault.cachedRead(file);
		}
		if (!text) return;
		const images = readImages(text);
		const used = new Set<ImageSource>();
		for (const slot of slots) {
			const target = slot.getAttribute('src') ?? '';
			const image = images.find((candidate) => !used.has(candidate) && sameTarget(candidate.target, target));
			if (!image) continue;
			used.add(image);
			// Only a markdown image with a title differs from what the page says (its alt).
			if (image.kind !== 'markdown' || !image.title?.trim()) continue;
			this.titles.set(slot, captionOf(image));
			const figure = slot.matches(FIGURES) ? slot : ownImage(slot);
			if (figure) this.injectReadingCaption(figure, slot.matches(FIGURES) ? null : slot, ctx.sourcePath);
		}
	}

	private letGo(observer: MutationObserver): void {
		observer.disconnect();
		this.embedWatchers.delete(observer);
	}

	/**
	 * 抽象的阅读模式 Caption 注入核心方法
	 */
	injectReadingCaption(img: HTMLElement, embedParent: HTMLElement | null, sourcePath: string) {
		const wrapper = img.closest('.image-wrapper');

		// 1. 解析当前的 alt 和 src 元数据并计算最新的说明文字
		const altText = img.getAttribute('alt');
		const resolvedAlt = altText || (embedParent ? embedParent.getAttribute('alt') : null);
		const resolvedSrc = embedSourceOf(img) || img.getAttribute('src') || (embedParent ? embedParent.getAttribute('src') : null);

		// A markdown image's title is its caption when there is one — where a caption with a
		// link in it is written (see withCaption).
		const captionText = this.titles.get(embedParent ?? img) || parseCaption(resolvedAlt, this.settings, resolvedSrc);

		// 2. 精准检查 DOM 树中是否真正存在属于该图片的 caption 元素
		let existingCaption: HTMLElement | null = null;
		if (wrapper) {
			const next = wrapper.nextElementSibling;
			if (next && next.classList.contains('image-caption')) {
				existingCaption = next as HTMLElement;
			}
		} else if (embedParent) {
			existingCaption = embedParent.querySelector(':scope > .image-caption');
		} else {
			const next = img.nextElementSibling;
			if (next && next.classList.contains('image-caption')) {
				existingCaption = next as HTMLElement;
			}
		}

		// 3. 反应式数据流处理
		if (existingCaption) {
			if (captionText) {
				// 文本变化时，实时更新内容 —— 带链接的渲染成 markdown
				setCaptionContent(existingCaption, captionText, sourcePath);
				// 响应式更新样式类
				existingCaption.className = 'image-caption';
				existingCaption.classList.add(`align-${this.settings.captionAlign}`);
				existingCaption.classList.add(`style-${this.settings.captionStyle}`);
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
			setCaptionContent(captionEl, captionText, sourcePath);

			// 应用设置样式类
			captionEl.classList.add(`align-${this.settings.captionAlign}`);
			captionEl.classList.add(`style-${this.settings.captionStyle}`);

			if (wrapper) {
				wrapper.after(captionEl);
			} else if (embedParent) {
				// 注入到 internal-embed 内部最后
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
	}

	onunload() {
		setRenderContext(null);
		for (const observer of this.embedWatchers) observer.disconnect();
		this.embedWatchers.clear();
		// 彻底清除页面上残留的所有 caption 节点及 has-caption 样式类
		activeDocument.querySelectorAll('.image-caption').forEach((el) => el.remove());
		activeDocument.querySelectorAll('.has-caption').forEach((el) => el.classList.remove('has-caption'));
	}

	async loadSettings() {
		const data = await this.loadData() as Partial<ImageCaptionSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		setLiveSettings(this.settings);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		setLiveSettings(this.settings);
	}

	/**
	 * 当用户修改设置后，通知编辑器及视口更新，触发 Caption 重绘与样式级联响应
	 */
	refreshWorkspace() {
		this.app.workspace.updateOptions();
	}
}

/** An embed's own image: its <img>, not one in a note it embeds. */
function ownImage(embed: HTMLElement): HTMLElement | null {
	if (!embed.matches('.internal-embed')) return null;
	// An Excalidraw drawing's sits further down, in its own wrappers: an <img> or, shown as
	// SVG, a div holding the <svg> — either one carrying `excalidraw-embedded-img`.
	return embed.querySelector<HTMLElement>(':scope > img, :scope > .image-wrapper > img, .excalidraw-embedded-img');
}

/** An embed shown as something other than an image: a note, a PDF, audio, video. */
function isOtherEmbed(embed: HTMLElement): boolean {
	return embed.matches('.markdown-embed, .pdf-embed, .media-embed:not(.image-embed), .file-embed');
}

// ============================================================
// 设置面板类 (遵循 Sentence case 大小写规范)
// ============================================================

class CaptionEnhancedSettingTab extends PluginSettingTab {
	plugin: CaptionEnhancedPlugin;

	constructor(app: App, plugin: CaptionEnhancedPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Show image file name as caption')
			.setDesc('Use the file name as a fallback caption when no alt text or alias is explicitly specified.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showFileNameAsCaption)
					.onChange(async (value) => {
						this.plugin.settings.showFileNameAsCaption = value;
						await this.plugin.saveSettings();
						this.plugin.refreshWorkspace();
					})
			);

		new Setting(containerEl)
			.setName('Caption text alignment')
			.setDesc('Choose how you want your image caption text to align relative to the image container.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('left', 'Left')
					.addOption('center', 'Center')
					.addOption('right', 'Right')
					.setValue(this.plugin.settings.captionAlign)
					.onChange(async (value: 'left' | 'center' | 'right') => {
						this.plugin.settings.captionAlign = value;
						await this.plugin.saveSettings();
						this.plugin.refreshWorkspace();
					})
			);

		new Setting(containerEl)
			.setName('Caption text style')
			.setDesc('Configure the font appearance style for the caption text.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('italic', 'Italic')
					.addOption('normal', 'Normal')
					.setValue(this.plugin.settings.captionStyle)
					.onChange(async (value: 'italic' | 'normal') => {
						this.plugin.settings.captionStyle = value;
						await this.plugin.saveSettings();
						this.plugin.refreshWorkspace();
					})
			);

		new Setting(containerEl)
			.setName('Caption extraction regex')
			.setDesc(
				'Optional. A regular expression to extract the caption from the image alt text. ' +
				'The first capture group is used as the caption (or the whole match if there is no group). ' +
				'Leave empty to use the default parsing. Example: ^(.*?)\\s*\\|\\s*\\d+$ keeps only the text before a trailing "|<size>".'
			)
			.addText((text) =>
				text
					.setPlaceholder('e.g. ^(.*?)\\s*\\|')
					.setValue(this.plugin.settings.captionRegex)
					.onChange(async (value) => {
						this.plugin.settings.captionRegex = value.trim();
						await this.plugin.saveSettings();
						this.plugin.refreshWorkspace();
					})
			);
	}
}
