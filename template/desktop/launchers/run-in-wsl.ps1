# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.

<#
.SYNOPSIS
  Launcher of a desktop sidecar that runs INSIDE WSL2 (Windows): checks the prerequisites, installs the payload, starts it.

.DESCRIPTION
  Some sidecars need Linux tools Windows does not have (tmux, node-pty on a pty...). The desktop app is native on Windows;
  such a sidecar runs in the user's WSL2 distribution:
    1. WSL is installed (`wsl.exe --status`), the distribution exists;
    2. inside it: Node >= NodeMin, every -Requires command, and the Windows-hosted back reachable at HealthUrl from WSL;
    3. the payload (a .tgz built for Linux and shipped in the app's resources) is unpacked once per version under
       ~/.vx-desktop/<Name>/<sha>, `current` pointing at it;
    4. the sidecar is started with `node <Entry>` after forwarding the environment variables named in -ForwardEnv
       (WSLENV, "/u" = Windows to Unix), and stays attached: its output is the sidecar log, and stopping the app ends it.
  Any unmet prerequisite is printed (with what to do) and the script exits with code 3: declare the sidecar "optional": true
  in desktop.config.json and the application starts without it.

  The back listens on 127.0.0.1 only (local trust): WSL reaches it through "mirrored" networking (Windows 11 22H2+,
  WSL 2.0.0+): add to %UserProfile%\.wslconfig
      [wsl2]
      networkingMode=mirrored
  then run `wsl --shutdown`. With the default NAT networking WSL cannot reach the Windows loopback and this script says so.

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File run-in-wsl.ps1 -Name runner -Payload C:\app\resources\runner\runner-linux.tgz `
    -Entry dist/main.js -Requires tmux,git -HealthUrl http://127.0.0.1:5123/api/v1/health -ForwardEnv HUB_URL,RUNNER_TOKEN
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Payload,
  [string]$Entry = 'dist/main.js',
  [string]$Distro = $env:VX_WSL_DISTRO,
  [string[]]$Requires = @(),
  [int]$NodeMin = 22,
  [string]$HealthUrl = '',
  [string[]]$ForwardEnv = @()
)

$ErrorActionPreference = 'Stop'
$PrerequisiteExit = 3

# With `powershell -File`, "-Requires tmux,git" arrives as ONE string: split lists on commas.
$Requires = @($Requires | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$ForwardEnv = @($ForwardEnv | ForEach-Object { $_ -split ',' } | Where-Object { $_ })

function Stop-Missing([string]$message) {
  [Console]::Error.WriteLine("run-in-wsl: $message")
  [Console]::Error.WriteLine('run-in-wsl: the sidecar is not started; the rest of the application works.')
  exit $PrerequisiteExit
}

# Prepends the given names to WSLENV ("/u": value passed unchanged from Windows to the Unix side).
function Add-WslEnv([string[]]$vars) {
  $existing = @($env:WSLENV -split ':' | Where-Object { $_ })
  $env:WSLENV = (@($vars | ForEach-Object { "$_/u" }) + $existing) -join ':'
}

if ($Name -notmatch '^[A-Za-z0-9._-]+$') { Stop-Missing "invalid -Name '$Name'" }
if (-not (Test-Path -LiteralPath $Payload -PathType Leaf)) { Stop-Missing "payload not found: $Payload (this build ships no Linux payload for the sidecar)" }

# 1. WSL itself.
$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl) { Stop-Missing 'wsl.exe not found. Install WSL 2: run "wsl --install" in an administrator terminal, restart, then start the application again.' }
& wsl.exe --status *> $null
if ($LASTEXITCODE -ne 0) { Stop-Missing 'WSL is not ready ("wsl --status" failed). Run "wsl --install" in an administrator terminal, restart, then start the application again.' }

$distroArgs = @()
if ($Distro) { $distroArgs = @('-d', $Distro) }
$names = @(& wsl.exe -l -q 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
if ($names.Count -eq 0) { Stop-Missing 'no WSL distribution installed. Run "wsl --install -d Ubuntu", finish its first start, then start the application again.' }
if ($Distro -and ($names -notcontains $Distro)) { Stop-Missing "WSL distribution '$Distro' not found (installed: $($names -join ', ')). Set VX_WSL_DISTRO to one of them." }

# Runs a bash script inside the distribution. The script travels as a file (LF line endings, no BOM): arguments of a native
# command lose their double quotes in Windows PowerShell 5.1, a file does not.
function Invoke-Wsl([string]$Script) {
  $file = Join-Path ([IO.Path]::GetTempPath()) ('vx-' + [guid]::NewGuid().ToString('N') + '.sh')
  [IO.File]::WriteAllText($file, ($Script -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
  try {
    $wslFile = (& wsl.exe @distroArgs -e wslpath -a $file | Out-String).Trim()
    & wsl.exe @distroArgs -e bash -l $wslFile
  } finally {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
}

# 2. Inside the distribution: Node, required commands, reachability of the Windows-hosted back.
$checkScript = @'
missing=""
if command -v node >/dev/null 2>&1; then
  major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null)
  [ "${major:-0}" -ge "$NODE_MIN" ] 2>/dev/null || missing="$missing node>=$NODE_MIN(found:${major:-?})"
else
  missing="$missing node>=$NODE_MIN"
fi
for c in $REQUIRES; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done
command -v tar >/dev/null 2>&1 || missing="$missing tar"
echo "MISSING:$missing"
if [ -n "$HEALTH_URL" ]; then
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 4 -o /dev/null "$HEALTH_URL" 2>/dev/null; then echo "REACHABLE:yes"; else echo "REACHABLE:no"; fi
  else
    echo "REACHABLE:unknown"
  fi
fi
'@
$env:NODE_MIN = "$NodeMin"
$env:REQUIRES = ($Requires -join ' ')
$env:HEALTH_URL = $HealthUrl
Add-WslEnv @('NODE_MIN', 'REQUIRES', 'HEALTH_URL')
$report = Invoke-Wsl $checkScript 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Stop-Missing "could not run commands in WSL: $report" }
$missing = ([regex]::Match($report, 'MISSING:(.*)')).Groups[1].Value.Trim()
if ($missing) {
  Stop-Missing "missing in the WSL distribution: $missing. Install them there (Ubuntu: sudo apt install tmux git curl; Node $NodeMin or newer from nodejs.org or nvm)."
}
if ($HealthUrl -and $report -match 'REACHABLE:no') {
  Stop-Missing "WSL cannot reach the application back at $HealthUrl. The back listens on the Windows loopback only: enable mirrored networking (Windows 11 22H2 or newer, WSL 2.0 or newer): add networkingMode=mirrored under [wsl2] in %UserProfile%\.wslconfig, run 'wsl --shutdown', then start the application again."
}

# 3. Payload, once per version.
$sha = (Get-FileHash -LiteralPath $Payload -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
$winPayload = (Resolve-Path -LiteralPath $Payload).Path
$wslPayload = (& wsl.exe @distroArgs -e wslpath -a $winPayload | Out-String).Trim()
if (-not $wslPayload) { Stop-Missing "could not translate $winPayload to a WSL path" }
$env:VX_NAME = $Name
$env:VX_SHA = $sha
$env:VX_TGZ = $wslPayload
Add-WslEnv @('VX_NAME', 'VX_SHA', 'VX_TGZ')
$installScript = @'
set -e
base="$HOME/.vx-desktop/$VX_NAME"
mkdir -p "$base"
if [ ! -d "$base/$VX_SHA" ]; then
  tmp="$base/.unpack-$$"
  rm -rf "$tmp"; mkdir -p "$tmp"
  tar -xzf "$VX_TGZ" -C "$tmp"
  mv "$tmp" "$base/$VX_SHA"
fi
ln -sfn "$base/$VX_SHA" "$base/current"
for old in "$base"/*/; do
  case "$old" in "$base/$VX_SHA/") ;; *) rm -rf "$old" ;; esac
done
echo "INSTALLED:$base/current"
'@
$installed = Invoke-Wsl $installScript 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Stop-Missing "could not unpack the payload in WSL: $installed" }

# 4. Start, attached. The variables named in -ForwardEnv are already in this process's environment (set by the shell).
foreach ($var in $ForwardEnv) {
  if (-not (Test-Path -LiteralPath "Env:$var")) { Stop-Missing "environment variable $var is not set (declare it in the env of the sidecar)" }
}
$env:VX_ENTRY = $Entry
Add-WslEnv (@($ForwardEnv) + @('VX_ENTRY', 'VX_NAME'))
$startScript = @'
cd "$HOME/.vx-desktop/$VX_NAME/current"
exec node "$VX_ENTRY"
'@
Invoke-Wsl $startScript
exit $LASTEXITCODE
