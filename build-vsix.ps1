# Package bg-profile-sync into a .vsix (no vsce needed: zip with VSIX layout).
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as
# ANSI, and a trailing multi-byte char can even swallow the newline.
param(
  [string]$OutDir = (Join-Path $PSScriptRoot 'dist')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$pkg = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$vsixName = '{0}.{1}-{2}.vsix' -f $pkg.publisher, $pkg.name, $pkg.version
$outPath = Join-Path $OutDir $vsixName

$stage = Join-Path $env:TEMP ('vsix-stage-' + [guid]::NewGuid().ToString('N'))
$extDir = Join-Path $stage 'extension'
New-Item -ItemType Directory -Force -Path $extDir | Out-Null

Copy-Item (Join-Path $PSScriptRoot 'package.json') $extDir
Copy-Item (Join-Path $PSScriptRoot 'extension.js') $extDir
Copy-Item (Join-Path $PSScriptRoot 'sync.js') $extDir
if (Test-Path (Join-Path $PSScriptRoot 'readme.md')) {
  Copy-Item (Join-Path $PSScriptRoot 'readme.md') $extDir
}

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($pkg.name)" Version="$($pkg.version)" Publisher="$($pkg.publisher)" />
    <DisplayName>$($pkg.displayName)</DisplayName>
    <Description xml:space="preserve">$($pkg.description)</Description>
    <Tags>background,profile,vscode-profile</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Manifest" Value="extension/package.json" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Details" Value="extension/readme.md" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
  </Assets>
</PackageManifest>
"@

$contentTypes = @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
"@

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $stage 'extension.vsixmanifest'), $manifest, $utf8)
[System.IO.File]::WriteAllText((Join-Path $stage '[Content_Types].xml'), $contentTypes, $utf8)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path $outPath) { Remove-Item -Force $outPath }

# ZipArchive.CreateFromDirectory writes backslash separators on .NET Framework,
# which breaks the VSIX reader - create entries manually with forward slashes.
$zip = [System.IO.Compression.ZipFile]::Open($outPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $ordered = @(
    (Join-Path $stage 'extension.vsixmanifest'),
    (Join-Path $stage '[Content_Types].xml')
  ) + (Get-ChildItem (Join-Path $stage 'extension') -Recurse -File | Sort-Object FullName | Select-Object -ExpandProperty FullName)

  foreach ($file in $ordered) {
    $rel = $file.Substring($stage.Length + 1).Replace('\', '/')
    $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open()
    try {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $stream.Write($bytes, 0, $bytes.Length)
    } finally {
      $stream.Dispose()
    }
  }
} finally {
  $zip.Dispose()
}
Remove-Item -Recurse -Force $stage

Write-Host ('built {0}  ({1:N0} bytes)' -f $outPath, (Get-Item $outPath).Length)
