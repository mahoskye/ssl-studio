# Run once in the guest, in PowerShell as administrator: lets the host reach
# the VM over SSH (vm.sh forwards 127.0.0.1:2222 on the host to port 22 here).
# While `vm.sh serve` runs on the host, this is one line in the guest:
#   irm http://10.0.2.2:8765/enable-ssh.ps1 | iex
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
New-NetFirewallRule -Name sshd-ssl-studio -DisplayName "OpenSSH (SSL Studio VM)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue

# The VM's own public key (vm.sh serve makes it), so vm.sh can sign in
# without a password. Accounts in Administrators read their keys from
# ProgramData, which only SYSTEM and Administrators may hold.
try {
	$key = (Invoke-WebRequest -UseBasicParsing http://10.0.2.2:8765/host-key.txt).Content
	if ($key -is [byte[]]) { $key = [Text.Encoding]::ASCII.GetString($key) }
	$key = $key.Trim()
	if ($key -notmatch '^ssh-') { throw "not a public key" }
	$keys = "$env:ProgramData\ssh\administrators_authorized_keys"
	Set-Content -Path $keys -Value $key -Encoding ascii
	# sshd also refuses the file unless Administrators or SYSTEM owns it, and on
	# Windows 11 a file an administrator creates is owned by their own account.
	icacls.exe $keys /inheritance:r /grant "*S-1-5-32-544:F" /grant "SYSTEM:F" | Out-Null
	icacls.exe $keys /setowner "*S-1-5-32-544" | Out-Null
	Write-Host "Host key installed for administrators ($env:USERNAME is one: $(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')))."
} catch {
	Write-Host "No host key installed ($_): SSH will ask for the password."
}
Write-Host "SSH is on. From the host: tools/windows-vm/vm.sh push"
