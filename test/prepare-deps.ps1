<#
.SYNOPSIS
  Prepare the test-only module dependencies used by test/schema.mjs and
  test/tools-live.mjs.

.DESCRIPTION
  Those two tests want the REAL `defineTool` implementation (schema compilation,
  argument validation) instead of a stub, because that is exactly the layer that
  broke during development. They also need @deepseek-ai/schemastery.

  This script:
    1. copies @deepseek-ai/dsh-tools out of the DSH app.asar (read-only source)
       into dsh-serial/node_modules;
    2. writes the minimal stubs its imports need (cordis, dsh-scope, dsh-llm,
       dsh-util-values, dsh-brand, dsh-sandbox);
    3. junctions @deepseek-ai/schemastery from the desktop profile.

  Nothing here ships in the npm tarball (package.json `files` excludes test and
  node_modules). Delete node_modules at any time; rerun this script to restore.

.PARAMETER Electron
  Path to the DSH Electron binary, used as Node (ELECTRON_RUN_AS_NODE=1) so it
  can read files inside app.asar.

.PARAMETER Profile
  DSH profile directory that carries @deepseek-ai/schemastery.

.EXAMPLE
  .\test\prepare-deps.ps1
  node test/schema.mjs
#>
param(
  [string]$Electron = 'D:\SoftWare\DeepSeek\DeepSeek Harness.exe',
  [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$nm = Join-Path $root 'node_modules\@deepseek-ai'
New-Item -ItemType Directory -Force -Path $nm | Out-Null

if (-not (Test-Path $Electron)) { throw "Electron binary not found: $Electron" }
if (-not (Test-Path (Join-Path $Profile 'node_modules\@deepseek-ai\schemastery'))) {
  throw "schemastery not found under $Profile\node_modules\@deepseek-ai (is the desktop profile installed?)"
}

# ---------------------------------------------------------------- dsh-tools
$dstTools = Join-Path $nm 'dsh-tools'
if (Test-Path $dstTools) { Remove-Item $dstTools -Recurse -Force }

$extractScript = Join-Path $here 'extract-dsh-tools.cjs'
$manifestPath = Join-Path $dstTools 'package.json'
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  & $Electron $extractScript $dstTools
  # The Electron-as-node launcher can return before the child finishes writing;
  # wait for the manifest instead of trusting the process exit.
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path $manifestPath)) {
    if ((Get-Date) -gt $deadline) { throw 'asar extraction timed out: dsh-tools was not copied' }
    Start-Sleep -Milliseconds 200
  }
} finally {
  Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------------- stubs
function Write-Stub([string]$Name, [string]$Body) {
  $dir = Join-Path $nm $Name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $manifest = @{ name = "@deepseek-ai/$Name"; version = '0.0.0-stub'; type = 'module'; main = 'index.js'; exports = './index.js' } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $dir 'package.json'), $manifest, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText((Join-Path $dir 'index.js'), $Body, [System.Text.UTF8Encoding]::new($false))
}

Write-Stub 'cordis' @'
export class Service { constructor(ctx) { this.ctx = ctx } }
export default { Service }
'@

Write-Stub 'dsh-scope' @'
export class AnonymousEntries {}
export class NamedEntries {}
export class ScopedLayers {}
export function scopeOf() { return undefined }
export function scopeTarget() { return undefined }
'@

Write-Stub 'dsh-llm' @'
export class HarnessError extends Error { constructor(message, code) { super(message); this.code = code } }
export function createUserMessage(...args) { return { args } }
'@

Write-Stub 'dsh-util-values' @'
export function assertNever(x) { throw new Error('assertNever ' + x) }
export function deepFreeze(x) { return x }
export function isJsonValue() { return true }
export function snapshotJsonValue(x) { return x }
'@

Write-Stub 'dsh-brand' @'
export function brandString(x) { return x }
'@

Write-Stub 'dsh-sandbox' @'
export const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access']
export function approveEscalation() { return true }
export function validateEscalationArgs() { return true }
'@

# -------------------------------------------------------------- schemastery
$schemastery = Join-Path $nm 'schemastery'
if (-not (Test-Path $schemastery)) {
  cmd /c mklink /J "$schemastery" "$Profile\node_modules\@deepseek-ai\schemastery" | Out-Null
}

Write-Host 'test deps ready:'
Get-ChildItem $nm | Select-Object Name
