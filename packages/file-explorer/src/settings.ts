export interface PinnedItem {
	path: string;
	type: "file" | "folder";
	name: string;
	order: number; // Order for sorting pinned items
}

export interface MyPluginSettings {
	pinnedItems: PinnedItem[];
	showFolderNotes: boolean;
	showFileCount: boolean;
	/** Whether hidden items are currently invisible (true) or revealed (false) */
	hideFiles: boolean;
	/** Vault-relative paths to hide (e.g. "folder/subfolder", "notes/secret.md") */
	hiddenPaths: string[];
	/** Wildcard name patterns to hide at any depth (e.g. "attachments") */
	hiddenPatterns: string[];
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	pinnedItems: [],
	showFolderNotes: true,
	showFileCount: true,
	hideFiles: true,
	hiddenPaths: [],
	hiddenPatterns: [],
};

