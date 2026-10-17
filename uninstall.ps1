# Remove local.bg-profile-sync from every VS Code profile.
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
param(
  [string]$CodeCli = 'D:\Microsoft VS Code\bin\code.cmd',
  [string]$CodeUser = (Join-Path $env:APPDATA 'Code\User')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $CodeCli)) { throw "code CLI not found: $CodeCli" }

$storage = [System.IO.File]::ReadAllText((Join-Path $CodeUser 'globalStorage\storage.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$profiles = @('Default')
foreach ($item in $storage.userDataProfiles) { $profiles += $item.name }

$ErrorActionPreference = 'Continue'
foreach ($name in $profiles) {
  $cliArgs = @('--uninstall-extension', 'local.bg-profile-sync')
  if ($name -ne 'Default') { $cliArgs += @('--profile', $name) }
  $null = & $CodeCli @cliArgs 2>&1
  Write-Host ("[{0,-11}] exit={1}" -f $name, $LASTEXITCODE)
}

Write-Host ''
Write-Host 'Now run:  node restore.js   (to strip the injected block from workbench.html)'
