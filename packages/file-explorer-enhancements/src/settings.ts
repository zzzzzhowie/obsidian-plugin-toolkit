export interface PinnedItem {
	path: string;
	type: "file" | "folder";
	name: string;
	order: number; // Order for sorting pinned items
}

export interface FileExplorerSettings {
	pinnedItems: PinnedItem[];
	showFolderNotes: boolean;
	showFileCount: boolean;
	/** Whether hidden items are currently invisible (true) or revealed (false) */
	hideFiles: boolean;
	/** Vault-relative paths to hide (e.g. "folder/subfolder", "notes/secret.md") */
	hiddenPaths: string[];
	/** Wildcard name patterns to hide at any depth (e.g. "attachments") */
	hiddenPatterns: string[];
	/** Whether the pinned section is folded to its header. In data.json, so it follows the vault to every device. */
	pinnedCollapsed: boolean;
}

export const DEFAULT_SETTINGS: FileExplorerSettings = {
	pinnedItems: [],
	showFolderNotes: true,
	showFileCount: true,
	hideFiles: true,
	hiddenPaths: [],
	hiddenPatterns: [],
	pinnedCollapsed: false,
};

