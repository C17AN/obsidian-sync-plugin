import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

import { SyncEngine, formatResult } from "./sync-engine";
import type { GitHubSyncSettings, SyncResult } from "./types";
import { DEFAULT_SETTINGS, normalizeFolder, parseGitHubRepositoryInput } from "./utils";

interface SyncRequest {
	action: () => Promise<SyncResult>;
	label: string;
	notifyOnFailure?: boolean;
	notifyOnSuccess?: boolean;
	suppressFastForwardNotice?: boolean;
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
			name: "GitHub와 지금 동기화",
			callback: () => this.runManualSync(),
		});

		this.addCommand({
			id: "github-vault-sync-pull-init",
			name: "GitHub를 기준으로 초기 Pull",
			callback: () => this.runInitializePull(),
		});

		this.addCommand({
			id: "github-vault-sync-push-init",
			name: "로컬 볼트를 기준으로 초기 Push",
			callback: () => this.runInitializePush(),
		});

		this.addCommand({
			id: "github-vault-sync-validate",
			name: "GitHub 연결 확인",
			callback: () => this.runValidate(),
		});

		this.addRibbonIcon("cloud", "GitHub Vault Sync", () => {
			this.runManualSync();
		});

		this.addSettingTab(new GitHubVaultSyncSettingTab(this.app, this));
		this.registerFocusLossEvents();
		this.refreshAutoSyncInterval();
		this.updateStatusBar();

		if (this.settings.syncOnStartup && this.settings.initialized) {
			this.requestSync({
				action: () => this.engine.sync(),
				label: "시작 시 동기화",
				notifyOnFailure: true,
				notifyOnSuccess: false,
				suppressFastForwardNotice: true,
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
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshAutoSyncInterval();
		this.updateStatusBar();
	}

	runValidate(): void {
		this.requestSync({
			action: () => this.engine.validateConnection(),
			label: "연결 확인",
			notifyOnFailure: true,
			notifyOnSuccess: true,
		});
	}

	runInitializePull(): void {
		this.requestSync({
			action: () => this.engine.initializeFromRemote(),
			label: "초기 Pull",
			notifyOnFailure: true,
			notifyOnSuccess: true,
		});
	}

	runInitializePush(): void {
		this.requestSync({
			action: () => this.engine.pushLocalSnapshot(),
			label: "초기 Push",
			notifyOnFailure: true,
			notifyOnSuccess: true,
		});
	}

	runManualSync(): void {
		this.requestSync({
			action: () => this.engine.sync(),
			label: "수동 동기화",
			notifyOnFailure: true,
			notifyOnSuccess: true,
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
			label: "포커스 이탈 동기화",
			notifyOnFailure: true,
			notifyOnSuccess: false,
			suppressFastForwardNotice: true,
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
				label: "주기 동기화",
				notifyOnFailure: true,
				notifyOnSuccess: false,
				suppressFastForwardNotice: true,
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
			? `GitHub Sync: ${new Date(this.settings.lastSyncAt).toLocaleString()}`
			: "GitHub Sync: not initialized";
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
		this.updateStatusBar(`GitHub Sync: ${request.label} 중...`);

		try {
			const result = await request.action();
			if (this.retryTimerId !== null) {
				window.clearTimeout(this.retryTimerId);
				this.retryTimerId = null;
			}
			this.updateStatusBar();
			if (request.notifyOnSuccess) {
				new Notice(`${request.label} 완료: ${formatResult(result)}`, 6000);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const fastForward = isFastForwardError(error);

			if (fastForward && request.suppressFastForwardNotice) {
				this.scheduleRetry(request);
			} else {
				this.updateStatusBar();
				if (request.notifyOnFailure ?? true) {
					new Notice(`${request.label} 실패: ${message}`, 8000);
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

		this.updateStatusBar(`GitHub Sync: 원격 갱신 충돌, ${AUTO_SYNC_RETRY_DELAY_MS / 1000}초 후 재시도`);
		this.retryTimerId = window.setTimeout(() => {
			this.retryTimerId = null;
			this.requestSync({
				...request,
				label: "자동 재시도",
				notifyOnFailure: true,
				notifyOnSuccess: false,
				suppressFastForwardNotice: true,
			});
		}, AUTO_SYNC_RETRY_DELAY_MS);
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
		containerEl.empty();
		containerEl.addClass("github-vault-sync-settings");

		containerEl.createEl("h2", { text: "GitHub Vault Sync" });
		containerEl.createEl("p", {
			text: "GitHub REST API를 사용해 데스크톱과 모바일에서 모두 동작할 수 있도록 만든 양방향 동기화 플러그인입니다.",
		});

		new Setting(containerEl)
			.setName("GitHub Owner")
			.setDesc("예: your-name")
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
			.setName("GitHub Repository")
			.setDesc("예: my-notes, C17AN/obsidian-sync, https://github.com/C17AN/obsidian-sync")
			.addText((text) =>
				text
					.setPlaceholder("repository 또는 GitHub URL")
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
			.setName("Branch")
			.setDesc("동기화할 브랜치")
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
			.setName("Personal Access Token")
			.setDesc("Contents write 권한이 필요합니다.")
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
					.setTooltip("토큰 표시 전환")
					.onClick(() => {
						if (tokenInputEl) {
							tokenInputEl.type = tokenInputEl.type === "password" ? "text" : "password";
						}
					}),
			);

		new Setting(containerEl)
			.setName("Repository Base Path")
			.setDesc("저장소 안에서 동기화할 루트 폴더입니다. 비우면 저장소 루트입니다.")
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
			.setName("Vault Base Path")
			.setDesc("볼트 안에서 동기화할 루트 폴더입니다. 비우면 볼트 전체입니다.")
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
			.setName("Include Extensions")
			.setDesc("쉼표로 구분합니다. 기본값: .md, .canvas, .txt")
			.addText((text) =>
				text.setValue(this.plugin.settings.includeExtensions).onChange(async (value) => {
					this.plugin.settings.includeExtensions = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Exclude Paths")
			.setDesc("경로 prefix를 쉼표로 구분합니다. 예: .obsidian/, Templates/")
			.addText((text) =>
				text.setValue(this.plugin.settings.excludePaths).onChange(async (value) => {
					this.plugin.settings.excludePaths = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Device Name")
			.setDesc("충돌 파일 이름과 커밋 메시지에 사용됩니다.")
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
			.setName("Auto Sync On Focus Loss")
			.setDesc("페이지나 앱이 포커스를 잃을 때 자동 동기화를 시도합니다. 마지막 성공 동기화 후 1분 이내면 건너뜁니다.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSyncOnSave).onChange(async (value) => {
					this.plugin.settings.autoSyncOnSave = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Auto Sync Interval (minutes)")
			.setDesc("0 이하면 비활성화합니다.")
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
			.setName("Sync On Startup")
			.setDesc("플러그인 로드 시 자동 동기화를 실행합니다.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Create Conflict Copies")
			.setDesc("충돌 시 원격 버전을 conflict 사본으로 남기고 현재 로컬 파일을 메인으로 유지합니다.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.createConflictCopies).onChange(async (value) => {
					this.plugin.settings.createConflictCopies = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Quick Actions")
			.setDesc("처음에는 초기 Pull 또는 초기 Push를 한 번 실행해야 합니다.")
			.setClass("github-vault-sync-quick-actions")
			.addButton((button) =>
				button.setButtonText("연결 확인").onClick(() => {
					this.plugin.runValidate();
				}),
			)
			.addButton((button) =>
				button.setButtonText("초기 Pull").setCta().onClick(() => {
					this.plugin.runInitializePull();
				}),
			)
			.addButton((button) =>
				button.setButtonText("초기 Push").onClick(() => {
					this.plugin.runInitializePush();
				}),
			)
			.addButton((button) =>
				button.setButtonText("지금 동기화").onClick(() => {
					this.plugin.runManualSync();
				}),
			);

		new Setting(containerEl)
			.setName("Last Sync")
			.setDesc(
				this.plugin.settings.lastSyncAt
					? new Date(this.plugin.settings.lastSyncAt).toLocaleString()
					: "아직 동기화 기록이 없습니다.",
			);
	}
}
