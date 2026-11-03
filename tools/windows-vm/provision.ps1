# Sets the guest up to build and test SSL Studio, then builds it and starts
# the self-test in the logged-in desktop. Run in the guest (over SSH is fine)
# after vm.sh push has copied ssl-studio.bundle here.
#
#   powershell -ExecutionPolicy Bypass -File provision.ps1
$ErrorActionPreference = "Stop"
$repo = Join-Path $HOME "ssl-studio"

# Native commands do not stop the script on failure by themselves.
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }
function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Refresh-Path {
	$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

# Tools: Git, Node (for npx and npm), Bun, and the Visual C++ runtime, which
# Hutch's runtime libraries need and a fresh Windows does not have.
foreach ($id in "Git.Git", "OpenJS.NodeJS.LTS", "Oven-sh.Bun", "Microsoft.VCRedist.2015+.x64") {
	winget install --id $id --exact --silent --source winget --accept-source-agreements --accept-package-agreements
}
Refresh-Path

# opencode 2.2.x, the version on the Windows machine SSL Studio targets.
if (-not (Have opencode)) { npm install --global "@opencode/cli@2.2.5"; Refresh-Path }
opencode --version; Check "opencode"

# The repository, from the bundle (it is not published).
if (-not (Test-Path $repo)) { git clone --branch main (Join-Path $HOME "ssl-studio.bundle") $repo }
else { git -C $repo pull (Join-Path $HOME "ssl-studio.bundle") main }
Set-Location $repo

# Electrobun's toolchain, packages, the pinned language server, a release build.
npx --yes electrobun@2.0.5 prepare; Check "electrobun prepare"
$hutch = Get-ChildItem -Recurse -Filter hutch.exe (Join-Path $HOME ".hutch\npm\electrobun\2.0.5") | Select-Object -First 1
if (-not $hutch) { throw "hutch.exe not found after electrobun prepare" }
$env:Path = "$($hutch.DirectoryName);$env:Path"
[Environment]::SetEnvironmentVariable("Path", "$($hutch.DirectoryName);" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
hutch install --frozen-lockfile; Check "hutch install"
bun scripts/assets.ts; Check "assets"
bun test; Check "bun test"
bun scripts/bundle-lsp.ts --download; Check "bundle-lsp"
hutch run build; Check "hutch run build"

# The self-test opens a window, so it must run in the desktop session: a
# task that runs only while the user is logged on runs there, even when
# started from SSH.
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$(Join-Path $HOME 'selftest.ps1')`""
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "SSL Studio self-test" -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName "SSL Studio self-test"
Write-Host "Self-test started in the desktop session. When it finishes, from the host: tools/windows-vm/vm.sh fetch"
