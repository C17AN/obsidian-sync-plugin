"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => GitHubVaultSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");

// src/sync-engine.ts
var import_obsidian3 = require("obsidian");

// src/github-api.ts
var import_obsidian2 = require("obsidian");

// src/utils.ts
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
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
  initialized: false,
  lastSyncAt: "",
  fileStates: {}
};
function cloneCounters() {
  return {
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: 0,
    unchanged: 0
  };
}
function normalizeFolder(value) {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? (0, import_obsidian.normalizePath)(trimmed) : "";
}
function normalizeOptionalPath(value) {
  const trimmed = value.trim();
  return trimmed ? (0, import_obsidian.normalizePath)(trimmed) : "";
}
function joinPath(...parts) {
  const filtered = parts.map((part) => part.trim()).filter(Boolean);
  return filtered.length > 0 ? (0, import_obsidian.normalizePath)(filtered.join("/")) : "";
}
function getRelativePath(root, target) {
  const normalizedRoot = normalizeFolder(root);
  const normalizedTarget = (0, import_obsidian.normalizePath)(target);
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
function splitCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
function parseExtensions(value) {
  return new Set(
    splitCsv(value).map((entry) => entry.replace(/^\./, "").toLowerCase())
  );
}
function parseExcludedPrefixes(value) {
  return splitCsv(value).map((entry) => normalizeOptionalPath(entry)).filter(Boolean).map((entry) => entry.endsWith("/") ? entry : `${entry}/`);
}
function getFileExtension(path) {
  const match = path.match(/\.([^.\/]+)$/);
  return match ? match[1].toLowerCase() : "";
}
function formatTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}
async function hashText(content) {
  const payload = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function sanitizeDeviceName(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9\-._]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "device";
}
function summarizeCounters(counters) {
  return [
    `uploaded ${counters.uploaded}`,
    `downloaded ${counters.downloaded}`,
    `deleted(local) ${counters.deletedLocal}`,
    `deleted(remote) ${counters.deletedRemote}`,
    `conflicts ${counters.conflicts}`,
    `unchanged ${counters.unchanged}`
  ].join(", ");
}

// src/github-api.ts
var GitHubApiClient = class {
  constructor(settings) {
    this.settings = settings;
    this.apiBaseUrl = "https://api.github.com";
    this.apiVersion = "2022-11-28";
  }
  async validateRepository() {
    return this.request("GET", this.buildRepoPath());
  }
  async getBranchSnapshot() {
    const reference = await this.request(
      "GET",
      `${this.buildRepoPath()}/git/ref/heads/${this.encodeRef(this.settings.githubBranch)}`
    );
    const commit = await this.request(
      "GET",
      `${this.buildRepoPath()}/git/commits/${reference.object.sha}`
    );
    const tree = await this.request(
      "GET",
      `${this.buildRepoPath()}/git/trees/${commit.tree.sha}?recursive=1`
    );
    if (tree.truncated) {
      throw new Error("GitHub tree response was truncated. Narrow the sync folder before retrying.");
    }
    const files = /* @__PURE__ */ new Map();
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
        size: entry.size ?? 0
      });
    }
    return {
      commitSha: reference.object.sha,
      treeSha: commit.tree.sha,
      files
    };
  }
  async getBlobText(sha) {
    const response = await this.request(
      "GET",
      `${this.buildRepoPath()}/git/blobs/${encodeURIComponent(sha)}`
    );
    if (response.encoding !== "base64") {
      throw new Error(`Unsupported blob encoding: ${response.encoding}`);
    }
    return decodeBase64(response.content);
  }
  async createTree(baseTreeSha, entries) {
    return this.request("POST", `${this.buildRepoPath()}/git/trees`, {
      base_tree: baseTreeSha,
      tree: entries
    });
  }
  async createCommit(message, treeSha, parentCommitSha) {
    return this.request("POST", `${this.buildRepoPath()}/git/commits`, {
      message,
      parents: [parentCommitSha],
      tree: treeSha
    });
  }
  async updateBranchReference(commitSha) {
    await this.request(
      "PATCH",
      `${this.buildRepoPath()}/git/refs/heads/${this.encodeRef(this.settings.githubBranch)}`,
      {
        force: false,
        sha: commitSha
      }
    );
  }
  async request(method, path, body) {
    const response = await (0, import_obsidian2.requestUrl)({
      body: body ? JSON.stringify(body) : void 0,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.settings.githubToken}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": this.apiVersion
      },
      method,
      throw: false,
      url: `${this.apiBaseUrl}${path}`
    });
    if (response.status >= 400) {
      const payload = response.json ?? safeJsonParse(response.text);
      const message = typeof payload?.message === "string" ? payload.message : response.text || `GitHub API request failed with status ${response.status}`;
      throw new Error(message);
    }
    if (!response.text) {
      return void 0;
    }
    return response.json ?? safeJsonParse(response.text);
  }
  buildRepoPath() {
    return `/repos/${encodeURIComponent(this.settings.githubOwner)}/${encodeURIComponent(this.settings.githubRepo)}`;
  }
  encodeRef(ref) {
    return ref.split("/").map((part) => encodeURIComponent(part)).join("/");
  }
};
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function decodeBase64(content) {
  const normalized = content.replace(/\n/g, "");
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// src/sync-engine.ts
var SyncEngine = class {
  constructor(app, getSettings, saveSettings) {
    this.app = app;
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.suppressVaultEvents = 0;
  }
  shouldIgnoreVaultEvents() {
    return this.suppressVaultEvents > 0;
  }
  async validateConnection() {
    const settings = this.getSettings();
    this.ensureConfigured(settings);
    const client = new GitHubApiClient(settings);
    await client.validateRepository();
    await client.getBranchSnapshot();
    return {
      mode: "validate",
      counters: cloneCounters()
    };
  }
  async initializeFromRemote() {
    const settings = this.getSettings();
    this.ensureConfigured(settings);
    const nextStates = {};
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
        remoteSha: remote.sha
      };
      counters.downloaded += 1;
    }
    settings.fileStates = nextStates;
    settings.initialized = true;
    settings.lastSyncAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.saveSettings();
    return {
      mode: "pull",
      counters
    };
  }
  async pushLocalSnapshot() {
    const settings = this.getSettings();
    this.ensureConfigured(settings);
    const nextStates = {};
    const snapshot = await new GitHubApiClient(settings).getBranchSnapshot();
    const counters = cloneCounters();
    const uploads = await this.collectUploadsFromLocal();
    if (uploads.length > 0) {
      const commitOutcome = await this.commitRemoteChanges(snapshot, uploads, [], "Initial vault push");
      for (const upload of uploads) {
        nextStates[upload.vaultPath] = {
          localHash: upload.localHash,
          remoteSha: commitOutcome.uploadedShas.get(upload.vaultPath) ?? null
        };
        counters.uploaded += 1;
      }
    }
    settings.fileStates = nextStates;
    settings.initialized = true;
    settings.lastSyncAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.saveSettings();
    return {
      mode: "push",
      counters
    };
  }
  async sync() {
    const settings = this.getSettings();
    this.ensureConfigured(settings);
    if (!settings.initialized) {
      throw new Error("\uBA3C\uC800 \uCD08\uAE30 Pull \uB610\uB294 Push\uB97C \uD55C \uBC88 \uC2E4\uD589\uD574\uC57C \uD569\uB2C8\uB2E4.");
    }
    const client = new GitHubApiClient(settings);
    const snapshot = await client.getBranchSnapshot();
    const localFiles = this.collectLocalFiles();
    const counters = cloneCounters();
    const uploads = [];
    const downloads = [];
    const deletes = [];
    const remoteContentCache = /* @__PURE__ */ new Map();
    const nextState = { ...settings.fileStates };
    const candidatePaths = /* @__PURE__ */ new Set([
      ...snapshot.files.keys(),
      ...localFiles.keys(),
      ...Object.keys(settings.fileStates)
    ]);
    for (const vaultPath of Array.from(candidatePaths).sort()) {
      if (!this.shouldSyncPath(vaultPath)) {
        delete nextState[vaultPath];
        continue;
      }
      const localFile = localFiles.get(vaultPath) ?? null;
      const remote = snapshot.files.get(vaultPath) ?? null;
      const previous = settings.fileStates[vaultPath];
      const localContent = localFile ? await this.app.vault.cachedRead(localFile) : null;
      const localHash = localContent ? await hashText(localContent) : null;
      if (localFile && remote) {
        if (!previous) {
          const remoteContent2 = await this.getRemoteContent(client, remoteContentCache, remote.sha);
          const remoteHash2 = await hashText(remoteContent2);
          if (remoteHash2 === localHash) {
            nextState[vaultPath] = { localHash, remoteSha: remote.sha };
            counters.unchanged += 1;
          } else {
            if (settings.createConflictCopies) {
              await this.writeConflictCopy(vaultPath, remoteContent2, "remote");
            }
            counters.conflicts += 1;
            uploads.push({
              content: localContent ?? "",
              localHash: localHash ?? "",
              repoPath: remote.repoPath,
              vaultPath
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
            vaultPath
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
            vaultPath
          });
        }
        continue;
      }
      if (localFile && !remote) {
        if (!previous || previous.remoteSha === null) {
          uploads.push({
            content: localContent ?? "",
            localHash: localHash ?? "",
            repoPath: this.toRepoPath(vaultPath),
            vaultPath
          });
        } else if (localHash !== previous.localHash) {
          uploads.push({
            content: localContent ?? "",
            localHash: localHash ?? "",
            repoPath: this.toRepoPath(vaultPath),
            vaultPath
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
        remoteSha: download.remoteSha
      };
      counters.downloaded += 1;
    }
    if (uploads.length > 0 || deletes.length > 0) {
      const commitOutcome = await this.commitRemoteChanges(
        snapshot,
        uploads,
        deletes,
        this.buildCommitMessage(uploads, deletes, counters)
      );
      for (const upload of uploads) {
        nextState[upload.vaultPath] = {
          localHash: upload.localHash,
          remoteSha: commitOutcome.uploadedShas.get(upload.vaultPath) ?? null
        };
        counters.uploaded += 1;
      }
      for (const deletion of deletes) {
        delete nextState[deletion.vaultPath];
        counters.deletedRemote += 1;
      }
    }
    settings.fileStates = nextState;
    settings.lastSyncAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.saveSettings();
    return {
      mode: "sync",
      counters
    };
  }
  ensureConfigured(settings) {
    if (!settings.githubOwner || !settings.githubRepo || !settings.githubBranch || !settings.githubToken) {
      throw new Error("GitHub owner, repo, branch, token \uC124\uC815\uC774 \uBAA8\uB450 \uD544\uC694\uD569\uB2C8\uB2E4.");
    }
  }
  collectLocalFiles() {
    const files = /* @__PURE__ */ new Map();
    for (const file of this.app.vault.getFiles()) {
      if (this.shouldSyncPath(file.path)) {
        files.set(file.path, file);
      }
    }
    return files;
  }
  async collectUploadsFromLocal() {
    const uploads = [];
    for (const file of this.app.vault.getFiles()) {
      if (!this.shouldSyncPath(file.path)) {
        continue;
      }
      const content = await this.app.vault.cachedRead(file);
      uploads.push({
        content,
        localHash: await hashText(content),
        repoPath: this.toRepoPath(file.path),
        vaultPath: file.path
      });
    }
    return uploads;
  }
  shouldSyncPath(path) {
    const settings = this.getSettings();
    const normalized = (0, import_obsidian3.normalizePath)(path);
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
      if (normalized === trimmedPrefix || normalized.startsWith(excludedPrefix) || relativePath === trimmedPrefix || relativePath.startsWith(excludedPrefix)) {
        return false;
      }
    }
    return true;
  }
  getLocalFile(vaultPath) {
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    return file instanceof import_obsidian3.TFile ? file : null;
  }
  toRepoPath(vaultPath) {
    const relativePath = getRelativePath(this.getSettings().vaultBasePath, vaultPath);
    if (relativePath === null || relativePath === "") {
      throw new Error(`Vault path is outside sync root: ${vaultPath}`);
    }
    return joinPath(this.getSettings().repoBasePath, relativePath);
  }
  async getRemoteContent(client, cache, sha) {
    const cached = cache.get(sha);
    if (cached !== void 0) {
      return cached;
    }
    const content = await client.getBlobText(sha);
    cache.set(sha, content);
    return content;
  }
  async commitRemoteChanges(snapshot, uploads, deletes, message) {
    const client = new GitHubApiClient(this.getSettings());
    const treeEntries = [
      ...uploads.map((upload) => ({
        content: upload.content,
        mode: "100644",
        path: upload.repoPath,
        type: "blob"
      })),
      ...deletes.map((deletion) => ({
        mode: "100644",
        path: deletion.repoPath,
        sha: null,
        type: "blob"
      }))
    ];
    const tree = await client.createTree(snapshot.treeSha, treeEntries);
    const commit = await client.createCommit(message, tree.sha, snapshot.commitSha);
    await client.updateBranchReference(commit.sha);
    const refreshedSnapshot = await client.getBranchSnapshot();
    const uploadedShas = /* @__PURE__ */ new Map();
    for (const upload of uploads) {
      const remoteFile = refreshedSnapshot.files.get(upload.vaultPath);
      if (remoteFile?.sha) {
        uploadedShas.set(upload.vaultPath, remoteFile.sha);
      }
    }
    return { uploadedShas };
  }
  buildCommitMessage(uploads, deletes, counters) {
    const device = this.getSettings().deviceName.trim() || "device";
    const parts = [];
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
  async writeVaultFile(vaultPath, content) {
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
  async writeConflictCopy(originalPath, content, source) {
    const deviceName = sanitizeDeviceName(this.getSettings().deviceName);
    const timestamp = formatTimestamp(/* @__PURE__ */ new Date());
    const extension = originalPath.includes(".") ? originalPath.slice(originalPath.lastIndexOf(".")) : "";
    const basePath = extension ? originalPath.slice(0, -extension.length) : originalPath;
    let candidate = (0, import_obsidian3.normalizePath)(`${basePath}.conflict-${source}-${deviceName}-${timestamp}${extension}`);
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = (0, import_obsidian3.normalizePath)(`${basePath}.conflict-${source}-${deviceName}-${timestamp}-${counter}${extension}`);
      counter += 1;
    }
    await this.writeVaultFile(candidate, content);
  }
  async deleteVaultPath(vaultPath) {
    const file = this.getLocalFile(vaultPath);
    if (!file) {
      return;
    }
    await this.withSuppressedVaultEvents(async () => {
      await this.app.vault.delete(file);
    });
  }
  async ensureFolder(path) {
    if (!path) {
      return;
    }
    let current = "";
    for (const segment of (0, import_obsidian3.normalizePath)(path).split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (await this.app.vault.adapter.exists(current)) {
        continue;
      }
      await this.app.vault.createFolder(current);
    }
  }
  async withSuppressedVaultEvents(operation) {
    this.suppressVaultEvents += 1;
    try {
      return await operation();
    } finally {
      this.suppressVaultEvents -= 1;
    }
  }
};
function formatResult(result) {
  return summarizeCounters(result.counters);
}

// src/main.ts
var GitHubVaultSyncPlugin = class extends import_obsidian4.Plugin {
  constructor() {
    super(...arguments);
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.isSyncing = false;
    this.syncIntervalId = null;
    this.statusBarItemEl = null;
    this.debouncedSync = (0, import_obsidian4.debounce)(
      () => void this.runSync("\uC790\uB3D9 \uC800\uC7A5 \uB3D9\uAE30\uD654", () => this.engine.sync()),
      1500,
      true
    );
  }
  async onload() {
    await this.loadSettings();
    this.engine = new SyncEngine(
      this.app,
      () => this.settings,
      () => this.saveSettings()
    );
    this.statusBarItemEl = this.addStatusBarItem();
    this.addCommand({
      id: "github-vault-sync-now",
      name: "GitHub\uC640 \uC9C0\uAE08 \uB3D9\uAE30\uD654",
      callback: () => void this.runSync("\uC218\uB3D9 \uB3D9\uAE30\uD654", () => this.engine.sync())
    });
    this.addCommand({
      id: "github-vault-sync-pull-init",
      name: "GitHub\uB97C \uAE30\uC900\uC73C\uB85C \uCD08\uAE30 Pull",
      callback: () => void this.runSync("\uCD08\uAE30 Pull", () => this.engine.initializeFromRemote())
    });
    this.addCommand({
      id: "github-vault-sync-push-init",
      name: "\uB85C\uCEEC \uBCFC\uD2B8\uB97C \uAE30\uC900\uC73C\uB85C \uCD08\uAE30 Push",
      callback: () => void this.runSync("\uCD08\uAE30 Push", () => this.engine.pushLocalSnapshot())
    });
    this.addCommand({
      id: "github-vault-sync-validate",
      name: "GitHub \uC5F0\uACB0 \uD655\uC778",
      callback: () => void this.runSync("\uC5F0\uACB0 \uD655\uC778", () => this.engine.validateConnection())
    });
    this.addRibbonIcon("cloud", "GitHub Vault Sync", () => {
      void this.runSync("\uC218\uB3D9 \uB3D9\uAE30\uD654", () => this.engine.sync());
    });
    this.addSettingTab(new GitHubVaultSyncSettingTab(this.app, this));
    this.registerVaultEvents();
    this.refreshAutoSyncInterval();
    this.updateStatusBar();
    if (this.settings.syncOnStartup && this.settings.initialized) {
      void this.runSync("\uC2DC\uC791 \uC2DC \uB3D9\uAE30\uD654", () => this.engine.sync());
    }
  }
  onunload() {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
    }
  }
  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...loaded ?? {},
      repoBasePath: normalizeFolder(loaded?.repoBasePath ?? DEFAULT_SETTINGS.repoBasePath),
      vaultBasePath: normalizeFolder(loaded?.vaultBasePath ?? DEFAULT_SETTINGS.vaultBasePath),
      fileStates: loaded?.fileStates ?? {}
    };
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshAutoSyncInterval();
    this.updateStatusBar();
  }
  runAction(label, action) {
    return this.runSync(label, action);
  }
  runValidate() {
    return this.runSync("\uC5F0\uACB0 \uD655\uC778", () => this.engine.validateConnection());
  }
  runInitializePull() {
    return this.runSync("\uCD08\uAE30 Pull", () => this.engine.initializeFromRemote());
  }
  runInitializePush() {
    return this.runSync("\uCD08\uAE30 Push", () => this.engine.pushLocalSnapshot());
  }
  runManualSync() {
    return this.runSync("\uC218\uB3D9 \uB3D9\uAE30\uD654", () => this.engine.sync());
  }
  registerVaultEvents() {
    const scheduleSync = () => {
      if (!this.settings.autoSyncOnSave || !this.settings.initialized) {
        return;
      }
      if (this.engine.shouldIgnoreVaultEvents()) {
        return;
      }
      this.debouncedSync();
    };
    this.registerEvent(this.app.vault.on("create", scheduleSync));
    this.registerEvent(this.app.vault.on("modify", scheduleSync));
    this.registerEvent(this.app.vault.on("delete", scheduleSync));
    this.registerEvent(this.app.vault.on("rename", scheduleSync));
  }
  refreshAutoSyncInterval() {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (!this.settings.initialized || this.settings.autoSyncIntervalMinutes <= 0) {
      return;
    }
    this.syncIntervalId = window.setInterval(() => {
      void this.runSync("\uC8FC\uAE30 \uB3D9\uAE30\uD654", () => this.engine.sync());
    }, this.settings.autoSyncIntervalMinutes * 60 * 1e3);
  }
  updateStatusBar(text) {
    if (!this.statusBarItemEl) {
      return;
    }
    if (text) {
      this.statusBarItemEl.setText(text);
      return;
    }
    const label = this.settings.lastSyncAt ? `GitHub Sync: ${new Date(this.settings.lastSyncAt).toLocaleString()}` : "GitHub Sync: not initialized";
    this.statusBarItemEl.setText(label);
  }
  async runSync(label, action) {
    if (this.isSyncing) {
      new import_obsidian4.Notice("\uC774\uBBF8 \uB3D9\uAE30\uD654\uAC00 \uC9C4\uD589 \uC911\uC785\uB2C8\uB2E4.");
      return;
    }
    this.isSyncing = true;
    this.updateStatusBar(`GitHub Sync: ${label} \uC911...`);
    try {
      const result = await action();
      this.updateStatusBar();
      new import_obsidian4.Notice(`${label} \uC644\uB8CC: ${formatResult(result)}`, 6e3);
    } catch (error) {
      this.updateStatusBar();
      const message = error instanceof Error ? error.message : String(error);
      new import_obsidian4.Notice(`${label} \uC2E4\uD328: ${message}`, 8e3);
    } finally {
      this.isSyncing = false;
    }
  }
};
var GitHubVaultSyncSettingTab = class extends import_obsidian4.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("github-vault-sync-settings");
    containerEl.createEl("h2", { text: "GitHub Vault Sync" });
    containerEl.createEl("p", {
      text: "GitHub REST API\uB97C \uC0AC\uC6A9\uD574 \uB370\uC2A4\uD06C\uD1B1\uACFC \uBAA8\uBC14\uC77C\uC5D0\uC11C \uBAA8\uB450 \uB3D9\uC791\uD560 \uC218 \uC788\uB3C4\uB85D \uB9CC\uB4E0 \uC591\uBC29\uD5A5 \uB3D9\uAE30\uD654 \uD50C\uB7EC\uADF8\uC778\uC785\uB2C8\uB2E4."
    });
    new import_obsidian4.Setting(containerEl).setName("GitHub Owner").setDesc("\uC608: your-name").addText(
      (text) => text.setPlaceholder("owner").setValue(this.plugin.settings.githubOwner).onChange(async (value) => {
        this.plugin.settings.githubOwner = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("GitHub Repository").setDesc("\uC608: my-notes").addText(
      (text) => text.setPlaceholder("repository").setValue(this.plugin.settings.githubRepo).onChange(async (value) => {
        this.plugin.settings.githubRepo = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Branch").setDesc("\uB3D9\uAE30\uD654\uD560 \uBE0C\uB79C\uCE58").addText(
      (text) => text.setPlaceholder("main").setValue(this.plugin.settings.githubBranch).onChange(async (value) => {
        this.plugin.settings.githubBranch = value.trim() || "main";
        await this.plugin.saveSettings();
      })
    );
    let tokenInputEl = null;
    new import_obsidian4.Setting(containerEl).setName("Personal Access Token").setDesc("Contents write \uAD8C\uD55C\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.").addText((text) => {
      tokenInputEl = text.inputEl;
      text.inputEl.type = "password";
      text.setPlaceholder("ghp_...").setValue(this.plugin.settings.githubToken).onChange(async (value) => {
        this.plugin.settings.githubToken = value.trim();
        await this.plugin.saveSettings();
      });
      return text;
    }).addExtraButton(
      (button) => button.setIcon("eye").setTooltip("\uD1A0\uD070 \uD45C\uC2DC \uC804\uD658").onClick(() => {
        if (tokenInputEl) {
          tokenInputEl.type = tokenInputEl.type === "password" ? "text" : "password";
        }
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Repository Base Path").setDesc("\uC800\uC7A5\uC18C \uC548\uC5D0\uC11C \uB3D9\uAE30\uD654\uD560 \uB8E8\uD2B8 \uD3F4\uB354\uC785\uB2C8\uB2E4. \uBE44\uC6B0\uBA74 \uC800\uC7A5\uC18C \uB8E8\uD2B8\uC785\uB2C8\uB2E4.").addText(
      (text) => text.setPlaceholder("notes").setValue(this.plugin.settings.repoBasePath).onChange(async (value) => {
        this.plugin.settings.repoBasePath = normalizeFolder(value);
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Vault Base Path").setDesc("\uBCFC\uD2B8 \uC548\uC5D0\uC11C \uB3D9\uAE30\uD654\uD560 \uB8E8\uD2B8 \uD3F4\uB354\uC785\uB2C8\uB2E4. \uBE44\uC6B0\uBA74 \uBCFC\uD2B8 \uC804\uCCB4\uC785\uB2C8\uB2E4.").addText(
      (text) => text.setPlaceholder("Notes").setValue(this.plugin.settings.vaultBasePath).onChange(async (value) => {
        this.plugin.settings.vaultBasePath = normalizeFolder(value);
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Include Extensions").setDesc("\uC27C\uD45C\uB85C \uAD6C\uBD84\uD569\uB2C8\uB2E4. \uAE30\uBCF8\uAC12: .md, .canvas, .txt").addText(
      (text) => text.setValue(this.plugin.settings.includeExtensions).onChange(async (value) => {
        this.plugin.settings.includeExtensions = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Exclude Paths").setDesc("\uACBD\uB85C prefix\uB97C \uC27C\uD45C\uB85C \uAD6C\uBD84\uD569\uB2C8\uB2E4. \uC608: .obsidian/, Templates/").addText(
      (text) => text.setValue(this.plugin.settings.excludePaths).onChange(async (value) => {
        this.plugin.settings.excludePaths = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Device Name").setDesc("\uCDA9\uB3CC \uD30C\uC77C \uC774\uB984\uACFC \uCEE4\uBC0B \uBA54\uC2DC\uC9C0\uC5D0 \uC0AC\uC6A9\uB429\uB2C8\uB2E4.").addText(
      (text) => text.setPlaceholder("iPhone").setValue(this.plugin.settings.deviceName).onChange(async (value) => {
        this.plugin.settings.deviceName = value.trim() || DEFAULT_SETTINGS.deviceName;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Auto Sync On Save").setDesc("\uB178\uD2B8 \uBCC0\uACBD \uC2DC \uC790\uB3D9\uC73C\uB85C \uC99D\uBD84 \uB3D9\uAE30\uD654\uB97C \uC608\uC57D\uD569\uB2C8\uB2E4.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoSyncOnSave).onChange(async (value) => {
        this.plugin.settings.autoSyncOnSave = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Auto Sync Interval (minutes)").setDesc("0 \uC774\uD558\uBA74 \uBE44\uD65C\uC131\uD654\uD569\uB2C8\uB2E4.").addText(
      (text) => text.setPlaceholder("5").setValue(String(this.plugin.settings.autoSyncIntervalMinutes)).onChange(async (value) => {
        const nextValue = Number.parseInt(value, 10);
        this.plugin.settings.autoSyncIntervalMinutes = Number.isNaN(nextValue) ? 0 : Math.max(nextValue, 0);
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Sync On Startup").setDesc("\uD50C\uB7EC\uADF8\uC778 \uB85C\uB4DC \uC2DC \uC790\uB3D9 \uB3D9\uAE30\uD654\uB97C \uC2E4\uD589\uD569\uB2C8\uB2E4.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
        this.plugin.settings.syncOnStartup = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Create Conflict Copies").setDesc("\uCDA9\uB3CC \uC2DC \uC6D0\uACA9 \uBC84\uC804\uC744 conflict \uC0AC\uBCF8\uC73C\uB85C \uB0A8\uAE30\uACE0 \uD604\uC7AC \uB85C\uCEEC \uD30C\uC77C\uC744 \uBA54\uC778\uC73C\uB85C \uC720\uC9C0\uD569\uB2C8\uB2E4.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.createConflictCopies).onChange(async (value) => {
        this.plugin.settings.createConflictCopies = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Quick Actions").setDesc("\uCC98\uC74C\uC5D0\uB294 \uCD08\uAE30 Pull \uB610\uB294 \uCD08\uAE30 Push\uB97C \uD55C \uBC88 \uC2E4\uD589\uD574\uC57C \uD569\uB2C8\uB2E4.").addButton(
      (button) => button.setButtonText("\uC5F0\uACB0 \uD655\uC778").onClick(() => {
        void this.plugin.runValidate();
      })
    ).addButton(
      (button) => button.setButtonText("\uCD08\uAE30 Pull").setCta().onClick(() => {
        void this.plugin.runInitializePull();
      })
    ).addButton(
      (button) => button.setButtonText("\uCD08\uAE30 Push").onClick(() => {
        void this.plugin.runInitializePush();
      })
    ).addButton(
      (button) => button.setButtonText("\uC9C0\uAE08 \uB3D9\uAE30\uD654").onClick(() => {
        void this.plugin.runManualSync();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Last Sync").setDesc(
      this.plugin.settings.lastSyncAt ? new Date(this.plugin.settings.lastSyncAt).toLocaleString() : "\uC544\uC9C1 \uB3D9\uAE30\uD654 \uAE30\uB85D\uC774 \uC5C6\uC2B5\uB2C8\uB2E4."
    );
  }
};
