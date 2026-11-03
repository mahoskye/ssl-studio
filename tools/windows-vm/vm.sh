#!/usr/bin/env bash
# A Windows 11 evaluation VM for testing SSL Studio on Windows (QEMU + KVM).
# UEFI with Secure Boot and Microsoft's keys, an emulated TPM 2.0 (swtpm), and
# devices Windows has drivers for out of the box (SATA disk, e1000e network).
# SSH from the host reaches the guest on 127.0.0.1:2222 only.
#
#   tools/windows-vm/vm.sh install <Win11_Enterprise_Eval.iso>   first boot, from the ISO
#   tools/windows-vm/vm.sh run                                    later boots
#   tools/windows-vm/vm.sh push                                   copy this repo in (git bundle)
#   tools/windows-vm/vm.sh ssh [command]                          a shell in the guest
#   tools/windows-vm/vm.sh fetch                                  the guest's selftest.json and log
#
# Needs: qemu-system-x86, ovmf, swtpm (sudo apt install qemu-system-x86 ovmf swtpm swtpm-tools).
# VM files live in $SSL_STUDIO_VM (default ~/vms/ssl-studio-win11), never in the repo.
set -euo pipefail

VM="${SSL_STUDIO_VM:-$HOME/vms/ssl-studio-win11}"
DISK="$VM/disk.qcow2"
VARS="$VM/OVMF_VARS.fd"
TPM="$VM/tpm"
CODE=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd
VARS_TEMPLATE=/usr/share/OVMF/OVMF_VARS_4M.ms.fd
SSH_PORT="${SSL_STUDIO_VM_SSH_PORT:-2222}"
SSH_USER="${SSL_STUDIO_VM_USER:-tester}"
CPUS="${SSL_STUDIO_VM_CPUS:-4}"
MEMORY="${SSL_STUDIO_VM_MEMORY:-8G}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

need() { command -v "$1" >/dev/null || { echo "missing $1: sudo apt install $2" >&2; exit 1; }; }

prepare() {
	need qemu-system-x86_64 qemu-system-x86
	need qemu-img qemu-utils
	need swtpm "swtpm swtpm-tools"
	[[ -r $CODE && -r $VARS_TEMPLATE ]] || { echo "missing UEFI firmware: sudo apt install ovmf" >&2; exit 1; }
	[[ -w /dev/kvm ]] || { echo "no access to /dev/kvm (add yourself to the kvm group)" >&2; exit 1; }
	mkdir -p "$VM" "$TPM"
	[[ -f $DISK ]] || qemu-img create -f qcow2 "$DISK" 80G >/dev/null
	[[ -f $VARS ]] || cp "$VARS_TEMPLATE" "$VARS"
}

start_tpm() {
	# One swtpm per boot; it exits when QEMU disconnects.
	rm -f "$VM/swtpm.sock"
	swtpm socket --tpm2 --tpmstate dir="$TPM" --ctrl type=unixio,path="$VM/swtpm.sock" --daemon --terminate
	for _ in $(seq 50); do [[ -S $VM/swtpm.sock ]] && return; sleep 0.1; done
	echo "swtpm did not start" >&2
	exit 1
}

boot() {
	local extra=("$@")
	start_tpm
	exec qemu-system-x86_64 \
		-name ssl-studio-win11 \
		-enable-kvm -machine q35,smm=on -cpu host -smp "$CPUS" -m "$MEMORY" \
		-global driver=cfi.pflash01,property=secure,value=on \
		-drive if=pflash,format=raw,unit=0,file="$CODE",readonly=on \
		-drive if=pflash,format=raw,unit=1,file="$VARS" \
		-chardev socket,id=chrtpm,path="$VM/swtpm.sock" -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-crb,tpmdev=tpm0 \
		-device ahci,id=ahci -drive file="$DISK",if=none,id=disk0,format=qcow2 -device ide-hd,drive=disk0,bus=ahci.0,bootindex=1 \
		-netdev user,id=net0,hostfwd=tcp:127.0.0.1:"$SSH_PORT"-:22 -device e1000e,netdev=net0 \
		-device qemu-xhci -device usb-tablet \
		-vga virtio -display gtk \
		"${extra[@]}"
}

ssh_guest() { ssh -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$SSH_USER@127.0.0.1" "$@"; }

case "${1:-}" in
install)
	iso="${2:?give the Windows 11 evaluation ISO}"
	prepare
	echo "Installing from $iso. In setup, make a local account named '$SSH_USER' (Sign-in options, then Domain join instead)."
	boot -drive file="$iso",media=cdrom,if=none,id=cd0,readonly=on -device ide-cd,drive=cd0,bus=ahci.1,bootindex=0
	;;
run)
	prepare
	boot
	;;
push)
	# The repo is not published: hand the guest a bundle of main plus the provisioning scripts.
	bundle="$(mktemp -d)/ssl-studio.bundle"
	git -C "$REPO" bundle create "$bundle" main
	scp -P "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$bundle" "$REPO/tools/windows-vm/provision.ps1" "$REPO/tools/windows-vm/selftest.ps1" "$SSH_USER@127.0.0.1:"
	echo "Copied. In the guest: powershell -ExecutionPolicy Bypass -File provision.ps1"
	;;
ssh)
	shift
	ssh_guest "$@"
	;;
fetch)
	# The guest's last self-test report and log, into the VM folder.
	scp -P "$SSH_PORT" "$SSH_USER@127.0.0.1:ssl-studio/selftest.json" "$SSH_USER@127.0.0.1:selftest.log" "$VM/" && cat "$VM/selftest.json"
	;;
*)
	sed -n '2,14p' "$0"
	exit 2
	;;
esac
