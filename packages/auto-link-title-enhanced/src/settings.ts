import AutoLinkTitle from "./main";
import {
  App,
  Notice,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { testLlm } from "./llm-title";
import { chromeCookiesFor, chromeCookiesSupported, retryChromeKey } from "./chrome-cookies";

export interface AutoLinkTitleSettings {
  shouldPreserveSelectionAsTitle: boolean;
  enhanceDropEvents: boolean;
  websiteBlacklist: string;
  maximumTitleLength: number;
  useLlm: boolean;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

export const DEFAULT_SETTINGS: AutoLinkTitleSettings = {
  shouldPreserveSelectionAsTitle: false,
  enhanceDropEvents: true,
  websiteBlacklist: "",
  maximumTitleLength: 0,
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

    this.renderChromeCookies(containerEl);
  }

  // Primary title source: an OpenAI-compatible LLM that writes the title from the
  // fetched page's own title, description and an excerpt (see fetchUrlTitle).
  // When it isn't configured or fails, the plugin falls back to the page's title,
  // then the requestUrl scraper.
  private renderLlmSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Title generation with an LLM")
      .setDesc(
        "Generate titles with any OpenAI-compatible chat API (OpenAI, Groq, " +
          "Gemini's compat layer, …). The page is fetched first (with Chrome's " +
          "cookies, below) and its title, description and a short excerpt are sent " +
          "to the model. If the model isn't configured or the request fails, the " +
          "page's own title is used."
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

  // Intranet login cookies, read live from Chrome — see chrome-cookies.ts.
  private renderChromeCookies(containerEl: HTMLElement): void {
    if (!chromeCookiesSupported()) return;

    new Setting(containerEl)
      .setName("Cookies from Chrome")
      .setDesc(
        "Every link is fetched with the cookies Chrome would send to it, so intranet " +
          "pages behind SSO return their real title. Read fresh for each link and kept in " +
          "memory only — never saved. macOS asks for keychain access the first time " +
          "after Obsidian starts."
      )
      .setHeading();

    let testUrl = "";
    new Setting(containerEl)
      .setName("Test a link")
      .setDesc("Paste an intranet URL to see how many cookies Chrome has for it and the title it gets.")
      .addText((text) =>
        text.setPlaceholder("https://…").onChange((value) => {
          testUrl = value.trim();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          if (!testUrl) return;
          btn.setButtonText("Testing…").setDisabled(true);
          try {
            retryChromeKey();
            const cookies = await chromeCookiesFor(testUrl);
            const title = await this.plugin.fetchUrlTitle(testUrl);
            const source = cookies
              ? `${cookies.count} cookies from Chrome`
              : "no Chrome cookies for this site";
            new Notice(`${source}\nTitle: ${title}`, 10000);
          } catch (error) {
            new Notice(`Chrome cookies — ${(error as Error).message}`, 12000);
          } finally {
            btn.setButtonText("Test").setDisabled(false);
          }
        })
      );
  }
}
