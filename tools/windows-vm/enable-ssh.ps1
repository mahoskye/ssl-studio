# Run once in the guest, in PowerShell as administrator: lets the host reach
# the VM over SSH (vm.sh forwards 127.0.0.1:2222 on the host to port 22 here).
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
New-NetFirewallRule -Name sshd-ssl-studio -DisplayName "OpenSSH (SSL Studio VM)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue
Write-Host "SSH is on. From the host: tools/windows-vm/vm.sh push"
