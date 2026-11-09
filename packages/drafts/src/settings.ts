import { type App, PluginSettingTab, Setting } from "obsidian";

import type DraftsPlugin from "./main";

export interface DraftsSettings {
	/** Days a draft no tab shows is kept after its last change before it goes to the trash. */
	keepDays: number;
}

export const DEFAULT_SETTINGS: DraftsSettings = {
	keepDays: 3,
};

export class DraftsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: DraftsPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName("Keep drafts left behind for")
			.setDesc("Days after its last change. A draft no tab shows goes to the trash after that, with the attachments only it used; open drafts are never touched.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.keepDays)).onChange(async (value) => {
					const days = Number(value);
					if (!Number.isFinite(days) || days <= 0) return;
					this.plugin.settings.keepDays = days;
					await this.plugin.saveData(this.plugin.settings);
				}),
			);
	}
}
