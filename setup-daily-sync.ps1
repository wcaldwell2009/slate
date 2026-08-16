# Registers a Windows Scheduled Task that runs Slate's Canvas sync once a day.
# Run this ONCE (right-click > Run with PowerShell) after you've connected a
# real Canvas token in .env. It does not need admin rights for a user task.
#
# To remove it later:  Unregister-ScheduledTask -TaskName "Slate Daily Sync" -Confirm:$false

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
$script = Join-Path $here "src\cli-sync.js"

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Daily -At 6:30am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd

Register-ScheduledTask -TaskName "Slate Daily Sync" -Action $action -Trigger $trigger -Settings $settings -Force

Write-Host "Done. Slate will sync Canvas every day at 6:30 AM."
Write-Host "It only pulls data from Canvas - it never submits anything."
