import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
} from "obsidian";

import { formatSyncSummary, t } from "./i18n";
import { SyncEngine } from "./sync-engine";
import type { GitHubSyncSettings, SyncResult, UiLanguage } from "./types";
import {
	DEFAULT_SETTINGS,
	mergePendingRename,
	normalizeFolder,
	parseGitHubRepositoryInput,
} from "./utils";

interface SyncRequest {
	action: () => Promise<SyncResult>;
	label: string;
	notifyOnFailure?: boolean;
	notifyOnSuccess?: boolean;
	notifyOnStart?: boolean;
	suppressFastForwardNotice?: boolean;
	flushActiveEditorBeforeSync?: boolean;
}

const AUTO_SYNC_RETRY_DELAY_MS = 10000;
const FOCUS_LOSS_MIN_SYNC_GAP_MS = 60 * 1000;
const FOCUS_LOSS_EVENT_DEDUP_MS = 3000;

export default class GitHubVaultSyncPlugin extends Plugin {
	settings: GitHubSyncSettings = structuredClone(DEFAULT_SETTINGS);
	private engine!: SyncEngine;
	private isSyncing = false;
	private lastFocusLossSyncRequestAt = 0;
	private queuedSyncRequest: SyncRequest | null = null;
	private retryTimerId: number | null = null;
	private syncIntervalId: number | null = null;
	private statusBarItemEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.engine = new SyncEngine(
			this.app,
			() => this.settings,
			() => this.saveSettings(),
		);
		this.statusBarItemEl = this.addStatusBarItem();

		this.addCommand({
			id: "github-vault-sync-now",
			name: this.translate("commandSyncNow"),
			callback: () => {
				void this.runManualSync();
			},
		});

		this.addCommand({
			id: "github-vault-sync-save-and-sync",
			name: this.translate("commandSaveAndSync"),
			editorCheckCallback: (checking) => {
				if (this.isSyncing) {
					return false;
				}

				if (!checking) {
					void this.runManualSync({ skipIfSyncing: true });
				}

				return true;
			},
			hotkeys: [{ modifiers: ["Mod"], key: "S" }],
		});

		this.addCommand({
			id: "github-vault-sync-pull-init",
			name: this.translate("commandInitPull"),
			callback: () => {
				this.runInitializePull();
			},
		});

		this.addCommand({
			id: "github-vault-sync-push-init",
			name: this.translate("commandInitPush"),
			callback: () => {
				this.runInitializePush();
			},
		});

		this.addCommand({
			id: "github-vault-sync-validate",
			name: this.translate("commandValidate"),
			callback: () => {
				this.runValidate();
			},
		});

		this.addRibbonIcon("cloud", this.translate("ribbonTooltip"), () => {
			void this.runManualSync();
		});

		this.addSettingTab(new GitHubVaultSyncSettingTab(this.app, this));
		this.registerVaultRenameTracking();
		this.registerFocusLossEvents();
		this.refreshAutoSyncInterval();
		this.updateStatusBar();

		if (this.settings.syncOnStartup && this.settings.initialized) {
			this.requestSync({
				action: () => this.engine.sync(),
				label: this.translate("actionStartupSync"),
				notifyOnFailure: true,
				notifyOnSuccess: true,
				suppressFastForwardNotice: true,
				flushActiveEditorBeforeSync: true,
			});
		}
	}

	onunload(): void {
		if (this.retryTimerId !== null) {
			window.clearTimeout(this.retryTimerId);
		}

		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
		}
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData();
		this.settings = {
			...structuredClone(DEFAULT_SETTINGS),
			...(loaded ?? {}),
			repoBasePath: normalizeFolder(loaded?.repoBasePath ?? DEFAULT_SETTINGS.repoBasePath),
			vaultBasePath: normalizeFolder(loaded?.vaultBasePath ?? DEFAULT_SETTINGS.vaultBasePath),
			fileStates: loaded?.fileStates ?? {},
			pendingRenames: loaded?.pendingRenames ?? {},
			uiLanguage: loaded?.uiLanguage ?? DEFAULT_SETTINGS.uiLanguage,
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshAutoSyncInterval();
		this.updateStatusBar();
	}

	getLanguage(): UiLanguage {
		return this.settings.uiLanguage ?? "ko";
	}

	translate(key: string, params?: Record<string, string | number>): string {
		return t(this.getLanguage(), key, params);
	}

	runValidate(): void {
		this.requestSync({
			action: () => this.engine.validateConnection(),
			label: this.translate("actionConnectionCheck"),
			notifyOnFailure: true,
			notifyOnSuccess: true,
		});
	}

	runInitializePull(): void {
		this.requestSync({
			action: () => this.engine.initializeFromRemote(),
			label: this.translate("actionInitialPull"),
			notifyOnFailure: true,
			notifyOnSuccess: true,
		});
	}

	runInitializePush(): void {
		this.requestSync({
			action: () => this.engine.pushLocalSnapshot(),
			label: this.translate("actionInitialPush"),
			notifyOnFailure: true,
			notifyOnSuccess: true,
			flushActiveEditorBeforeSync: true,
		});
	}

	async runManualSync(options?: { skipIfSyncing?: boolean }): Promise<void> {
		if (options?.skipIfSyncing && this.isSyncing) {
			return;
		}

		this.requestSync({
			action: () => this.engine.sync(),
			label: this.translate("actionManualSync"),
			notifyOnStart: true,
			notifyOnFailure: true,
			notifyOnSuccess: true,
			flushActiveEditorBeforeSync: true,
		});
	}

	private registerFocusLossEvents(): void {
		this.registerDomEvent(window, "blur", () => {
			this.scheduleFocusLossSync();
		});

		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				this.scheduleFocusLossSync();
			}
		});
	}

	private registerVaultRenameTracking(): void {
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile) || this.engine.shouldIgnoreVaultEvents()) {
					return;
				}

				void this.trackPendingRename(oldPath, file.path);
			}),
		);
	}

	private async trackPendingRename(oldPath: string, newPath: string): Promise<void> {
		const normalizedOldPath = normalizePath(oldPath);
		const normalizedNewPath = normalizePath(newPath);

		if (normalizedOldPath === normalizedNewPath) {
			return;
		}

		if (
			!this.engine.isSyncCandidate(normalizedOldPath) &&
			!this.engine.isSyncCandidate(normalizedNewPath)
		) {
			return;
		}

		this.settings.pendingRenames = mergePendingRename(
			this.settings.pendingRenames,
			normalizedOldPath,
			normalizedNewPath,
		);
		await this.saveSettings();
	}

	private scheduleFocusLossSync(): void {
		if (!this.settings.autoSyncOnSave || !this.settings.initialized) {
			return;
		}

		const now = Date.now();
		if (now - this.lastFocusLossSyncRequestAt < FOCUS_LOSS_EVENT_DEDUP_MS) {
			return;
		}

		const lastSyncAt = this.settings.lastSyncAt ? Date.parse(this.settings.lastSyncAt) : Number.NaN;
		if (!Number.isNaN(lastSyncAt) && now - lastSyncAt < FOCUS_LOSS_MIN_SYNC_GAP_MS) {
			return;
		}

		this.lastFocusLossSyncRequestAt = now;
		this.requestSync({
			action: () => this.engine.sync(),
			label: this.translate("actionFocusLossSync"),
			notifyOnFailure: true,
			notifyOnSuccess: true,
			suppressFastForwardNotice: true,
			flushActiveEditorBeforeSync: true,
		});
	}

	private refreshAutoSyncInterval(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}

		if (!this.settings.initialized || this.settings.autoSyncIntervalMinutes <= 0) {
			return;
		}

		this.syncIntervalId = window.setInterval(() => {
			this.requestSync({
				action: () => this.engine.sync(),
				label: this.translate("actionScheduledSync"),
				notifyOnFailure: true,
				notifyOnSuccess: true,
				suppressFastForwardNotice: true,
				flushActiveEditorBeforeSync: true,
			});
		}, this.settings.autoSyncIntervalMinutes * 60 * 1000);
	}

	private updateStatusBar(text?: string): void {
		if (!this.statusBarItemEl) {
			return;
		}

		if (text) {
			this.statusBarItemEl.setText(text);
			return;
		}

		const label = this.settings.lastSyncAt
			? this.translate("statusLastSync", {
					date: new Date(this.settings.lastSyncAt).toLocaleString(),
				})
			: this.translate("statusNotInitialized");
		this.statusBarItemEl.setText(label);
	}

	private requestSync(request: SyncRequest): void {
		if (this.isSyncing) {
			this.queuedSyncRequest = request;
			return;
		}

		void this.executeSyncRequest(request);
	}

	private async executeSyncRequest(request: SyncRequest): Promise<void> {
		this.isSyncing = true;
		this.updateStatusBar(this.translate("statusInProgress", { label: request.label }));
		if (request.notifyOnStart) {
			new Notice(this.translate("manualSyncStarted"), 3000);
		}

		try {
			if (request.flushActiveEditorBeforeSync) {
				await this.flushActiveEditorToVault();
			}

			const result = await request.action();
			if (this.retryTimerId !== null) {
				window.clearTimeout(this.retryTimerId);
				this.retryTimerId = null;
			}
			this.updateStatusBar();
			if (request.notifyOnSuccess) {
				new Notice(
					this.translate("noticeCompleted", {
						label: request.label,
						result: formatSyncSummary(result.counters, this.getLanguage()),
					}),
					6000,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const fastForward = isFastForwardError(error);

			if (fastForward && request.suppressFastForwardNotice) {
				this.scheduleRetry(request);
			} else {
				this.updateStatusBar();
				if (request.notifyOnFailure ?? true) {
					new Notice(
						this.translate("noticeFailed", {
							label: request.label,
							message,
						}),
						8000,
					);
				}
			}
		} finally {
			this.isSyncing = false;
			const queuedRequest = this.queuedSyncRequest;
			this.queuedSyncRequest = null;
			if (queuedRequest) {
				this.requestSync(queuedRequest);
			}
		}
	}

	private scheduleRetry(request: SyncRequest): void {
		if (this.retryTimerId !== null) {
			window.clearTimeout(this.retryTimerId);
		}

		this.updateStatusBar(
			this.translate("statusRetrying", { seconds: AUTO_SYNC_RETRY_DELAY_MS / 1000 }),
		);
		this.retryTimerId = window.setTimeout(() => {
			this.retryTimerId = null;
			this.requestSync({
				...request,
				label: this.translate("actionAutomaticRetry"),
				notifyOnFailure: true,
				notifyOnSuccess: true,
				suppressFastForwardNotice: true,
			});
		}, AUTO_SYNC_RETRY_DELAY_MS);
	}

	private async flushActiveEditorToVault(): Promise<void> {
		const activeEditor = this.app.workspace.activeEditor;
		const file = activeEditor?.file;
		const editor = activeEditor?.editor;

		if (!(file instanceof TFile) || !editor) {
			return;
		}

		const editorContent = editor.getValue();
		const diskContent = await this.app.vault.cachedRead(file);

		if (editorContent === diskContent) {
			return;
		}

		await this.app.vault.modify(file, editorContent);
	}
}

function isFastForwardError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	return /update is not a fast forward|not a fast forward/i.test(error.message);
}

class GitHubVaultSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: GitHubVaultSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const tr = (key: string, params?: Record<string, string | number>) =>
			this.plugin.translate(key, params);

		containerEl.empty();
		containerEl.addClass("github-vault-sync-settings");

		containerEl.createEl("h2", { text: tr("settingTitle") });
		containerEl.createEl("p", {
			text: tr("settingIntro"),
		});

		new Setting(containerEl)
			.setName(tr("settingLanguageName"))
			.setDesc(tr("settingLanguageDesc"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("ko", tr("languageKorean"))
					.addOption("en", tr("languageEnglish"))
					.setValue(this.plugin.settings.uiLanguage)
					.onChange(async (value) => {
						this.plugin.settings.uiLanguage = value as UiLanguage;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName(tr("ownerName"))
			.setDesc(tr("ownerDesc"))
			.addText((text) =>
				text
					.setPlaceholder("owner")
					.setValue(this.plugin.settings.githubOwner)
					.onChange(async (value) => {
						this.plugin.settings.githubOwner = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(tr("repoName"))
			.setDesc(tr("repoDesc"))
			.addText((text) =>
				text
					.setPlaceholder(tr("repoPlaceholder"))
					.setValue(this.plugin.settings.githubRepo)
					.onChange(async (value) => {
						const parsed = parseGitHubRepositoryInput(value);
						this.plugin.settings.githubRepo = parsed?.repo ?? "";
						if (parsed?.owner) {
							this.plugin.settings.githubOwner = parsed.owner;
						}
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName(tr("branchName"))
			.setDesc(tr("branchDesc"))
			.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(this.plugin.settings.githubBranch)
					.onChange(async (value) => {
						this.plugin.settings.githubBranch = value.trim() || "main";
						await this.plugin.saveSettings();
					}),
			);

		let tokenInputEl: HTMLInputElement | null = null;
		new Setting(containerEl)
			.setName(tr("tokenName"))
			.setDesc(tr("tokenDesc"))
			.addText((text) => {
				tokenInputEl = text.inputEl;
				text.inputEl.type = "password";
				text
					.setPlaceholder("ghp_...")
					.setValue(this.plugin.settings.githubToken)
					.onChange(async (value) => {
						this.plugin.settings.githubToken = value.trim();
						await this.plugin.saveSettings();
					});
				return text;
			})
			.addExtraButton((button) =>
				button
					.setIcon("eye")
					.setTooltip(tr("tokenToggle"))
					.onClick(() => {
						if (tokenInputEl) {
							tokenInputEl.type = tokenInputEl.type === "password" ? "text" : "password";
						}
					}),
			);

		new Setting(containerEl)
			.setName(tr("repoBasePathName"))
			.setDesc(tr("repoBasePathDesc"))
			.addText((text) =>
				text
					.setPlaceholder("notes")
					.setValue(this.plugin.settings.repoBasePath)
					.onChange(async (value) => {
						this.plugin.settings.repoBasePath = normalizeFolder(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(tr("vaultBasePathName"))
			.setDesc(tr("vaultBasePathDesc"))
			.addText((text) =>
				text
					.setPlaceholder("Notes")
					.setValue(this.plugin.settings.vaultBasePath)
					.onChange(async (value) => {
						this.plugin.settings.vaultBasePath = normalizeFolder(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(tr("includeExtensionsName"))
			.setDesc(tr("includeExtensionsDesc"))
			.addText((text) =>
				text.setValue(this.plugin.settings.includeExtensions).onChange(async (value) => {
					this.plugin.settings.includeExtensions = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr("excludePathsName"))
			.setDesc(tr("excludePathsDesc"))
			.addText((text) =>
				text.setValue(this.plugin.settings.excludePaths).onChange(async (value) => {
					this.plugin.settings.excludePaths = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr("deviceNameName"))
			.setDesc(tr("deviceNameDesc"))
			.addText((text) =>
				text
					.setPlaceholder("iPhone")
					.setValue(this.plugin.settings.deviceName)
					.onChange(async (value) => {
						this.plugin.settings.deviceName = value.trim() || DEFAULT_SETTINGS.deviceName;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(tr("autoSyncOnFocusLossName"))
			.setDesc(tr("autoSyncOnFocusLossDesc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSyncOnSave).onChange(async (value) => {
					this.plugin.settings.autoSyncOnSave = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr("autoSyncIntervalName"))
			.setDesc(tr("autoSyncIntervalDesc"))
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.autoSyncIntervalMinutes))
					.onChange(async (value) => {
						const nextValue = Number.parseInt(value, 10);
						this.plugin.settings.autoSyncIntervalMinutes = Number.isNaN(nextValue)
							? 0
							: Math.max(nextValue, 0);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(tr("syncOnStartupName"))
			.setDesc(tr("syncOnStartupDesc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr("createConflictCopiesName"))
			.setDesc(tr("createConflictCopiesDesc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.createConflictCopies).onChange(async (value) => {
					this.plugin.settings.createConflictCopies = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(tr("quickActionsName"))
			.setDesc(tr("quickActionsDesc"))
			.setClass("github-vault-sync-quick-actions")
			.addButton((button) =>
				button.setButtonText(tr("buttonCheckConnection")).onClick(() => {
					this.plugin.runValidate();
				}),
			)
			.addButton((button) =>
				button.setButtonText(tr("buttonInitialPull")).setCta().onClick(() => {
					this.plugin.runInitializePull();
				}),
			)
			.addButton((button) =>
				button.setButtonText(tr("buttonInitialPush")).onClick(() => {
					this.plugin.runInitializePush();
				}),
			)
			.addButton((button) =>
				button.setButtonText(tr("buttonSyncNow")).onClick(() => {
					void this.plugin.runManualSync();
				}),
			);

		new Setting(containerEl)
			.setName(tr("lastSyncName"))
			.setDesc(
				this.plugin.settings.lastSyncAt
					? new Date(this.plugin.settings.lastSyncAt).toLocaleString()
					: tr("lastSyncNever"),
			);
	}
}
