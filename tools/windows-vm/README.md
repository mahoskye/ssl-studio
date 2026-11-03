# A Windows test VM

For checking SSL Studio on Windows (WebView2, paths, opencode's npm shim, the
installer) from a Linux host, with Microsoft's free Windows 11 Enterprise
evaluation (90 days, for testing and evaluation).

1. On the host, once: `sudo apt install qemu-system-x86 qemu-utils ovmf swtpm swtpm-tools`.
2. Download the evaluation ISO from Microsoft's Evaluation Center (it asks for
   a name and email first).
3. `tools/windows-vm/vm.sh install path/to/the.iso` and install Windows. Make a
   local account named `tester` (Sign-in options, then Domain join instead).
4. On the host, `tools/windows-vm/vm.sh serve`. In the guest, in PowerShell as
   administrator: `irm http://10.0.2.2:8765/enable-ssh.ps1 | iex`. That turns
   on SSH and installs the VM's own key (`id_ed25519` in the VM folder, made by
   `serve`, without a passphrase, so your own keys stay out of it). Stop
   `serve` afterwards.
5. On the host: `tools/windows-vm/vm.sh push`, then
   `tools/windows-vm/vm.sh ssh "powershell -ExecutionPolicy Bypass -File provision.ps1"`.
   That installs Git, Node, Bun and opencode 2.2.5, builds the app with the
   pinned language server, and starts the self-test in the guest's desktop.
6. `tools/windows-vm/vm.sh fetch` copies back `selftest.json` and the log.

`install` and `run` start the VM in its own session and return, so closing
the terminal does not stop it; shut it down from inside Windows. `vm.sh
screen` saves a screenshot of the guest (through the QEMU monitor), for
seeing where it is without the window.

The VM's files live in `~/vms/ssl-studio-win11` (`SSL_STUDIO_VM`), never in
the repository. SSH is forwarded on 127.0.0.1 only.
