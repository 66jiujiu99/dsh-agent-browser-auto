#Requires -Version 5.1
<#
    DSH deep-mode launcher (CDP: random port + Origin restriction).

    What it does:
      1) Starts DSH with --remote-debugging-port=0, so the debugging port is
         random instead of the well-known 9222 that scanners probe.
      2) Adds --remote-allow-origins=devtools://devtools so that WebSocket
         connections are accepted from the DevTools frontend origin only.
         This blocks the "a web page you visit opens ws://127.0.0.1:<port>"
         class of attack.
      3) Reads the real port from the DevToolsActivePort file, then verifies
         the endpoint actually answers over HTTP before reporting success.

    Why the real logic is here and not in the .cmd:
      cmd.exe decodes batch files byte-by-byte using the OEM code page (936 on
      zh-CN). A UTF-8 Chinese comment gets mis-decoded, swallows the following
      REM and newline, and cmd then tries to execute the Chinese text as a
      command. The window floods with errors and closes instantly.
      This file is therefore written in pure ASCII, with no BOM, so it parses
      identically under Windows PowerShell 5.1 and PowerShell 7 regardless of
      the active code page or locale. Chinese documentation lives in README.md.

    Usage:
      1) Fully quit DSH, including the tray icon. No DeepSeek Harness.exe may
         remain in Task Manager, otherwise the new flags are ignored.
      2) Double-click tools\start-dsh-debug.cmd
      3) Confirm deepMode is enabled for browser-hands in DSH settings; the
         plugin reads the same DevToolsActivePort file.

    Security note: the debugging port has no authentication and is bound to
    loopback only. While it is open, any process on this machine can drive this
    DSH instance. Relaunch DSH normally when you are done and the port is gone.
#>

[CmdletBinding()]
param(
    # DSH installation directory.
    [string]$DshRoot = 'C:\Data\APP\dsh',
    # Advanced: explicit executable path (portable or relocated installs).
    [string]$Binary = '',
    # Advanced: explicit DevToolsActivePort path (custom user-data-dir).
    [string]$PortFilePath = '',
    # How long to wait for the port file, in seconds.
    [int]$WaitSeconds = 20
)

$ErrorActionPreference = 'Stop'

function Write-Line {
    param([string]$Text = '', [string]$Color = 'Gray')
    Write-Host $Text -ForegroundColor $Color
}

function Fail {
    param([string]$Message, [string]$Hint)
    Write-Host "[x] $Message" -ForegroundColor Red
    if ($Hint) { Write-Host "    $Hint" -ForegroundColor DarkGray }
    exit 1
}

$exe = if ($Binary) { $Binary } else { Join-Path $DshRoot 'DeepSeek Harness.exe' }
$portFile = if ($PortFilePath) {
    $PortFilePath
} else {
    Join-Path (Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop') 'DevToolsActivePort'
}

Write-Line ''
Write-Line '=== DSH deep-mode launcher ===' 'Cyan'
Write-Line ''

if (-not (Test-Path -LiteralPath $exe)) {
    Fail "Not found: $exe" 'Pass -DshRoot <dir> or -Binary <path to exe>.'
}

# An existing instance swallows the command-line flags, so all of them must go.
# Compare by resolved full path so a DSH installed elsewhere is not misdetected.
$exeFull = [IO.Path]::GetFullPath($exe)
$procName = [IO.Path]::GetFileNameWithoutExtension($exe)
$running = @(
    Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -eq $exeFull) } catch { $false }
    }
)
if ($running.Count -gt 0) {
    $pids = ($running | Select-Object -ExpandProperty Id) -join ', '
    Fail "DSH is already running (PID $pids)." 'Quit it completely first, including the tray icon, or the new flags will be ignored.'
}

# A leftover port file from a previous run would make the poll below succeed
# immediately and hand back a port that nothing is listening on.
if (Test-Path -LiteralPath $portFile) {
    Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
    Write-Line '[i] Removed a stale DevToolsActivePort from a previous run.' 'DarkGray'
}

$launchArgs = @(
    '--remote-debugging-port=0'
    '--remote-allow-origins=devtools://devtools'
)

Write-Line '[i] Starting DSH with a random debugging port ...' 'Gray'
try {
    # Fire-and-forget launch, deliberately NOT UseShellExecute.
    #
    # Two pitfalls were measured on this machine and both are avoided here:
    #  1) Start-Process (or Process.Start) on a .cmd/.bat child BLOCKS the caller
    #     until that child exits whenever the caller's own stdout is redirected to
    #     a pipe or file. A .exe child does not (measured: 311 ms vs never).
    #  2) UseShellExecute = $true can fail with "the process was cancelled by the
    #     user" in hosts whose shell association is unusual, which is exactly the
    #     case under an agent runner.
    # So: use shell-execute = $false, and redirect the child's streams so the
    # launcher never inherits a handle that would keep it waiting.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = ($launchArgs -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = (Split-Path -Parent $exe)

    $child = [System.Diagnostics.Process]::Start($psi)
    $launchPid = $child.Id
} catch {
    Fail "Launch failed: $($_.Exception.Message)" 'Security software may be blocking the --remote-debugging-port flag.'
}

Write-Line "[i] Waiting for the port file (up to $WaitSeconds s) ..." 'Gray'

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$port = $null
while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $portFile) {
        try {
            # Line 1 is the port; line 2 is the browser WebSocket path.
            # Trim before matching: a file written by a shell or editor can
            # carry trailing spaces, and strict ^\d+$ would then never match.
            $lines = @(Get-Content -LiteralPath $portFile -ErrorAction Stop)
            if ($lines.Count -ge 1) {
                $candidate = ([string]$lines[0]).Trim()
                if ($candidate -match '^\d+$') {
                    $port = [int]$candidate
                    break
                }
            }
        } catch {
            # The file exists but is still being written; retry next round.
        }
    }
    Start-Sleep -Milliseconds 500
}

if (-not $port) {
    Fail 'Timed out waiting for the port file.' 'Common causes: the new process merged into an existing instance (check the tray and Task Manager), or security software blocked the debugging flag.'
}

# The port file existing does not prove anything is listening on that port.
$endpoint = "http://127.0.0.1:$port"
$version = $null
try {
    $version = Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 5 -UseBasicParsing
} catch {
    Fail "The port file says $port but $endpoint did not answer." 'DSH may have exited right after starting; check DSH own logs.'
}

Write-Line ''
Write-Line "[ok] CDP port    = $port" 'Green'
Write-Line "[ok] Endpoint    = $endpoint" 'Green'
if ($version.Browser) { Write-Line "[ok] Browser     = $($version.Browser)" 'Green' }
Write-Line ''
Write-Line 'Next steps:' 'Cyan'
Write-Line '  1) In DSH settings, make sure browser-hands deepMode is enabled.' 'Gray'
Write-Line '  2) Ask the agent to run browser_deep_snapshot.' 'Gray'
Write-Line ''
Write-Line 'Quit DSH and relaunch it normally to close the port.' 'DarkGray'
Write-Line ''

# Keep the window open when launched by double-click.
if ($Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) {
    Write-Host 'Press Enter to close ...' -ForegroundColor DarkGray
    [void][Console]::ReadLine()
}
