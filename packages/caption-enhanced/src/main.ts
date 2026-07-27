import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import {
	imageCaptionExtension,
	ImageCaptionSettings,
	DEFAULT_SETTINGS,
	parseCaption,
	setLiveSettings,
	syncCaptionWidth,
} from './extension';

// ============================================================
// 插件主入口类
// ============================================================

export default class CaptionEnhancedPlugin extends Plugin {
	settings: ImageCaptionSettings;

	async onload() {
		await this.loadSettings();

		// 1. 注册 Live Preview 模式编辑器扩展
		this.registerEditorExtension(imageCaptionExtension);

		// 2. 注册 Reading Mode (阅读模式) Markdown 渲染后处理器
		this.registerMarkdownPostProcessor((el) => {
			// A. 处理 Wiki embed 异步渲染图片
			const embeds = el.classList.contains('internal-embed')
				? [el]
				: Array.from(el.querySelectorAll<HTMLElement>('.internal-embed'));

			embeds.forEach((embedEl) => {
				const img = embedEl.querySelector('img');
				if (img) {
					this.injectReadingCaption(img, embedEl);
				} else {
					// 一次性监听 Wiki 嵌入容器内的 img 异步塞入动作，防范内存泄露
					const observer = new MutationObserver((_, obs) => {
						const loadedImg = embedEl.querySelector('img');
						if (loadedImg) {
							this.injectReadingCaption(loadedImg, embedEl);
							obs.disconnect();
						}
					});
					observer.observe(embedEl, { childList: true, subtree: true });
				}
			});

			// B. 处理普通的 Markdown 本地与外链图床图片
			const imgs = el.querySelectorAll('img');
			imgs.forEach((img: HTMLImageElement) => {
				// 自动排除已经包含在 Wiki embed 内部的图片，防止重复注入
				if (img.closest('.internal-embed')) {
					return;
				}
				this.injectReadingCaption(img, null);
			});
		});

		// 3. 注册设置控制台面板
		this.addSettingTab(new CaptionEnhancedSettingTab(this.app, this));
	}

	/**
	 * 抽象的阅读模式 Caption 注入核心方法
	 */
	injectReadingCaption(img: HTMLImageElement, embedParent: HTMLElement | null) {
		const wrapper = img.closest('.image-wrapper');

		// 1. 解析当前的 alt 和 src 元数据并计算最新的说明文字
		const altText = img.getAttribute('alt');
		const resolvedAlt = altText || (embedParent ? embedParent.getAttribute('alt') : null);
		const resolvedSrc = img.getAttribute('src') || (embedParent ? embedParent.getAttribute('src') : null);

		const captionText = parseCaption(resolvedAlt, this.settings, resolvedSrc);

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
				// 文本变化时，实时更新文本内容
				if (existingCaption.textContent !== captionText) {
					existingCaption.setText(captionText);
				}
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
			captionEl.setText(captionText);

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
