import { App, TFile, normalizePath } from "obsidian";

import { GitHubApiClient } from "./github-api";
import {
	cloneCounters,
	formatTimestamp,
	getFileExtension,
	getRelativePath,
	hashText,
	isConflictArtifact,
	joinPath,
	parseExcludedPrefixes,
	parseExtensions,
	sanitizeDeviceName,
	summarizeCounters,
} from "./utils";
import type { BranchSnapshot, GitHubSyncSettings, SyncCounters, SyncResult } from "./types";

interface PendingUpload {
	vaultPath: string;
	repoPath: string;
	content: string;
	localHash: string;
}

interface PendingDownload {
	vaultPath: string;
	remoteSha: string;
}

interface PendingDelete {
	vaultPath: string;
	repoPath: string;
}

interface PendingRename {
	fromVaultPath: string;
	toVaultPath: string;
}

interface CommitOutcome {
	uploadedShas: Map<string, string>;
}

interface SyncOptions {
	allowWrite?: boolean;
}

const FAST_FORWARD_RETRY_LIMIT = 3;

export class SyncEngine {
	private suppressVaultEvents = 0;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => GitHubSyncSettings,
		private readonly saveSettings: () => Promise<void>,
	) {}

	shouldIgnoreVaultEvents(): boolean {
		return this.suppressVaultEvents > 0;
	}

	isSyncCandidate(path: string): boolean {
		return this.shouldSyncPath(path);
	}

	async validateConnection(): Promise<SyncResult> {
		const settings = this.getSettings();
		this.ensureConfigured(settings);

		const client = new GitHubApiClient(settings);
		await client.validateRepository();
		await client.getBranchSnapshot();

		return {
			mode: "validate",
			counters: cloneCounters(),
		};
	}

	async initializeFromRemote(): Promise<SyncResult> {
		const settings = this.getSettings();
		this.ensureConfigured(settings);
		const nextStates = {} as GitHubSyncSettings["fileStates"];

		const client = new GitHubApiClient(settings);
		const snapshot = await client.getBranchSnapshot();
		const counters = cloneCounters();

		for (const remote of snapshot.files.values()) {
			if (!this.shouldSyncPath(remote.vaultPath)) {
				continue;
			}

			const remoteContent = await client.getBlobText(remote.sha);
			const remoteHash = await hashText(remoteContent);
			const localFile = this.getLocalFile(remote.vaultPath);

			if (localFile) {
				const localContent = await this.app.vault.cachedRead(localFile);
				const localHash = await hashText(localContent);
				if (localHash !== remoteHash && settings.createConflictCopies) {
					await this.writeConflictCopy(remote.vaultPath, localContent, "local");
					counters.conflicts += 1;
				}
			}

			await this.writeVaultFile(remote.vaultPath, remoteContent);
			nextStates[remote.vaultPath] = {
				localHash: remoteHash,
				remoteSha: remote.sha,
			};
			counters.downloaded += 1;
		}

		settings.fileStates = nextStates;
		settings.pendingRenames = {};
		settings.initialized = true;
		settings.lastSyncAt = new Date().toISOString();
		await this.saveSettings();

		return {
			mode: "pull",
			counters,
		};
	}

	async pushLocalSnapshot(): Promise<SyncResult> {
		return this.withFastForwardRetry(() => this.pushLocalSnapshotOnce());
	}

	async sync(options?: SyncOptions): Promise<SyncResult> {
		return this.withFastForwardRetry(() => this.syncOnce(options));
	}

	private async pushLocalSnapshotOnce(): Promise<SyncResult> {
		const settings = this.getSettings();
		this.ensureConfigured(settings);
		const nextStates = {} as GitHubSyncSettings["fileStates"];

		const snapshot = await new GitHubApiClient(settings).getBranchSnapshot();
		const counters = cloneCounters();
		const uploads = await this.collectUploadsFromLocal();

		if (uploads.length > 0) {
			const commitOutcome = await this.commitRemoteChanges(snapshot, uploads, [], "Initial vault push");
			for (const upload of uploads) {
				nextStates[upload.vaultPath] = {
					localHash: upload.localHash,
					remoteSha: commitOutcome.uploadedShas.get(upload.vaultPath) ?? null,
				};
				counters.uploaded += 1;
			}
		}

		settings.fileStates = nextStates;
		settings.pendingRenames = {};
		settings.initialized = true;
		settings.lastSyncAt = new Date().toISOString();
		await this.saveSettings();

		return {
			mode: "push",
			counters,
		};
	}

	private async syncOnce(options?: SyncOptions): Promise<SyncResult> {
		const settings = this.getSettings();
		this.ensureConfigured(settings);
		const allowWrite = options?.allowWrite ?? true;

		if (!settings.initialized) {
			throw new Error("먼저 초기 Pull 또는 Push를 한 번 실행해야 합니다.");
		}

		const client = new GitHubApiClient(settings);
		const snapshot = await client.getBranchSnapshot();
		const localFiles = this.collectLocalFiles();
		const counters = cloneCounters();
		const uploads: PendingUpload[] = [];
		const downloads: PendingDownload[] = [];
		const deletes: PendingDelete[] = [];
		const remoteContentCache = new Map<string, string>();
		const nextState = { ...settings.fileStates };
		const processedPaths = new Set<string>();

		if (allowWrite) {
			const renameOperations = await this.collectPendingRenames(
				snapshot,
				localFiles,
				remoteContentCache,
				counters,
			);
			for (const rename of renameOperations) {
				processedPaths.add(rename.fromVaultPath);
				processedPaths.add(rename.toVaultPath);
			}

			const renameUploads = await this.buildUploadsForRenames(localFiles, renameOperations);
			for (const upload of renameUploads) {
				uploads.push(upload);
				delete nextState[this.findRenameSourcePath(renameOperations, upload.vaultPath)];
			}

			for (const rename of renameOperations) {
				const remote = snapshot.files.get(rename.fromVaultPath);
				if (remote) {
					deletes.push({
						repoPath: remote.repoPath,
						vaultPath: rename.fromVaultPath,
					});
				}
				delete nextState[rename.fromVaultPath];
			}
		}

		const candidatePaths = new Set<string>([
			...snapshot.files.keys(),
			...localFiles.keys(),
			...Object.keys(settings.fileStates),
		]);

		for (const vaultPath of Array.from(candidatePaths).sort()) {
			if (processedPaths.has(vaultPath)) {
				continue;
			}

			if (!this.shouldSyncPath(vaultPath)) {
				delete nextState[vaultPath];
				continue;
			}

			const localFile = localFiles.get(vaultPath) ?? null;
			const remote = snapshot.files.get(vaultPath) ?? null;
			const previous = settings.fileStates[vaultPath];
			const localContent = localFile ? await this.app.vault.cachedRead(localFile) : null;
			const localHash = localContent ? await hashText(localContent) : null;

			if (!allowWrite) {
				if (localFile && remote) {
					const remoteContent = await this.getRemoteContent(client, remoteContentCache, remote.sha);
					const remoteHash = await hashText(remoteContent);

					if (remoteHash === localHash) {
						nextState[vaultPath] = { localHash, remoteSha: remote.sha };
						counters.unchanged += 1;
					} else {
						if (settings.createConflictCopies && localContent !== null) {
							await this.writeConflictCopy(vaultPath, localContent, "local");
							counters.conflicts += 1;
						}

						await this.writeVaultFile(vaultPath, remoteContent);
						nextState[vaultPath] = {
							localHash: remoteHash,
							remoteSha: remote.sha,
						};
						counters.downloaded += 1;
					}
					continue;
				}

				if (localFile && !remote) {
					if (!previous || previous.remoteSha === null) {
						nextState[vaultPath] = {
							localHash,
							remoteSha: previous?.remoteSha ?? null,
						};
						counters.unchanged += 1;
					} else {
						if (settings.createConflictCopies && localContent !== null && localHash !== previous.localHash) {
							await this.writeConflictCopy(vaultPath, localContent, "local");
							counters.conflicts += 1;
						}

						await this.deleteVaultPath(vaultPath);
						delete nextState[vaultPath];
						counters.deletedLocal += 1;
					}
					continue;
				}

				if (!localFile && remote) {
					downloads.push({ remoteSha: remote.sha, vaultPath });
					continue;
				}

				delete nextState[vaultPath];
				continue;
			}

			if (localFile && remote) {
				if (!previous) {
					const remoteContent = await this.getRemoteContent(client, remoteContentCache, remote.sha);
					const remoteHash = await hashText(remoteContent);

					if (remoteHash === localHash) {
						nextState[vaultPath] = { localHash, remoteSha: remote.sha };
						counters.unchanged += 1;
					} else {
						if (settings.createConflictCopies) {
							await this.writeConflictCopy(vaultPath, remoteContent, "remote");
						}
						counters.conflicts += 1;
						uploads.push({
							content: localContent ?? "",
							localHash: localHash ?? "",
							repoPath: remote.repoPath,
							vaultPath,
						});
					}
					continue;
				}

				const localChanged = localHash !== previous.localHash;
				const remoteChanged = remote.sha !== previous.remoteSha;

				if (!localChanged && !remoteChanged) {
					nextState[vaultPath] = { localHash, remoteSha: remote.sha };
					counters.unchanged += 1;
					continue;
				}

				if (localChanged && !remoteChanged) {
					uploads.push({
						content: localContent ?? "",
						localHash: localHash ?? "",
						repoPath: remote.repoPath,
						vaultPath,
					});
					continue;
				}

				if (!localChanged && remoteChanged) {
					downloads.push({ remoteSha: remote.sha, vaultPath });
					continue;
				}

				const remoteContent = await this.getRemoteContent(client, remoteContentCache, remote.sha);
				const remoteHash = await hashText(remoteContent);

				if (remoteHash === localHash) {
					nextState[vaultPath] = { localHash, remoteSha: remote.sha };
					counters.unchanged += 1;
				} else {
					if (settings.createConflictCopies) {
						await this.writeConflictCopy(vaultPath, remoteContent, "remote");
					}
					counters.conflicts += 1;
					uploads.push({
						content: localContent ?? "",
						localHash: localHash ?? "",
						repoPath: remote.repoPath,
						vaultPath,
					});
				}
				continue;
			}

			if (localFile && !remote) {
				if (!previous) {
					uploads.push({
						content: localContent ?? "",
						localHash: localHash ?? "",
						repoPath: this.toRepoPath(vaultPath),
						vaultPath,
					});
				} else if (previous.remoteSha === null) {
					if (localHash === previous.localHash) {
						nextState[vaultPath] = {
							localHash,
							remoteSha: null,
						};
						counters.unchanged += 1;
					} else {
						uploads.push({
							content: localContent ?? "",
							localHash: localHash ?? "",
							repoPath: this.toRepoPath(vaultPath),
							vaultPath,
						});
					}
				} else if (localHash !== previous.localHash) {
					uploads.push({
						content: localContent ?? "",
						localHash: localHash ?? "",
						repoPath: this.toRepoPath(vaultPath),
						vaultPath,
					});
				} else {
					await this.deleteVaultPath(vaultPath);
					delete nextState[vaultPath];
					counters.deletedLocal += 1;
				}
				continue;
			}

			if (!localFile && remote) {
				if (!previous || previous.remoteSha === null) {
					downloads.push({ remoteSha: remote.sha, vaultPath });
				} else if (remote.sha !== previous.remoteSha) {
					downloads.push({ remoteSha: remote.sha, vaultPath });
				} else {
					deletes.push({ repoPath: remote.repoPath, vaultPath });
				}
				continue;
			}

			delete nextState[vaultPath];
		}

		for (const download of downloads) {
			const remoteContent = await this.getRemoteContent(client, remoteContentCache, download.remoteSha);
			const remoteHash = await hashText(remoteContent);
			await this.writeVaultFile(download.vaultPath, remoteContent);
			nextState[download.vaultPath] = {
				localHash: remoteHash,
				remoteSha: download.remoteSha,
			};
			counters.downloaded += 1;
		}

		if (uploads.length > 0 || deletes.length > 0) {
			const commitOutcome = await this.commitRemoteChanges(
				snapshot,
				uploads,
				deletes,
				this.buildCommitMessage(uploads, deletes, counters),
			);

			for (const upload of uploads) {
				nextState[upload.vaultPath] = {
					localHash: upload.localHash,
					remoteSha: commitOutcome.uploadedShas.get(upload.vaultPath) ?? null,
				};
				counters.uploaded += 1;
			}

			for (const deletion of deletes) {
				delete nextState[deletion.vaultPath];
				counters.deletedRemote += 1;
			}
		}

		settings.fileStates = nextState;
		settings.pendingRenames = {};
		settings.lastSyncAt = new Date().toISOString();
		await this.saveSettings();

		return {
			mode: "sync",
			counters,
		};
	}

	private async withFastForwardRetry<T>(operation: () => Promise<T>): Promise<T> {
		let lastError: unknown;

		for (let attempt = 1; attempt <= FAST_FORWARD_RETRY_LIMIT; attempt += 1) {
			try {
				return await operation();
			} catch (error) {
				lastError = error;
				if (!isFastForwardError(error) || attempt === FAST_FORWARD_RETRY_LIMIT) {
					throw error;
				}
			}
		}

		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	private ensureConfigured(settings: GitHubSyncSettings): void {
		if (!settings.githubOwner || !settings.githubRepo || !settings.githubBranch || !settings.githubToken) {
			throw new Error("GitHub owner, repo, branch, token 설정이 모두 필요합니다.");
		}
	}

	private collectLocalFiles(): Map<string, TFile> {
		const files = new Map<string, TFile>();
		for (const file of this.app.vault.getFiles()) {
			if (this.shouldSyncPath(file.path)) {
				files.set(file.path, file);
			}
		}
		return files;
	}

	private async collectUploadsFromLocal(): Promise<PendingUpload[]> {
		const uploads: PendingUpload[] = [];
		for (const file of this.app.vault.getFiles()) {
			if (!this.shouldSyncPath(file.path)) {
				continue;
			}
			const content = await this.app.vault.cachedRead(file);
			uploads.push({
				content,
				localHash: await hashText(content),
				repoPath: this.toRepoPath(file.path),
				vaultPath: file.path,
			});
		}
		return uploads;
	}

	private shouldSyncPath(path: string): boolean {
		const settings = this.getSettings();
		const normalized = normalizePath(path);

		if (isConflictArtifact(normalized)) {
			return false;
		}

		const relativePath = getRelativePath(settings.vaultBasePath, normalized);

		if (relativePath === null || relativePath === "") {
			return false;
		}

		const extension = getFileExtension(normalized);
		if (!parseExtensions(settings.includeExtensions).has(extension)) {
			return false;
		}

		for (const excludedPrefix of parseExcludedPrefixes(settings.excludePaths)) {
			const trimmedPrefix = excludedPrefix.slice(0, -1);
			if (
				normalized === trimmedPrefix ||
				normalized.startsWith(excludedPrefix) ||
				relativePath === trimmedPrefix ||
				relativePath.startsWith(excludedPrefix)
			) {
				return false;
			}
		}

		return true;
	}

	private getLocalFile(vaultPath: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		return file instanceof TFile ? file : null;
	}

	private toRepoPath(vaultPath: string): string {
		const relativePath = getRelativePath(this.getSettings().vaultBasePath, vaultPath);
		if (relativePath === null || relativePath === "") {
			throw new Error(`Vault path is outside sync root: ${vaultPath}`);
		}
		return joinPath(this.getSettings().repoBasePath, relativePath);
	}

	private async getRemoteContent(client: GitHubApiClient, cache: Map<string, string>, sha: string): Promise<string> {
		const cached = cache.get(sha);
		if (cached !== undefined) {
			return cached;
		}

		const content = await client.getBlobText(sha);
		cache.set(sha, content);
		return content;
	}

	private async collectPendingRenames(
		snapshot: BranchSnapshot,
		localFiles: Map<string, TFile>,
		remoteContentCache: Map<string, string>,
		counters: SyncCounters,
	): Promise<PendingRename[]> {
		const settings = this.getSettings();
		const renameOperations: PendingRename[] = [];

		for (const [fromPath, toPath] of Object.entries(settings.pendingRenames)) {
			const fromVaultPath = normalizePath(fromPath);
			const toVaultPath = normalizePath(toPath);

			if (!fromVaultPath || !toVaultPath || fromVaultPath === toVaultPath) {
				continue;
			}

			const localTargetFile = localFiles.get(toVaultPath) ?? null;
			const remoteTarget = snapshot.files.get(toVaultPath) ?? null;

			if (!this.shouldSyncPath(fromVaultPath) && !this.shouldSyncPath(toVaultPath)) {
				continue;
			}

			if (!localTargetFile || !this.shouldSyncPath(toVaultPath)) {
				renameOperations.push({ fromVaultPath, toVaultPath });
				continue;
			}

			if (remoteTarget) {
				const localContent = await this.app.vault.cachedRead(localTargetFile);
				const localHash = await hashText(localContent);
				const remoteContent = await this.getRemoteContent(
					new GitHubApiClient(settings),
					remoteContentCache,
					remoteTarget.sha,
				);
				const remoteHash = await hashText(remoteContent);

				if (remoteHash !== localHash && settings.createConflictCopies) {
					await this.writeConflictCopy(toVaultPath, remoteContent, "remote");
					counters.conflicts += 1;
				}
			}

			renameOperations.push({ fromVaultPath, toVaultPath });
		}

		return renameOperations;
	}

	private async buildUploadsForRenames(
		localFiles: Map<string, TFile>,
		renameOperations: PendingRename[],
	): Promise<PendingUpload[]> {
		const uploads: PendingUpload[] = [];

		for (const rename of renameOperations) {
			const localFile = localFiles.get(rename.toVaultPath);
			if (!localFile || !this.shouldSyncPath(rename.toVaultPath)) {
				continue;
			}

			const content = await this.app.vault.cachedRead(localFile);
			uploads.push({
				content,
				localHash: await hashText(content),
				repoPath: this.toRepoPath(rename.toVaultPath),
				vaultPath: rename.toVaultPath,
			});
		}

		return uploads;
	}

	private findRenameSourcePath(renameOperations: PendingRename[], targetVaultPath: string): string {
		const matchedRename = renameOperations.find((rename) => rename.toVaultPath === targetVaultPath);
		return matchedRename?.fromVaultPath ?? targetVaultPath;
	}

	private async commitRemoteChanges(
		snapshot: BranchSnapshot,
		uploads: PendingUpload[],
		deletes: PendingDelete[],
		message: string,
	): Promise<CommitOutcome> {
		const client = new GitHubApiClient(this.getSettings());
		const treeEntries = [
			...uploads.map((upload) => ({
				content: upload.content,
				mode: "100644" as const,
				path: upload.repoPath,
				type: "blob" as const,
			})),
			...deletes.map((deletion) => ({
				mode: "100644" as const,
				path: deletion.repoPath,
				sha: null,
				type: "blob" as const,
			})),
		];
		const tree = await client.createTree(snapshot.treeSha, treeEntries);
		const commit = await client.createCommit(message, tree.sha, snapshot.commitSha);
		await client.updateBranchReference(commit.sha);
		const refreshedSnapshot = await client.getBranchSnapshot();

		const uploadedShas = new Map<string, string>();
		for (const upload of uploads) {
			const remoteFile = refreshedSnapshot.files.get(upload.vaultPath);
			if (remoteFile?.sha) {
				uploadedShas.set(upload.vaultPath, remoteFile.sha);
			}
		}

		return { uploadedShas };
	}

	private buildCommitMessage(
		uploads: PendingUpload[],
		deletes: PendingDelete[],
		counters: SyncCounters,
	): string {
		const device = this.getSettings().deviceName.trim() || "device";
		const parts: string[] = [];

		if (uploads.length > 0) {
			parts.push(`upload ${uploads.length}`);
		}
		if (deletes.length > 0) {
			parts.push(`delete ${deletes.length}`);
		}
		if (counters.conflicts > 0) {
			parts.push(`conflict ${counters.conflicts}`);
		}

		return `Vault sync from ${device}: ${parts.join(", ") || "metadata refresh"}`;
	}

	private async writeVaultFile(vaultPath: string, content: string): Promise<void> {
		const existingFile = this.getLocalFile(vaultPath);
		await this.withSuppressedVaultEvents(async () => {
			await this.ensureFolder(joinPath(...vaultPath.split("/").slice(0, -1)));
			if (existingFile) {
				await this.app.vault.modify(existingFile, content);
			} else {
				await this.app.vault.create(vaultPath, content);
			}
		});
	}

	private async writeConflictCopy(originalPath: string, content: string, source: "local" | "remote"): Promise<void> {
		const deviceName = sanitizeDeviceName(this.getSettings().deviceName);
		const timestamp = formatTimestamp(new Date());
		const extension = originalPath.includes(".") ? originalPath.slice(originalPath.lastIndexOf(".")) : "";
		const basePath = extension ? originalPath.slice(0, -extension.length) : originalPath;

		let candidate = normalizePath(`${basePath}.conflict-${source}-${deviceName}-${timestamp}${extension}`);
		let counter = 1;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = normalizePath(`${basePath}.conflict-${source}-${deviceName}-${timestamp}-${counter}${extension}`);
			counter += 1;
		}

		await this.writeVaultFile(candidate, content);
	}

	private async deleteVaultPath(vaultPath: string): Promise<void> {
		const file = this.getLocalFile(vaultPath);
		if (!file) {
			return;
		}

		await this.withSuppressedVaultEvents(async () => {
			await this.app.vault.delete(file);
		});
	}

	private async ensureFolder(path: string): Promise<void> {
		if (!path) {
			return;
		}

		let current = "";
		for (const segment of normalizePath(path).split("/")) {
			current = current ? `${current}/${segment}` : segment;
			if (await this.app.vault.adapter.exists(current)) {
				continue;
			}
			await this.app.vault.createFolder(current);
		}
	}

	private async withSuppressedVaultEvents<T>(operation: () => Promise<T>): Promise<T> {
		this.suppressVaultEvents += 1;
		try {
			return await operation();
		} finally {
			this.suppressVaultEvents -= 1;
		}
	}
}

export function formatResult(result: SyncResult): string {
	return summarizeCounters(result.counters);
}

function isFastForwardError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	return /update is not a fast forward|not a fast forward/i.test(error.message);
}
