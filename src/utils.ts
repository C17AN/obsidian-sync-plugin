import { normalizePath } from "obsidian";

import type { GitHubSyncSettings, SyncCounters } from "./types";

export const DEFAULT_SETTINGS: GitHubSyncSettings = {
	githubOwner: "",
	githubRepo: "",
	githubBranch: "main",
	githubToken: "",
	repoBasePath: "",
	vaultBasePath: "",
	includeExtensions: ".md, .canvas, .txt",
	excludePaths: ".obsidian/, .git/, node_modules/",
	autoSyncOnSave: true,
	autoSyncIntervalMinutes: 5,
	syncOnStartup: false,
	createConflictCopies: true,
	deviceName: "Current device",
	uiLanguage: "ko",
	initialized: false,
	lastSyncAt: "",
	fileStates: {},
	pendingRenames: {},
};

export function cloneCounters(): SyncCounters {
	return {
		uploaded: 0,
		downloaded: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		conflicts: 0,
		unchanged: 0,
	};
}

export function normalizeFolder(value: string): string {
	const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
	return trimmed ? normalizePath(trimmed) : "";
}

export function normalizeOptionalPath(value: string): string {
	const trimmed = value.trim();
	return trimmed ? normalizePath(trimmed) : "";
}

export function joinPath(...parts: string[]): string {
	const filtered = parts.map((part) => part.trim()).filter(Boolean);
	return filtered.length > 0 ? normalizePath(filtered.join("/")) : "";
}

export function getRelativePath(root: string, target: string): string | null {
	const normalizedRoot = normalizeFolder(root);
	const normalizedTarget = normalizePath(target);

	if (!normalizedRoot) {
		return normalizedTarget;
	}

	if (normalizedTarget === normalizedRoot) {
		return "";
	}

	if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
		return normalizedTarget.slice(normalizedRoot.length + 1);
	}

	return null;
}

export function splitCsv(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function parseExtensions(value: string): Set<string> {
	return new Set(
		splitCsv(value).map((entry) => entry.replace(/^\./, "").toLowerCase()),
	);
}

export function parseExcludedPrefixes(value: string): string[] {
	return splitCsv(value)
		.map((entry) => normalizeOptionalPath(entry))
		.filter(Boolean)
		.map((entry) => (entry.endsWith("/") ? entry : `${entry}/`));
}

export function getFileExtension(path: string): string {
	const match = path.match(/\.([^.\/]+)$/);
	return match ? match[1].toLowerCase() : "";
}

export function isConflictArtifact(path: string): boolean {
	return /(^|\/)[^/]+\.conflict-[^/]+\.[^/.]+$/i.test(normalizePath(path));
}

export function formatTimestamp(date: Date): string {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

export async function hashText(content: string): Promise<string> {
	const payload = new TextEncoder().encode(content);
	const digest = await crypto.subtle.digest("SHA-256", payload);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function sanitizeDeviceName(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\-._]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "device"
	);
}

export function summarizeCounters(counters: SyncCounters): string {
	return [
		`uploaded ${counters.uploaded}`,
		`downloaded ${counters.downloaded}`,
		`deleted(local) ${counters.deletedLocal}`,
		`deleted(remote) ${counters.deletedRemote}`,
		`conflicts ${counters.conflicts}`,
		`unchanged ${counters.unchanged}`,
	].join(", ");
}

export function mergePendingRename(
	pendingRenames: Record<string, string>,
	oldPath: string,
	newPath: string,
): Record<string, string> {
	const normalizedOldPath = normalizePath(oldPath);
	const normalizedNewPath = normalizePath(newPath);

	if (!normalizedOldPath || !normalizedNewPath || normalizedOldPath === normalizedNewPath) {
		return { ...pendingRenames };
	}

	const nextPendingRenames = { ...pendingRenames };
	let sourcePath = normalizedOldPath;

	for (const [fromPath, toPath] of Object.entries(nextPendingRenames)) {
		if (normalizePath(toPath) === normalizedOldPath) {
			sourcePath = normalizePath(fromPath);
			delete nextPendingRenames[fromPath];
			break;
		}
	}

	delete nextPendingRenames[normalizedOldPath];

	if (sourcePath === normalizedNewPath) {
		return nextPendingRenames;
	}

	nextPendingRenames[sourcePath] = normalizedNewPath;
	return nextPendingRenames;
}

export interface ParsedRepositoryInput {
	owner: string | null;
	repo: string;
}

export function parseGitHubRepositoryInput(value: string): ParsedRepositoryInput | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	const normalized = trimmed.replace(/\.git$/i, "").replace(/\/+$/, "");

	if (/^https?:\/\//i.test(normalized)) {
		try {
			const url = new URL(normalized);
			if (url.hostname !== "github.com") {
				return { owner: null, repo: trimmed };
			}

			const segments = url.pathname.split("/").filter(Boolean);
			if (segments.length >= 2) {
				return {
					owner: segments[0],
					repo: segments[1],
				};
			}
		} catch {
			return { owner: null, repo: trimmed };
		}
	}

	const segments = normalized.split("/").filter(Boolean);
	if (segments.length >= 2) {
		return {
			owner: segments[0],
			repo: segments[1],
		};
	}

	return {
		owner: null,
		repo: normalized,
	};
}
