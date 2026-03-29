export interface FileSyncState {
	localHash: string | null;
	remoteSha: string | null;
}

export interface GitHubSyncSettings {
	githubOwner: string;
	githubRepo: string;
	githubBranch: string;
	githubToken: string;
	repoBasePath: string;
	vaultBasePath: string;
	includeExtensions: string;
	excludePaths: string;
	autoSyncOnSave: boolean;
	autoSyncIntervalMinutes: number;
	syncOnStartup: boolean;
	createConflictCopies: boolean;
	deviceName: string;
	initialized: boolean;
	lastSyncAt: string;
	fileStates: Record<string, FileSyncState>;
}

export interface RemoteFileEntry {
	repoPath: string;
	vaultPath: string;
	sha: string;
	size: number;
}

export interface BranchSnapshot {
	commitSha: string;
	treeSha: string;
	files: Map<string, RemoteFileEntry>;
}

export interface SyncCounters {
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
	unchanged: number;
}

export interface SyncResult {
	mode: "sync" | "pull" | "push" | "validate";
	counters: SyncCounters;
}
