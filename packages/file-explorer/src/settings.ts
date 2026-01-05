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
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	pinnedItems: [],
	showFolderNotes: true,
	showFileCount: true,
};

