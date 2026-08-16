# Slate installer.
#
# Installs the frozen snapshot in dist\slate-app to %LOCALAPPDATA%\Slate and puts
# a Slate icon on the Desktop. Run it again any time to update — the old app
# folder is deleted and replaced, while data and the Canvas token are left alone.

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Snapshot    = Join-Path $ProjectRoot 'dist\slate-app'
$IcoSource   = Join-Path $ProjectRoot 'dist\Slate.ico'
$Payload     = Join-Path $PSScriptRoot 'payload'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Slate'
$AppDir      = Join-Path $InstallRoot 'app'
$DataDir     = Join-Path $InstallRoot 'data'
$Port        = 4174

function Say($msg) { Write-Host "  $msg" }

Write-Host ''
Write-Host '  Installing Slate' -ForegroundColor Green
Write-Host '  ----------------'

# --- checks ---------------------------------------------------------------
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host ''
  Write-Host '  Node.js is not installed, so Slate cannot run.' -ForegroundColor Red
  Write-Host '  Install it from https://nodejs.org (the LTS button), then run this again.'
  Write-Host ''
  Read-Host '  Press Enter to close'
  exit 1
}

if (-not (Test-Path $Snapshot)) {
  Say 'No snapshot found — building one first...'
  & node.exe (Join-Path $PSScriptRoot 'build.js')
  if ($LASTEXITCODE -ne 0) { throw 'snapshot build failed' }
}

$build = 'unknown'
$stampPath = Join-Path $Snapshot 'build.json'
if (Test-Path $stampPath) { $build = (Get-Content $stampPath -Raw | ConvertFrom-Json).build }

# --- stop anything already running ----------------------------------------
# Ask nicely first; the installed app shuts itself down on /api/quit. Raw .NET
# rather than Invoke-RestMethod, which leans on Internet Explorer's engine in
# Windows PowerShell and intermittently fails against localhost.
try {
  $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/quit")
  $req.Method = 'POST'
  $req.Timeout = 3000
  $req.ContentLength = 0
  $req.GetResponse().Close()
  Say 'Closed the running copy of Slate.'
  Start-Sleep -Milliseconds 700
} catch {
  # Not running, or too wedged to answer. Fall through to the hard stop.
}

# Anything still holding the app folder would block the delete below.
$stuck = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -and $_.CommandLine -like "*$InstallRoot*" }
foreach ($p in $stuck) {
  Say "Stopping leftover Slate process $($p.ProcessId)."
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
}
if ($stuck) { Start-Sleep -Milliseconds 400 }

# --- lay down the app -----------------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$firstInstall = -not (Test-Path (Join-Path $DataDir 'slate.db'))

if (Test-Path $AppDir) {
  Remove-Item -Recurse -Force $AppDir
  Say 'Removed the old app files.'
}
Copy-Item -Recurse -Force $Snapshot $AppDir
Say "Installed build $build."

Copy-Item -Force (Join-Path $Payload 'launch.js') $InstallRoot
Copy-Item -Force (Join-Path $Payload 'Slate.vbs') $InstallRoot
Copy-Item -Force $IcoSource (Join-Path $InstallRoot 'Slate.ico')

# --- data + settings, only ever seeded, never overwritten -----------------
if ($firstInstall) {
  $existingDb = Join-Path $ProjectRoot 'data\slate.db'
  if (Test-Path $existingDb) {
    Copy-Item -Force $existingDb (Join-Path $DataDir 'slate.db')
    Say 'Brought your existing Slate data across.'
  }
  $existingNotes = Join-Path $ProjectRoot 'data\notes'
  if (Test-Path $existingNotes) { Copy-Item -Recurse -Force $existingNotes $DataDir }
} else {
  Say 'Left your data and study history untouched.'
}

$projectEnv = Join-Path $ProjectRoot '.env'
$installedEnv = Join-Path $InstallRoot '.env'
if ((Test-Path $projectEnv) -and (-not (Test-Path $installedEnv))) {
  Copy-Item -Force $projectEnv $installedEnv
  Say 'Copied your Canvas settings across.'
}

# --- Desktop shortcut -----------------------------------------------------
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Slate.lnk'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath       = Join-Path $env:SystemRoot 'System32\wscript.exe'
$lnk.Arguments        = '"' + (Join-Path $InstallRoot 'Slate.vbs') + '"'
$lnk.WorkingDirectory = $InstallRoot
$lnk.IconLocation     = (Join-Path $InstallRoot 'Slate.ico') + ',0'
$lnk.Description      = 'Slate - your school tracker'
$lnk.Save()
Say "Put the Slate icon on your Desktop."

Write-Host ''
Write-Host '  Done. Double-click Slate on your Desktop to open it.' -ForegroundColor Green
Write-Host ''

if (-not $env:SLATE_INSTALL_QUIET) { Read-Host '  Press Enter to close' | Out-Null }
