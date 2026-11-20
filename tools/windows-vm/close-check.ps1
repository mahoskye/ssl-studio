# Runs SSL Studio's close self-test (hutch run selftest-close) and keeps its
# log in close-check.log. It opens a window, so start it in the desktop
# session, as provision.ps1 starts selftest.ps1: from a scheduled task that
# runs only while the user is logged on.
$repo = Join-Path $HOME "ssl-studio"
$log = Join-Path $HOME "close-check.log"
Set-Location $repo
$env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
hutch run selftest-close *> $log
Add-Content $log "exit $LASTEXITCODE"
