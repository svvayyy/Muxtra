#!/bin/bash
# Muxtra builder. Runs as root inside the hidden builder VM.
#
# Reads the settings in config.sh (written by `muxtra build` from
# muxtra.toml) and turns the blank disk with serial "muxtra-out" into a
# bootable Debian system for an Intel Mac.
#
# Lines starting with MUXTRA-STEP are progress markers that `muxtra build`
# reads from the serial console. Keep them stable.

set -euo pipefail
shopt -s nullglob

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$here/config.sh"

OUT=/dev/disk/by-id/virtio-muxtra-out
TARGET=/mnt/muxtra
TOTAL_STEPS=7
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8

step() { echo "MUXTRA-STEP $1/$TOTAL_STEPS $2"; }
in_target() { chroot "$TARGET" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8 HOME=/root \
  SYSTEMD_RELAX_ESP_CHECKS=1 "$@"; }
apt_target() { in_target apt-get -o Dpkg::Use-Pty=0 -o APT::Install-Recommends=0 "$@"; }

cleanup() {
  for m in "$TARGET/boot/efi" "$TARGET/home" "$TARGET/dev/pts" "$TARGET/dev" \
           "$TARGET/proc" "$TARGET/sys" "$TARGET/run" "$TARGET"; do
    mountpoint -q "$m" && umount -l "$m" || true
  done
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
step 1 "Preparing the builder"
apt-get -o Dpkg::Use-Pty=0 update -qq
builder_packages=(mmdebstrap dosfstools gdisk e2fsprogs parted)
if [ "$(dpkg --print-architecture)" != amd64 ]; then
  # Intel programs run through emulation, only while building.
  builder_packages+=(qemu-user-static binfmt-support arch-test)
fi
apt-get -o Dpkg::Use-Pty=0 install -y -qq --no-install-recommends "${builder_packages[@]}" >/dev/null
if [ "$(dpkg --print-architecture)" != amd64 ]; then
  systemctl restart systemd-binfmt 2>/dev/null || update-binfmts --enable qemu-x86_64 || true
  test -e /proc/sys/fs/binfmt_misc/qemu-x86_64 || { echo "Could not set up Intel emulation in the builder." >&2; exit 1; }
fi
test -b "$OUT" || { echo "The output disk is missing from the builder." >&2; exit 1; }

# ---------------------------------------------------------------------------
step 2 "Laying out the disk"
# EFI, two system slots (A runs now, B is for safe updates later), and home.
sgdisk --zap-all "$OUT" >/dev/null
sgdisk \
  -n1:0:+512M     -t1:ef00 -c1:muxtra-efi \
  -n2:0:+"$ROOT_SIZE" -t2:8304 -c2:muxtra-root-a \
  -n3:0:+"$ROOT_SIZE" -t3:8304 -c3:muxtra-root-b \
  -n4:0:0         -t4:8302 -c4:muxtra-home \
  "$OUT" >/dev/null
partprobe "$OUT" || true
udevadm settle
mkfs.vfat -F 32 -n MUXTRA "$OUT-part1" >/dev/null
mkfs.ext4 -q -F -L muxtra-root-a "$OUT-part2"
mkfs.ext4 -q -F -L muxtra-root-b "$OUT-part3"
mkfs.ext4 -q -F -L muxtra-home "$OUT-part4"

mkdir -p "$TARGET"
mount "$OUT-part2" "$TARGET"
rmdir "$TARGET/lost+found"

# ---------------------------------------------------------------------------
step 3 "Installing Debian $DEBIAN"
mmdebstrap --quiet --arch=amd64 --variant=minbase \
  --components="main contrib non-free non-free-firmware" \
  --include="$(IFS=,; echo "${PACKAGES[*]}")" \
  "$DEBIAN" "$TARGET" \
  "deb http://deb.debian.org/debian $DEBIAN main contrib non-free non-free-firmware" \
  "deb http://deb.debian.org/debian $DEBIAN-updates main contrib non-free non-free-firmware" \
  "deb http://security.debian.org/debian-security $DEBIAN-security main contrib non-free non-free-firmware"

mount --bind /dev "$TARGET/dev"
mount --bind /dev/pts "$TARGET/dev/pts"
mount -t proc proc "$TARGET/proc"
mount -t sysfs sys "$TARGET/sys"
mount -t tmpfs tmpfs "$TARGET/run"
mkdir -p "$TARGET/boot/efi"
mount -o umask=0077 "$OUT-part1" "$TARGET/boot/efi"
mount "$OUT-part4" "$TARGET/home"
rmdir "$TARGET/home/lost+found"
# DNS for the build. The final link to systemd-resolved is set in step 7.
rm -f "$TARGET/etc/resolv.conf"
cp /etc/resolv.conf "$TARGET/etc/resolv.conf"

# ---------------------------------------------------------------------------
step 4 "Adding modules: ${MODULE_LABEL}"
# Firmware and microcode this Mac model needs.
extra=("${HW_PACKAGES[@]}")
if [ -n "$NODE_MAJOR" ]; then
  install -d -m 0755 "$TARGET/etc/apt/keyrings"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | in_target gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > "$TARGET/etc/apt/sources.list.d/nodesource.list"
  extra+=(nodejs libatomic1)
fi
if [ "$WITH_TAILSCALE" = 1 ]; then
  curl -fsSL "https://pkgs.tailscale.com/stable/debian/$DEBIAN.noarmor.gpg" \
    -o "$TARGET/usr/share/keyrings/tailscale-archive-keyring.gpg"
  curl -fsSL "https://pkgs.tailscale.com/stable/debian/$DEBIAN.tailscale-keyring.list" \
    -o "$TARGET/etc/apt/sources.list.d/tailscale.list"
  extra+=(tailscale)
fi
if [ ${#extra[@]} -gt 0 ]; then
  apt_target update -qq
  apt_target install -y -qq "${extra[@]}" >/dev/null
fi
if [ -n "$TAILSCALE_SERVER" ]; then
  install -d "$TARGET/etc/muxtra"
  printf '%s\n' "$TAILSCALE_SERVER" > "$TARGET/etc/muxtra/tailscale-server"
fi

# ---------------------------------------------------------------------------
step 5 "Setting up $HOST_NAME"
echo "$HOST_NAME" > "$TARGET/etc/hostname"
cat > "$TARGET/etc/hosts" <<EOF
127.0.0.1 localhost
127.0.1.1 $HOST_NAME
::1 localhost ip6-localhost ip6-loopback
EOF
cat > "$TARGET/etc/fstab" <<'EOF'
# The root slot (A or B) comes from the kernel command line.
PARTLABEL=muxtra-efi   /boot/efi  vfat  umask=0077          0 2
# x-systemd.growfs: home grows to fill whatever drive Muxtra lands on.
PARTLABEL=muxtra-home  /home      ext4  defaults,noatime,x-systemd.growfs  0 2
EOF

# The account.
in_target useradd --create-home --shell /bin/bash --groups sudo "$USER_NAME"
if [ -n "$PASSWORD_HASH" ]; then
  in_target usermod --password "$PASSWORD_HASH" "$USER_NAME"
else
  in_target passwd --delete "$USER_NAME" >/dev/null
  # No password: sign in on the Mac's own screen automatically.
  install -d "$TARGET/etc/systemd/system/getty@tty1.service.d"
  cat > "$TARGET/etc/systemd/system/getty@tty1.service.d/muxtra-autologin.conf" <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $USER_NAME --noclear %I \$TERM
EOF
fi
if [ "$SUDO_PASSWORD" = 0 ]; then
  echo "$USER_NAME ALL=(ALL) NOPASSWD:ALL" > "$TARGET/etc/sudoers.d/muxtra"
  chmod 0440 "$TARGET/etc/sudoers.d/muxtra"
fi

# SSH: keys only, and every Mac gets its own host keys on first boot.
if [ "$WITH_SSH" = 1 ]; then
  home="$TARGET/home/$USER_NAME"
  install -d -m 0700 "$home/.ssh"
  printf '%s\n' "${SSH_KEYS[@]}" > "$home/.ssh/authorized_keys"
  chmod 0600 "$home/.ssh/authorized_keys"
  in_target chown -R "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.ssh"
  cat > "$TARGET/etc/ssh/sshd_config.d/muxtra.conf" <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
  rm -f "$TARGET"/etc/ssh/ssh_host_*
  cat > "$TARGET/etc/systemd/system/muxtra-ssh-host-keys.service" <<'EOF'
[Unit]
Description=Create this Mac's own SSH host keys
Before=ssh.service
ConditionPathExists=!/etc/ssh/ssh_host_ed25519_key

[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -A

[Install]
WantedBy=multi-user.target
EOF
  in_target systemctl enable muxtra-ssh-host-keys.service >/dev/null
fi

# Networking: networkd for cables, Avahi so `name.local` works.
install -d "$TARGET/etc/systemd/network"
if [ "$WITH_ETHERNET" = 1 ]; then
  cat > "$TARGET/etc/systemd/network/20-ethernet.network" <<'EOF'
[Match]
Name=en* eth*

[Network]
DHCP=yes
EOF
fi
if [ "$WITH_THUNDERBOLT" = 1 ]; then
  # A direct cable to another Mac. Both sides pick link-local addresses.
  cat > "$TARGET/etc/systemd/network/30-thunderbolt.network" <<'EOF'
[Match]
Name=thunderbolt*

[Network]
DHCP=yes
LinkLocalAddressing=yes
EOF
fi
if [ "$WITH_WIFI" = 1 ]; then
  # iwd joins saved networks on its own; networkd gets the address.
  cat > "$TARGET/etc/systemd/network/25-wireless.network" <<'EOF'
[Match]
Name=wl*

[Network]
DHCP=yes
EOF
  install -d -m 0700 "$TARGET/var/lib/iwd"
  for i in "${!WIFI_FILES[@]}"; do
    printf '%s' "${WIFI_CONFIGS[$i]}" > "$TARGET/var/lib/iwd/${WIFI_FILES[$i]}"
    chmod 0600 "$TARGET/var/lib/iwd/${WIFI_FILES[$i]}"
  done
  in_target systemctl enable iwd >/dev/null
fi
in_target systemctl enable systemd-networkd systemd-resolved avahi-daemon >/dev/null
# Never hold up boot waiting for a cable that is not plugged in.
install -d "$TARGET/etc/systemd/system/systemd-networkd-wait-online.service.d"
cat > "$TARGET/etc/systemd/system/systemd-networkd-wait-online.service.d/muxtra.conf" <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/lib/systemd/systemd-networkd-wait-online --any --timeout=15
EOF

for service in "${START[@]}"; do
  in_target systemctl enable "$service" >/dev/null
done

# ---------------------------------------------------------------------------
step 6 "Installing the bootloader"
# Text console on screen and on the serial port, which `muxtra check` reads.
cmdline="root=PARTLABEL=muxtra-root-a rw quiet console=tty0 console=ttyS0,115200"
if [ "$WITH_WIFI" = 1 ] && [ -n "$WIFI_COUNTRY" ]; then
  # Wi-Fi rules for this country. Some Broadcom chips (2016 MacBook Pro)
  # fail to connect under the default worldwide rules.
  cmdline="$cmdline cfg80211.ieee80211_regdom=$WIFI_COUNTRY"
fi
echo "$cmdline" > "$TARGET/etc/kernel/cmdline"
echo muxtra > "$TARGET/etc/kernel/entry-token"
if [ ${#EARLY_MODULES[@]} -gt 0 ]; then
  # Load these drivers before the login prompt (the built-in keyboard).
  printf '%s\n' "${EARLY_MODULES[@]}" >> "$TARGET/etc/initramfs-tools/modules"
  in_target update-initramfs -u -k all >/dev/null
fi
# Hide the builder's own firmware so nothing tries to change its boot
# settings: swap in an empty /sys while systemd-boot installs. The Mac
# finds systemd-boot at the standard EFI/BOOT/BOOTX64.EFI path anyway.
umount "$TARGET/sys"
mount -t tmpfs nosys "$TARGET/sys"
apt_target install -y -qq systemd-boot >/dev/null
in_target bootctl install --no-variables --esp-path=/boot/efi >/dev/null
umount "$TARGET/sys"
mount -t sysfs sys "$TARGET/sys"
for kernel in "$TARGET"/boot/vmlinuz-*; do
  version="${kernel##*/vmlinuz-}"
  in_target kernel-install add "$version" "/boot/vmlinuz-$version" "/boot/initrd.img-$version"
done
ls "$TARGET"/boot/efi/muxtra/*/linux >/dev/null || { echo "The kernel did not reach the EFI partition." >&2; exit 1; }

# ---------------------------------------------------------------------------
step 7 "Cleaning up"
apt_target clean
# Now that downloads are done, hand DNS to systemd-resolved on the Mac.
ln -sf /run/systemd/resolve/stub-resolv.conf "$TARGET/etc/resolv.conf"
: > "$TARGET/etc/machine-id"
rm -f "$TARGET/var/lib/dbus/machine-id"
sync
echo "MUXTRA-SIZE $(du -sxm "$TARGET" | cut -f1)"
