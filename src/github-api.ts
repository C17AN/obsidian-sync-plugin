import { requestUrl } from "obsidian";

import { getRelativePath, joinPath, normalizeFolder } from "./utils";
import type { BranchSnapshot, GitHubSyncSettings, RemoteFileEntry } from "./types";

interface GitReferenceResponse {
	object: {
		sha: string;
		type: string;
	};
}

interface GitCommitResponse {
	sha: string;
	tree: {
		sha: string;
	};
}

interface GitTreeEntryResponse {
	path: string;
	mode: string;
	type: string;
	sha: string | null;
	size?: number;
}

interface GitTreeResponse {
	sha: string;
	tree: GitTreeEntryResponse[];
	truncated: boolean;
}

interface GitBlobResponse {
	content: string;
	encoding: string;
	sha: string;
}

interface RepositoryResponse {
	default_branch: string;
	private: boolean;
	full_name: string;
}

interface CreateTreeEntry {
	path: string;
	mode: "100644";
	type: "blob";
	sha?: string | null;
	content?: string;
}

interface CreateTreeResponse {
	sha: string;
	tree: GitTreeEntryResponse[];
}

interface CreateCommitResponse {
	sha: string;
}

export class GitHubApiClient {
	private readonly apiBaseUrl = "https://api.github.com";
	private readonly apiVersion = "2022-11-28";

	constructor(private readonly settings: GitHubSyncSettings) {}

	async validateRepository(): Promise<RepositoryResponse> {
		return this.request<RepositoryResponse>("GET", this.buildRepoPath());
	}

	async getBranchSnapshot(): Promise<BranchSnapshot> {
		const reference = await this.request<GitReferenceResponse>(
			"GET",
			`${this.buildRepoPath()}/git/ref/heads/${this.encodeRef(this.settings.githubBranch)}`,
		);
		const commit = await this.request<GitCommitResponse>(
			"GET",
			`${this.buildRepoPath()}/git/commits/${reference.object.sha}`,
		);
		const tree = await this.request<GitTreeResponse>(
			"GET",
			`${this.buildRepoPath()}/git/trees/${commit.tree.sha}?recursive=1`,
		);

		if (tree.truncated) {
			throw new Error("GitHub tree response was truncated. Narrow the sync folder before retrying.");
		}

		const files = new Map<string, RemoteFileEntry>();
		const repoBasePath = normalizeFolder(this.settings.repoBasePath);

		for (const entry of tree.tree) {
			if (entry.type !== "blob" || !entry.sha) {
				continue;
			}

			const relativePath = getRelativePath(repoBasePath, entry.path);
			if (relativePath === null || relativePath === "") {
				continue;
			}

			const vaultPath = joinPath(this.settings.vaultBasePath, relativePath);
			files.set(vaultPath, {
				repoPath: entry.path,
				vaultPath,
				sha: entry.sha,
				size: entry.size ?? 0,
			});
		}

		return {
			commitSha: reference.object.sha,
			treeSha: commit.tree.sha,
			files,
		};
	}

	async getBlobText(sha: string): Promise<string> {
		const response = await this.request<GitBlobResponse>(
			"GET",
			`${this.buildRepoPath()}/git/blobs/${encodeURIComponent(sha)}`,
		);

		if (response.encoding !== "base64") {
			throw new Error(`Unsupported blob encoding: ${response.encoding}`);
		}

		return decodeBase64(response.content);
	}

	async createTree(baseTreeSha: string, entries: CreateTreeEntry[]): Promise<CreateTreeResponse> {
		return this.request<CreateTreeResponse>("POST", `${this.buildRepoPath()}/git/trees`, {
			base_tree: baseTreeSha,
			tree: entries,
		});
	}

	async createCommit(message: string, treeSha: string, parentCommitSha: string): Promise<CreateCommitResponse> {
		return this.request<CreateCommitResponse>("POST", `${this.buildRepoPath()}/git/commits`, {
			message,
			parents: [parentCommitSha],
			tree: treeSha,
		});
	}

	async updateBranchReference(commitSha: string): Promise<void> {
		await this.request(
			"PATCH",
			`${this.buildRepoPath()}/git/refs/heads/${this.encodeRef(this.settings.githubBranch)}`,
			{
				force: false,
				sha: commitSha,
			},
		);
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await requestUrl({
			body: body ? JSON.stringify(body) : undefined,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${this.settings.githubToken}`,
				"Content-Type": "application/json",
				"X-GitHub-Api-Version": this.apiVersion,
			},
			method,
			throw: false,
			url: `${this.apiBaseUrl}${path}`,
		});

		if (response.status >= 400) {
			const payload = response.json ?? safeJsonParse(response.text);
			const message =
				typeof (payload as { message?: unknown } | undefined)?.message === "string"
					? (payload as { message: string }).message
					: response.text || `GitHub API request failed with status ${response.status}`;
			throw new Error(message);
		}

		if (!response.text) {
			return undefined as T;
		}

		return (response.json ?? safeJsonParse(response.text)) as T;
	}

	private buildRepoPath(): string {
		return `/repos/${encodeURIComponent(this.settings.githubOwner)}/${encodeURIComponent(this.settings.githubRepo)}`;
	}

	private encodeRef(ref: string): string {
		return ref
			.split("/")
			.map((part) => encodeURIComponent(part))
			.join("/");
	}
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function decodeBase64(content: string): string {
	const normalized = content.replace(/\n/g, "");
	const binary = atob(normalized);
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}
