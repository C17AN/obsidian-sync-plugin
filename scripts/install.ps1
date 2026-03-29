param(
	[string]$VaultPath,
	[switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$pluginId = "github-vault-sync"
$distPath = Join-Path $projectRoot "dist"
$requiredFiles = @("main.js", "manifest.json", "styles.css")

if ([string]::IsNullOrWhiteSpace($VaultPath)) {
	Write-Host ""
	Write-Host "Obsidian vault 경로를 입력하세요." -ForegroundColor Cyan
	$VaultPath = Read-Host "Vault Path"
}

if ([string]::IsNullOrWhiteSpace($VaultPath)) {
	throw "Vault path is required."
}

$resolvedVaultPath = [System.IO.Path]::GetFullPath($VaultPath)
$obsidianConfigPath = Join-Path $resolvedVaultPath ".obsidian"
$pluginTargetPath = Join-Path $obsidianConfigPath "plugins\$pluginId"

if (-not (Test-Path -LiteralPath $resolvedVaultPath)) {
	throw "Vault path does not exist: $resolvedVaultPath"
}

if (-not (Test-Path -LiteralPath $obsidianConfigPath)) {
	throw "The selected folder does not look like an Obsidian vault: $resolvedVaultPath"
}

Push-Location $projectRoot
try {
	if (-not $SkipBuild) {
		Write-Host ""
		Write-Host "Building plugin..." -ForegroundColor Cyan
		& npm run build
		if ($LASTEXITCODE -ne 0) {
			throw "Build failed."
		}
	}

	if (-not (Test-Path -LiteralPath $distPath)) {
		throw "Build output not found: $distPath"
	}

	foreach ($fileName in $requiredFiles) {
		$filePath = Join-Path $distPath $fileName
		if (-not (Test-Path -LiteralPath $filePath)) {
			throw "Required build file is missing: $filePath"
		}
	}

	New-Item -ItemType Directory -Force -Path $pluginTargetPath | Out-Null

	Write-Host ""
	Write-Host "Installing plugin to:" -ForegroundColor Cyan
	Write-Host $pluginTargetPath

	foreach ($fileName in @("main.js", "manifest.json", "styles.css", "versions.json")) {
		$sourcePath = Join-Path $distPath $fileName
		if (Test-Path -LiteralPath $sourcePath) {
			Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $pluginTargetPath $fileName) -Force
		}
	}

	Write-Host ""
	Write-Host "Installation completed." -ForegroundColor Green
	Write-Host "Open Obsidian and enable or reload the plugin if needed." -ForegroundColor Green
}
finally {
	Pop-Location
}
