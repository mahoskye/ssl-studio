# Runs SSL Studio's self-test in the desktop session (started by the
# "SSL Studio self-test" task) and keeps its log beside the report.
$repo = Join-Path $HOME "ssl-studio"
$log = Join-Path $HOME "selftest.log"
Set-Location $repo
$env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
hutch run selftest *> $log
Add-Content $log "exit $LASTEXITCODE"
