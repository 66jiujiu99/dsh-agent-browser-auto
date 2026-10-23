#Requires -Version 5.1
<#
    Clear the "Mark of the Web" (MOTW) zone marker from a downloaded folder.

    Why this exists:
      When you download a ZIP from GitHub and extract it, Windows stamps every
      extracted file with an alternate data stream named Zone.Identifier with
      ZoneId=3 (Internet). For .cmd/.bat/.ps1/.exe that stamp makes Windows show
      the "Open File - Security Warning" dialog ("The publisher could not be
      verified", "Do you want to run this software?") every single time, even
      after you clicked Run before, because the marker stays on the file.

      This script removes that marker so the dialog stops appearing.

    Usage:
      1) Double-click tools\unblock-folder.cmd, or
      2) powershell -ExecutionPolicy Bypass -File tools\unblock-folder.ps1
         -Path "C:\path\to\extracted\folder"

    Safety: this only deletes the Zone.Identifier stream. It does not change
    file contents, permissions, or ownership. Run it only on files you trust:
    the marker exists precisely to warn you about untrusted downloads.

    This file is pure ASCII on purpose: no BOM, so it parses the same under
    Windows PowerShell 5.1 and PowerShell 7 in any code page.
#>

[CmdletBinding()]
param(
    # Folder to clean. Defaults to this package directory.
    [string]$Path = '',
    # Report what would change without deleting anything.
    [switch]$WhatIf,
    # Also clean subfolders (default: yes).
    [bool]$Recurse = $true
)

$ErrorActionPreference = 'Stop'

function Write-Line {
    param([string]$Text = '', [string]$Color = 'Gray')
    Write-Host $Text -ForegroundColor $Color
}

if (-not $Path) {
    # tools\ -> package root
    $Path = Split-Path -Parent $PSScriptRoot
}

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Line "[x] Not found: $Path" 'Red'
    exit 1
}
$Path = (Resolve-Path -LiteralPath $Path).Path

Write-Line ''
Write-Line '=== Clear download marker (Mark of the Web) ===' 'Cyan'
Write-Line "Target: $Path" 'Gray'
Write-Line ''

$files = if ($Recurse) {
    Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue
} else {
    Get-ChildItem -LiteralPath $Path -File -Force -ErrorAction SilentlyContinue
}

# Only these extensions ever trigger the "publisher could not be verified" dialog.
$riskyExt = @(
    '.cmd', '.bat', '.ps1', '.psm1', '.exe', '.msi', '.vbs', '.vbe',
    '.js', '.jse', '.wsf', '.wsh', '.hta', '.cpl', '.scr', '.reg', '.lnk'
)

$stamped = New-Object System.Collections.Generic.List[string]
$cleaned = 0
$failed = 0
$riskyFound = 0

foreach ($f in $files) {
    if ($riskyExt -contains $f.Extension.ToLowerInvariant()) { $riskyFound++ }

    $zone = Get-Item -LiteralPath $f.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue
    if (-not $zone) { continue }

    $stamped.Add($f.FullName)
    if ($WhatIf) { continue }

    try {
        Unblock-File -LiteralPath $f.FullName -ErrorAction Stop
        $cleaned++
    } catch {
        $failed++
        Write-Line "    [!] $($f.FullName): $($_.Exception.Message)" 'DarkYellow'
    }
}

Write-Line "Scanned files      : $($files.Count)" 'Gray'
Write-Line "Executable scripts : $riskyFound" 'Gray'
Write-Line "Marked by Windows  : $($stamped.Count)" 'Gray'

if ($WhatIf) {
    Write-Line ''
    Write-Line '[i] -WhatIf: nothing was changed. Files that WOULD be cleaned:' 'Cyan'
    if ($stamped.Count -eq 0) {
        Write-Line '    (none)' 'DarkGray'
    } else {
        $stamped | ForEach-Object { Write-Line "    $_" 'Gray' }
    }
    Write-Line ''
    exit 0
}

Write-Line "Cleaned            : $cleaned" 'Green'
if ($failed -gt 0) { Write-Line "Failed             : $failed" 'Red' }

if ($stamped.Count -eq 0) {
    Write-Line ''
    Write-Line '[ok] Nothing was marked. If the warning still appears, the file is' 'Green'
    Write-Line '     located on a network share or blocked by another mechanism, or you' 'Green'
    Write-Line '     clicked "Run" on a different copy of the file.' 'Green'
} else {
    Write-Line ''
    Write-Line '[ok] Done. The security warning dialog should no longer appear.' 'Green'
    Write-Line '     If Windows still asks, it is asking for a file outside this folder.' 'DarkGray'
}

Write-Line ''

if ($Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) {
    Write-Host 'Press Enter to close ...' -ForegroundColor DarkGray
    [void][Console]::ReadLine()
}
