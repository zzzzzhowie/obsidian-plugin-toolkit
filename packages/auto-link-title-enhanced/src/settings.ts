import AutoLinkTitle from "./main";
import {
  App,
  ButtonComponent,
  ExtraButtonComponent,
  Notice,
  PluginSettingTab,
  Setting,
  TextAreaComponent,
  TextComponent,
} from "obsidian";
import type { HeaderRule } from "./scraper";
import { testLlm } from "./llm-title";

export interface AutoLinkTitleSettings {
  regex: RegExp;
  lineRegex: RegExp;
  linkRegex: RegExp;
  linkLineRegex: RegExp;
  imageRegex: RegExp;
  shouldPreserveSelectionAsTitle: boolean;
  enhanceDefaultPaste: boolean;
  enhanceDropEvents: boolean;
  websiteBlacklist: string;
  maximumTitleLength: number;
  linkPreviewApiKey: string;
  useBetterPasteId: boolean;
  headerRules: HeaderRule[];
  useLlm: boolean;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

export const DEFAULT_SETTINGS: AutoLinkTitleSettings = {
  regex:
    /^(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})$/i,
  lineRegex:
    /(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/gi,
  linkRegex:
    /^\[([^\[\]]*)\]\((https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})\)$/i,
  linkLineRegex:
    /\[([^\[\]]*)\]\((https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})\)/gi,
  imageRegex: /\.(gif|jpe?g|tiff?|png|webp|bmp|tga|psd|ai)$/i,
  enhanceDefaultPaste: true,
  shouldPreserveSelectionAsTitle: false,
  enhanceDropEvents: true,
  websiteBlacklist: "",
  maximumTitleLength: 0,
  linkPreviewApiKey: "",
  useBetterPasteId: false,
  headerRules: [],
  useLlm: true,
  llmBaseUrl: "https://api.openai.com/v1",
  llmApiKey: "",
  llmModel: "gpt-5.4-nano",
};

export class AutoLinkTitleSettingTab extends PluginSettingTab {
  plugin: AutoLinkTitle;

  constructor(app: App, plugin: AutoLinkTitle) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();

    this.renderLlmSettings(containerEl);

    new Setting(containerEl)
      .setName("Enhance Default Paste")
      .setDesc(
        "Fetch the link title when pasting a link in the editor with the default paste command"
      )
      .addToggle((val) =>
        val
          .setValue(this.plugin.settings.enhanceDefaultPaste)
          .onChange(async (value) => {
            this.plugin.settings.enhanceDefaultPaste = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enhance Drop Events")
      .setDesc(
        "Fetch the link title when drag and dropping a link from another program"
      )
      .addToggle((val) =>
        val
          .setValue(this.plugin.settings.enhanceDropEvents)
          .onChange(async (value) => {
            this.plugin.settings.enhanceDropEvents = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Maximum title length")
      .setDesc("Set the maximum length of the title. Set to 0 to disable.")
      .addText((val) =>
        val
          .setValue(this.plugin.settings.maximumTitleLength.toString(10))
          .onChange(async (value) => {
            const titleLength = Number(value);
            this.plugin.settings.maximumTitleLength =
              isNaN(titleLength) || titleLength < 0 ? 0 : titleLength;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Preserve selection as title")
      .setDesc(
        "Whether to prefer selected text as title over fetched title when pasting"
      )
      .addToggle((val) =>
        val
          .setValue(this.plugin.settings.shouldPreserveSelectionAsTitle)
          .onChange(async (value) => {
            this.plugin.settings.shouldPreserveSelectionAsTitle = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Website Blacklist")
      .setDesc(
        "List of strings (comma separated) that disable autocompleting website titles. Can be URLs or arbitrary text."
      )
      .addTextArea((val) =>
        val
          .setValue(this.plugin.settings.websiteBlacklist)
          .setPlaceholder("localhost, tiktok.com")
          .onChange(async (value) => {
            this.plugin.settings.websiteBlacklist = value;
            await this.plugin.saveSettings();
          })
      );

    this.renderHeaderRules(containerEl);

    new Setting(containerEl)
      .setName("Use Better Fetching Placeholder")
      .setDesc(
        "Use a more readable placeholder when fetching the title of a link."
      )
      .addToggle((val) =>
        val
          .setValue(this.plugin.settings.useBetterPasteId)
          .onChange(async (value) => {
            this.plugin.settings.useBetterPasteId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("LinkPreview API Key")
      .setDesc(
        "API key for the LinkPreview.net service. Get one at https://my.linkpreview.net/access_keys"
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.linkPreviewApiKey || "")
          .onChange(async (value) => {
            const trimmedValue = value.trim();
            if (trimmedValue.length > 0 && trimmedValue.length !== 32) {
              new Notice("LinkPreview API key must be 32 characters long");
              this.plugin.settings.linkPreviewApiKey = "";
            } else {
              this.plugin.settings.linkPreviewApiKey = trimmedValue;
            }
            await this.plugin.saveSettings();
          })
      );
  }

  // Primary title source: an OpenAI-compatible LLM that generates the title from
  // the URL alone. When it isn't configured or fails, the plugin falls back to
  // LinkPreview + the requestUrl scraper below.
  private renderLlmSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Title generation with an LLM")
      .setDesc(
        "Generate titles with any OpenAI-compatible chat API (OpenAI, Groq, " +
          "Gemini's compat layer, …) instead of fetching the page. The URL is sent " +
          "to the model (no page access); if it isn't configured or the request " +
          "fails, the plugin falls back to LinkPreview and the scraper below."
      )
      .setHeading();

    new Setting(containerEl)
      .setName("Use LLM")
      .setDesc("Try the LLM first when generating a title.")
      .addToggle((val) =>
        val.setValue(this.plugin.settings.useLlm).onChange(async (value) => {
          this.plugin.settings.useLlm = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc(
        "OpenAI-compatible base URL. e.g. https://api.openai.com/v1, " +
          "https://api.groq.com/openai/v1, " +
          "https://generativelanguage.googleapis.com/v1beta/openai"
      )
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.llmBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.llmBaseUrl =
              value.trim() || "https://api.openai.com/v1";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Sent as `Authorization: Bearer <key>`. Stored in this plugin's data.json.")
      .addText((text) => {
        text
          .setPlaceholder("sk-…")
          .setValue(this.plugin.settings.llmApiKey)
          .onChange(async (value) => {
            this.plugin.settings.llmApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Model id passed to the API, e.g. gpt-5.4-nano.")
      .addText((text) =>
        text
          .setPlaceholder("gpt-5.4-nano")
          .setValue(this.plugin.settings.llmModel)
          .onChange(async (value) => {
            this.plugin.settings.llmModel = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Send a sample URL to the LLM and show the generated title or error.")
      .addButton((btn) =>
        btn
          .setButtonText("Test")
          .setCta()
          .onClick(async () => {
            btn.setButtonText("Testing…").setDisabled(true);
            try {
              const result = await testLlm({
                baseUrl: this.plugin.settings.llmBaseUrl,
                apiKey: this.plugin.settings.llmApiKey,
                model: this.plugin.settings.llmModel,
              });
              new Notice(
                result.ok
                  ? `LLM OK  ${result.message}`
                  : `LLM test failed — ${result.message}`,
                result.ok ? 6000 : 12000
              );
            } finally {
              btn.setButtonText("Test").setDisabled(false);
            }
          })
      );
  }

  // A per-rule form: each rule matches URLs by wildcard domain (left)
  // and injects that rule's headers only into matching requests (right).
  private renderHeaderRules(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Custom request headers")
      .setDesc(
        "Inject extra request headers per site — e.g. a Cookie or token for intranet " +
          "pages that need auth before their title can be scraped. Match by domain/URL; " +
          "`*` is a wildcard (e.g. `*.corp.com`), everything else is literal. A rule's " +
          "headers are sent only to URLs it matches, so an internal cookie never leaks to " +
          "public sites. Leave the match field empty to apply a rule to every request."
      )
      .setHeading();

    const list = containerEl.createDiv({ cls: "alt-rule-list" });

    if (this.plugin.settings.headerRules.length === 0) {
      list.createEl("p", {
        text: 'No header rules yet. Click "Add rule" below to inject headers for specific sites.',
        cls: "alt-rule-empty",
      });
    }

    this.plugin.settings.headerRules.forEach((rule, index) => {
      const row = list.createDiv({ cls: "alt-rule" });

      // Left: wildcard match
      const domain = new TextComponent(row);
      domain.inputEl.addClass("alt-rule-domain");
      domain
        .setPlaceholder("*.corp.com")
        .setValue(rule.pattern)
        .onChange(async (value) => {
          rule.pattern = value;
          await this.plugin.saveSettings();
        });

      // Right: this rule's headers
      const right = row.createDiv({ cls: "alt-rule-right" });
      const headers = new TextAreaComponent(right);
      headers.inputEl.addClass("alt-rule-headers");
      headers
        .setPlaceholder(
          "Cookie: SESSION=abc; token=xyz\nX-Requested-With: XMLHttpRequest"
        )
        .setValue(rule.headers)
        .onChange(async (value) => {
          rule.headers = value;
          await this.plugin.saveSettings();
        });

      // Trailing delete affordance — a small icon, not a heavy red block
      const remove = new ExtraButtonComponent(row);
      remove.extraSettingsEl.addClass("alt-rule-remove");
      remove
        .setIcon("trash")
        .setTooltip("Delete rule")
        .onClick(async () => {
          this.plugin.settings.headerRules.splice(index, 1);
          await this.plugin.saveSettings();
          this.display();
        });
    });

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("Add rule")
        .setCta()
        .onClick(async () => {
          this.plugin.settings.headerRules.push({
            pattern: "",
            headers: "",
          });
          await this.plugin.saveSettings();
          this.display();
        })
    );
  }
}
