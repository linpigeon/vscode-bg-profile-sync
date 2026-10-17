# Install bg-profile-sync.vsix into every VS Code profile (Default + named ones).
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as
# ANSI, and a trailing multi-byte char can even swallow the newline.
param(
  [string]$Vsix,
  [string]$CodeCli = 'D:\Microsoft VS Code\bin\code.cmd',
  [string]$CodeUser = (Join-Path $env:APPDATA 'Code\User'),
  [string[]]$Only
)

$ErrorActionPreference = 'Stop'

if (-not $Vsix) {
  $Vsix = Get-ChildItem (Join-Path $PSScriptRoot 'dist\*.vsix') |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Vsix -or -not (Test-Path $Vsix)) { throw "vsix not found - run build-vsix.ps1 first" }
if (-not (Test-Path $CodeCli)) { throw "code CLI not found: $CodeCli" }

$storage = [System.IO.File]::ReadAllText((Join-Path $CodeUser 'globalStorage\storage.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$profiles = @('Default')
foreach ($item in $storage.userDataProfiles) { $profiles += $item.name }

Write-Host "vsix     : $Vsix"
Write-Host ("profiles : " + ($profiles -join ', '))
Write-Host ''

# code.cmd writes deprecation warnings to stderr; with ErrorActionPreference=Stop
# PowerShell 5.1 would turn that into a terminating error, so relax it here and
# rely on $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'

foreach ($name in $profiles) {
  if ($Only -and ($Only -notcontains $name)) { continue }
  $cliArgs = @('--install-extension', $Vsix, '--force')
  if ($name -ne 'Default') { $cliArgs += @('--profile', $name) }
  $output = & $CodeCli @cliArgs 2>&1
  $text = ($output | Out-String).Trim()
  Write-Host ("[{0}] exit={1} {2}" -f $name, $LASTEXITCODE, $text)
}

Write-Host ''
Write-Host '---- verify ----'
foreach ($name in $profiles) {
  if ($Only -and ($Only -notcontains $name)) { continue }
  $cliArgs = @('--list-extensions')
  if ($name -ne 'Default') { $cliArgs += @('--profile', $name) }
  $list = & $CodeCli @cliArgs 2>&1
  $has = @($list | Where-Object { $_ -match 'local\.bg-profile-sync' }).Count -gt 0
  Write-Host ("{0,-12} bg-profile-sync={1}" -f $name, $has)
}
