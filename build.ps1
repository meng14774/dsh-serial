<#
.SYNOPSIS
  Build the dsh-serial installable tarball into ..\dist .

.DESCRIPTION
  The desktop profile installs this plugin from a tarball file, not from a link
  (a link resolves to the source path outside the profile, where DSH's runtime
  resolver cannot supply @deepseek-ai/* to nested imports). So every update is:
  bump the version, pack, install the new tarball, restart DSH.

  This script does the pack step. It refuses a dirty version unless -Force is
  passed, because pnpm treats an unchanged version as "nothing to do".

.PARAMETER Version
  New version to write into package.json before packing, e.g. 0.1.2.
  Omit to pack the current version.

.PARAMETER Force
  Pack even when the tarball for this version already exists.

.EXAMPLE
  .\build.ps1 -Version 0.1.2
  # then: plugin_manager install_bundle target <repo>\dist\meng14774-dsh-serial-0.1.2.tgz
  # then: restart DSH
#>
param(
  [string]$Version,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgPath = Join-Path $here 'package.json'
$distDir = Join-Path (Split-Path -Parent $here) 'dist'

$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Version) {
  $pkg.version = $Version
  # Write UTF-8 *without* a BOM: Windows PowerShell's `Set-Content -Encoding utf8`
  # emits a BOM, and the DSH installer rejects the package with
  # "Unexpected token '﻿' ... is not valid JSON". ConvertFrom-Json would also
  # mangle non-ASCII text when the file is read with the default ANSI encoding.
  $json = ($pkg | ConvertTo-Json -Depth 8) + "`n"
  [IO.File]::WriteAllText($pkgPath, $json, (New-Object Text.UTF8Encoding($false)))
  Write-Host "version -> $Version"
}

# npm decides the tarball name; a scoped package (@scope/name) packs as
# "scope-name-<ver>.tgz". Derive it the same way instead of hard-coding it.
$flat = $pkg.name -replace '^@', '' -replace '/', '-'
$tarball = Join-Path $distDir ("{0}-{1}.tgz" -f $flat, $pkg.version)
if ((Test-Path $tarball) -and -not $Force) {
  throw "tarball already exists: $tarball (bump -Version or pass -Force)"
}

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
Push-Location $here
try {
  npm pack --pack-destination $distDir | Out-Null
} finally {
  Pop-Location
}

$hash = (Get-FileHash $tarball -Algorithm SHA256).Hash
Write-Host ''
Write-Host "built: $tarball"
Write-Host "sha256: $hash"
Write-Host ''
Write-Host 'Next steps:'
Write-Host "  1) install:  plugin_manager install_bundle target=$tarball"
Write-Host '  2) restart DSH (running hosts snapshot their resolvable packages at boot)'
Write-Host '  3) verify:   serial_list / serial_status, and http://127.0.0.1:19387/dsh-serial'
