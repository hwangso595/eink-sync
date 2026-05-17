# reMarkable-Obsidian Bridge: Testing Guide

**Target device:** reMarkable 1, firmware 3.26.0.68, 512MB RAM
**Scope:** MVP (Sprints 1-3) -- SSH connectivity, file sync, PDF highlight extraction
**Approach:** Safest to riskiest. Stop at any phase if something feels wrong.

---

## PANIC BUTTON -- Emergency Recovery

Read this section first. Bookmark it. If anything goes wrong, come back here.

### Stop all bridge services immediately

```bash
ssh root@10.11.99.1
systemctl stop remarkable-sync-watchdog 2>/dev/null
systemctl stop remarkable-sync 2>/dev/null
systemctl disable remarkable-sync-watchdog 2>/dev/null
systemctl disable remarkable-sync 2>/dev/null
```

### Verify SSH still works

If you can run this, you have not bricked your device:

```bash
ssh root@10.11.99.1 "echo 'SSH is working'"
```

Expected output:

```
SSH is working
```

If SSH works, everything is recoverable. SSH runs independently of xochitl (the reMarkable UI). Even if xochitl crashes, SSH stays up.

### Full uninstall -- remove everything we installed

```bash
ssh root@10.11.99.1

# Stop and remove services
systemctl stop remarkable-sync-watchdog 2>/dev/null
systemctl stop remarkable-sync 2>/dev/null
systemctl disable remarkable-sync-watchdog 2>/dev/null
systemctl disable remarkable-sync 2>/dev/null
rm -f /etc/systemd/system/remarkable-sync.service
rm -f /etc/systemd/system/remarkable-sync-watchdog.service
rm -f /home/root/.config/syncthing/memory-watchdog.sh
systemctl daemon-reload

# Remove Syncthing config
rm -rf /home/root/.config/syncthing

# Remove Entware entirely (this removes Syncthing too)
rm -rf /home/root/.entware

# Remove PATH additions from .bashrc (if present)
sed -i '/\.entware/d' /home/root/.bashrc 2>/dev/null

# Verify cleanup
ls /home/root/.entware 2>/dev/null && echo "WARNING: .entware still exists" || echo "OK: .entware removed"
systemctl is-active remarkable-sync 2>/dev/null || echo "OK: service not running"
```

### Factory reset (absolute last resort)

Only if SSH is inaccessible AND the tablet UI is stuck:

1. On the tablet: **Settings > General > Factory Reset**
2. This wipes all documents but restores a working system
3. If even the UI is frozen, hold the power button for 10+ seconds to force power off, then try again

### If SSH is not responding

1. Unplug USB, wait 5 seconds, reconnect
2. Wake the tablet (press the power button)
3. Check the IP: on the tablet, go to **Settings > Help > About** -- the USB IP should be `10.11.99.1`
4. Try again: `ssh root@10.11.99.1`
5. If using WiFi, make sure both devices are on the same network

---

## Phase 1: Desktop-Only Testing (Zero tablet risk)

This phase runs entirely on your computer. Nothing touches the tablet except a one-time file copy.

### 1.1 Copy files from the tablet via SCP

Connect the tablet via USB. Find your root password on the tablet at **Settings > Help > About > Copyrights and Licenses** (scroll to the bottom).

```bash
# Create a local directory for the copied files
mkdir -p ~/remarkable-test/xochitl

# Copy the entire xochitl directory (read-only operation on the tablet)
scp -r root@10.11.99.1:/home/root/.local/share/remarkable/xochitl/* ~/remarkable-test/xochitl/
```

This may take a while depending on how many documents you have. For a quick test, copy just one document:

```bash
# First, list documents to find a UUID you recognize
ssh root@10.11.99.1 "ls /home/root/.local/share/remarkable/xochitl/*.metadata" | head -5
```

Pick a UUID and copy its files:

```bash
UUID="paste-the-uuid-here"
XOCHITL="/home/root/.local/share/remarkable/xochitl"

scp root@10.11.99.1:$XOCHITL/$UUID.metadata ~/remarkable-test/xochitl/
scp root@10.11.99.1:$XOCHITL/$UUID.content ~/remarkable-test/xochitl/
scp root@10.11.99.1:$XOCHITL/$UUID.pdf ~/remarkable-test/xochitl/
scp -r root@10.11.99.1:$XOCHITL/$UUID/ ~/remarkable-test/xochitl/
```

**What each file does:**
- `.metadata` -- JSON with document name, folder, type (e.g., `"visibleName": "My Paper"`)
- `.content` -- JSON with page UUIDs and format info
- `.pdf` -- The original PDF you uploaded to the tablet
- `UUID/` directory -- Contains per-page `.rm` annotation files (your highlights live here)

### 1.2 Verify the copied files

```bash
# Check that you got the essential files
ls ~/remarkable-test/xochitl/*.metadata | head -5
ls ~/remarkable-test/xochitl/*.content | head -5

# Peek at a metadata file to confirm it is valid JSON
cat ~/remarkable-test/xochitl/*.metadata | python3 -m json.tool | head -20

# Check that .rm annotation files exist for at least one document
ls ~/remarkable-test/xochitl/*/
```

**Good output:** JSON with `"visibleName"`, `"type"`, `"parent"` fields. The `UUID/` directory contains `.rm` files.

**Warning sign:** Empty files, binary garbage when you cat `.metadata`, or no `.rm` files in any subdirectory (means no annotations exist).

### 1.3 Install Python dependencies

The extraction pipeline requires Python 3.9+ with two libraries:

```bash
# Option A: Use a virtual environment (recommended)
cd ~/remarkable-test
python3 -m venv venv
source venv/bin/activate    # On Windows: venv\Scripts\activate

# Option B: Or install globally (simpler but less clean)
pip install rmscene>=0.5.0 PyMuPDF>=1.23.0
```

From the project directory:

```bash
pip install -r extraction/requirements.txt
```

Verify the installs:

```bash
python3 -c "import rmscene; print('rmscene OK:', rmscene.__version__)"
python3 -c "import fitz; print('PyMuPDF OK:', fitz.version)"
```

**Expected output:**

```
rmscene OK: 0.5.x
PyMuPDF OK: (1.23.x, ...)
```

### 1.4 Run the extraction pipeline

```bash
cd /path/to/remarkable-obsidian

# Full scan: process all PDF documents in the copied xochitl directory
python3 extraction/extract.py --xochitl-path ~/remarkable-test/xochitl
```

Progress messages appear on stderr. The JSON result prints to stdout. To save it:

```bash
python3 extraction/extract.py --xochitl-path ~/remarkable-test/xochitl > ~/remarkable-test/output.json 2> ~/remarkable-test/log.txt
```

To process a single document:

```bash
python3 extraction/extract.py --xochitl-path ~/remarkable-test/xochitl --doc-uuid paste-uuid-here
```

### 1.5 Verify the output

```bash
# Pretty-print the JSON output
cat ~/remarkable-test/output.json | python3 -m json.tool | head -60
```

**Expected output format:**

```json
{
    "success": true,
    "documents": [
        {
            "uuid": "abc123-def456-...",
            "visible_name": "My Paper Title",
            "folder_path": "Papers/Machine Learning",
            "doc_type": "pdf",
            "last_modified": 1700000000000,
            "page_count": 42,
            "has_pdf": true,
            "highlights": [
                {
                    "text": "The actual highlighted text from the PDF",
                    "page_number": 5,
                    "color": "yellow",
                    "bounds": {"x": 72.0, "y": 100.0, "width": 400.0, "height": 14.0},
                    "created_at": null
                }
            ],
            "warnings": [],
            "error": null
        }
    ],
    "errors": []
}
```

**What to check:**
- `"success": true` -- pipeline completed without fatal errors
- `"highlights"` array is not empty (if you highlighted text in this PDF on the tablet)
- `"text"` fields contain the actual words you highlighted, not garbage
- `"page_number"` matches where you remember highlighting
- `"color"` matches the highlighter color you used
- `"warnings"` may contain non-fatal messages (okay)
- `"error": null` for each document (no per-document failures)

**Common issues:**
- `"error": "Source PDF not found"` -- the `.pdf` file was not copied. Re-copy it.
- `"error": "rmscene is required"` -- pip install rmscene was not done.
- Empty highlights array -- either no highlights exist on this document, or the .rm files were not copied. Check that `~/remarkable-test/xochitl/UUID/` contains `.rm` files.
- Garbled text -- the PDF may be a scanned image without an OCR layer. Try a different PDF that has selectable text.

### 1.6 Verify markdown rendering

The TypeScript markdown renderer produces output like this for each document. You can verify the format by checking `src/pipeline/markdown-renderer.ts`, but here is what the final output looks like:

```markdown
---
title: "My Paper Title"
source_pdf: "[[My Paper Title.pdf]]"
source_type: pdf
date_highlighted: 2026-03-28
highlight_count: 3
remarkable_uuid: abc123-def456
tags:
  - remarkable
  - highlights
---

# My Paper Title

%%--- eink-sync highlights start ---%%
## Highlights

### Page 5

> The actual highlighted text from the PDF
> -- [[My Paper Title.pdf#page=5|Page 5]]

### Page 12

> Another highlighted passage here
> -- [[My Paper Title.pdf#page=12|Page 12]]

%%--- eink-sync highlights end ---%%
```

The `[[My Paper Title.pdf#page=5|Page 5]]` links are PDF++ compatible. Clicking them in Obsidian (with PDF++ installed) opens the PDF at that page.

---

## Phase 2: Read-Only SSH Probe

This phase connects to the tablet via SSH but only runs read-only commands. Nothing is installed or modified.

### 2.1 Connect via USB

Plug in the USB cable.

```bash
ssh root@10.11.99.1
```

Enter the root password from **Settings > Help > About > Copyrights and Licenses**.

If using WiFi instead: find the tablet's IP at **Settings > Help > About**. Then:

```bash
ssh root@<tablet-wifi-ip>
```

USB (10.11.99.1) is more reliable and recommended for testing.

### 2.2 Check firmware version

```bash
cat /etc/version
```

**Expected output:**

```
3.26.0.68
```

If this does not show `3.26.0.68`, the firmware has been updated. The bridge supports 3.0+, but behavior on untested versions is not guaranteed.

### 2.3 Check device model

```bash
cat /sys/devices/soc0/machine
```

**Expected output for rM1:**

```
reMarkable 1.0
```

Or similar containing "reMarkable" and "1".

### 2.4 Check memory

```bash
free -m
```

**Expected output (approximate for rM1):**

```
              total        used        free      shared  buff/cache   available
Mem:            502         180          80          12         241         290
```

**What to look for:**
- `total` should be around 502MB (this is the rM1's 512MB minus kernel reserved)
- `available` is the important column -- how much RAM is realistically free
- If `available` is below 100MB, the tablet is under memory pressure. Close documents on the tablet and try again.

### 2.5 Check disk space

```bash
df -h /home
df -h /
```

**Expected output:**

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/mmcblk1p3  3.0G  1.2G  1.7G  42% /home
/dev/mmcblk1p2  224M  170M   38M  82% /
```

**What to look for:**
- `/home` is where Entware and Syncthing install. Need at least 100MB free.
- `/` is the root partition. We never write here, but if it is >95% full, that is a concern for general tablet health.

### 2.6 Check xochitl data directory

```bash
ls /home/root/.local/share/remarkable/xochitl/ | head -20
```

**Expected output:** A list of UUID-named files and directories (`.metadata`, `.content`, `.pdf`, UUID dirs).

```bash
# Count your documents
ls /home/root/.local/share/remarkable/xochitl/*.metadata 2>/dev/null | wc -l
```

### 2.7 Check kernel version

```bash
uname -r
```

Expected: something like `5.4.x` or `4.14.x` depending on firmware.

### 2.8 Check if Entware or Syncthing are already present

```bash
test -d /home/root/.entware && echo "Entware: INSTALLED" || echo "Entware: not installed"
command -v syncthing 2>/dev/null && echo "Syncthing: INSTALLED" || echo "Syncthing: not installed"
```

### 2.9 Summary checklist

Run this all-in-one diagnostic:

```bash
echo "=== reMarkable Diagnostic ==="
echo "Firmware: $(cat /etc/version)"
echo "Model: $(cat /sys/devices/soc0/machine 2>/dev/null || echo 'unknown')"
echo "Kernel: $(uname -r)"
echo ""
echo "--- Memory ---"
free -m | grep Mem
echo ""
echo "--- Storage ---"
df -h /home | tail -1
df -h / | tail -1
echo ""
echo "--- xochitl ---"
XDIR="/home/root/.local/share/remarkable/xochitl"
test -d "$XDIR" && echo "Data dir: exists" || echo "Data dir: MISSING"
echo "Documents: $(ls $XDIR/*.metadata 2>/dev/null | wc -l)"
echo ""
echo "--- Existing installs ---"
test -d /home/root/.entware && echo "Entware: installed" || echo "Entware: not installed"
command -v syncthing >/dev/null 2>&1 && echo "Syncthing: installed" || echo "Syncthing: not installed"
echo ""
echo "=== End Diagnostic ==="
```

**Good output looks like:**

```
=== reMarkable Diagnostic ===
Firmware: 3.26.0.68
Model: reMarkable 1.0
Kernel: 5.4.70

--- Memory ---
Mem:            502         180          80          12         241         290

--- Storage ---
/dev/mmcblk1p3  3.0G  1.2G  1.7G  42% /home
/dev/mmcblk1p2  224M  170M   38M  82% /

--- xochitl ---
Data dir: exists
Documents: 47

--- Existing installs ---
Entware: not installed
Syncthing: not installed

=== End Diagnostic ===
```

**Warning signs:**
- `available` RAM below 100MB
- `/home` Avail below 100MB
- Data dir: MISSING
- Firmware version different from expected

### 2.10 Disconnect

```bash
exit
```

No changes were made. You only read system state.

---

## Phase 3: Entware Installation

This phase installs Entware, a lightweight package manager, to `/home/root/.entware`. This is fully reversible.

### 3.1 Prerequisites check

Run the Phase 2 diagnostic first. Confirm:
- [ ] SSH works (`ssh root@10.11.99.1`)
- [ ] At least 100MB free on `/home` partition
- [ ] At least 100MB available RAM
- [ ] Firmware is 3.26.0.68 (or 3.x)
- [ ] Tablet has WiFi internet access (needed for downloading packages)

Verify internet access from the tablet:

```bash
ssh root@10.11.99.1
wget -q --spider http://bin.entware.net/ && echo "Internet: OK" || echo "Internet: FAIL"
```

If "FAIL": the tablet needs WiFi connected to a network with internet access. USB connection alone does not provide internet to the tablet (unless you set up IP forwarding on your computer, which is outside the scope of this guide).

### 3.2 Install Entware

```bash
ssh root@10.11.99.1

# Download and run the Evidlo/remarkable_entware installer
wget -q -O /tmp/entware_install.sh https://raw.githubusercontent.com/Evidlo/remarkable_entware/master/install.sh
sh /tmp/entware_install.sh
```

This takes 1-2 minutes. You will see output about creating directories and downloading packages.

### 3.3 Verify installation

```bash
# Source the updated PATH (or disconnect and reconnect SSH)
source /home/root/.bashrc

# Verify opkg is available
/home/root/.entware/bin/opkg --version
```

**Expected output:**

```
opkg version ... (or similar)
```

```bash
# Check what was installed
/home/root/.entware/bin/opkg list-installed
```

```bash
# Check disk usage of the installation
du -sh /home/root/.entware
```

**Expected disk usage:** ~15-25MB for base Entware.

### 3.4 Test with a small package (optional but recommended)

```bash
/home/root/.entware/bin/opkg update
/home/root/.entware/bin/opkg install htop

# Run htop to verify it works (press q to quit)
/home/root/.entware/bin/htop
```

### 3.5 How to fully uninstall Entware

If anything goes wrong, or you just want to remove it:

```bash
ssh root@10.11.99.1

# Remove the entire Entware directory
rm -rf /home/root/.entware

# Remove PATH additions from .bashrc
sed -i '/\.entware/d' /home/root/.bashrc

# Verify it is gone
ls /home/root/.entware 2>/dev/null && echo "Still exists!" || echo "Removed successfully"
```

This fully reverses the installation. No system files were modified.

---

## Phase 4: Manual Syncthing Test

This phase installs and runs Syncthing **manually** (not as a service). You control when it starts and stops.

### 4.1 Install Syncthing via opkg

```bash
ssh root@10.11.99.1
/home/root/.entware/bin/opkg update
/home/root/.entware/bin/opkg install syncthing
```

Verify:

```bash
/home/root/.entware/bin/syncthing --version
```

**Expected output:**

```
syncthing v1.27.x "..." (...)
```

Check disk usage:

```bash
du -sh /home/root/.entware
```

**Expected:** ~40-60MB total (Entware + Syncthing).

### 4.2 Run Syncthing manually (first time)

Open **two** SSH sessions to the tablet. In the first session, start Syncthing:

```bash
# Session 1: Run Syncthing in the foreground
GOMAXPROCS=1 STNOUPGRADE=1 /home/root/.entware/bin/syncthing serve \
  --no-browser \
  --no-restart \
  --home=/home/root/.config/syncthing
```

Syncthing generates its keys and config on first run. This takes 30-60 seconds. Wait until you see:

```
INFO: GUI and API listening on 127.0.0.1:8384
INFO: Ready to synchronize ...
```

### 4.3 Monitor RAM in the second session

In the second SSH session:

```bash
# Session 2: Monitor memory every 5 seconds
while true; do
    FREE=$(awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo)
    SYNC_RSS=$(ps -o rss= -C syncthing 2>/dev/null | awk '{sum+=$1} END {if(NR>0) printf "%d", sum/1024; else print "0"}')
    echo "$(date '+%H:%M:%S') | Free RAM: ${FREE}MB | Syncthing RSS: ${SYNC_RSS}MB"
    sleep 5
done
```

**Expected output:**

```
14:30:05 | Free RAM: 240MB | Syncthing RSS: 45MB
14:30:10 | Free RAM: 235MB | Syncthing RSS: 48MB
14:30:15 | Free RAM: 238MB | Syncthing RSS: 47MB
```

### 4.4 When to kill Syncthing

**Kill immediately (Ctrl+C in Session 1) if:**
- `Free RAM` drops below **80MB** (tablet will become unresponsive)
- `Syncthing RSS` exceeds **80MB** (consuming too much)
- The tablet's touch screen becomes sluggish or unresponsive

**Healthy ranges for rM1:**
- Syncthing RSS: 30-60MB (target under 64MB)
- Free RAM: stays above 100MB
- Tablet UI remains responsive

### 4.5 Configure local-only discovery

After the first run, Syncthing creates its config at `/home/root/.config/syncthing/config.xml`. Stop Syncthing (Ctrl+C) before editing.

The bridge generates this config automatically, but for manual testing, edit the key settings:

```bash
# Stop Syncthing first (Ctrl+C in Session 1), then:

# The critical privacy settings -- verify these are set:
grep -i "globalAnnounceEnabled" /home/root/.config/syncthing/config.xml
grep -i "relaysEnabled" /home/root/.config/syncthing/config.xml
grep -i "natEnabled" /home/root/.config/syncthing/config.xml
grep -i "crashReportingEnabled" /home/root/.config/syncthing/config.xml
grep -i "urAccepted" /home/root/.config/syncthing/config.xml
```

Edit the config to disable all cloud/relay features:

```bash
sed -i 's|<globalAnnounceEnabled>true</globalAnnounceEnabled>|<globalAnnounceEnabled>false</globalAnnounceEnabled>|' /home/root/.config/syncthing/config.xml
sed -i 's|<relaysEnabled>true</relaysEnabled>|<relaysEnabled>false</relaysEnabled>|' /home/root/.config/syncthing/config.xml
sed -i 's|<natEnabled>true</natEnabled>|<natEnabled>false</natEnabled>|' /home/root/.config/syncthing/config.xml
sed -i 's|<crashReportingEnabled>true</crashReportingEnabled>|<crashReportingEnabled>false</crashReportingEnabled>|' /home/root/.config/syncthing/config.xml
sed -i 's|<urAccepted>[0-9]*</urAccepted>|<urAccepted>-1</urAccepted>|' /home/root/.config/syncthing/config.xml
```

Verify:

```bash
grep -E "(globalAnnounce|relaysEnabled|natEnabled|crashReporting|urAccepted)" /home/root/.config/syncthing/config.xml
```

**Expected:**

```
<globalAnnounceEnabled>false</globalAnnounceEnabled>
<relaysEnabled>false</relaysEnabled>
<natEnabled>false</natEnabled>
<crashReportingEnabled>false</crashReportingEnabled>
<urAccepted>-1</urAccepted>
```

All of these must be `false` or `-1`. This ensures zero data leaves your local network.

### 4.6 Pair with your computer

On your computer, install Syncthing (https://syncthing.net/downloads/) and start it. Open the web UI at `http://127.0.0.1:8384`.

Get the tablet's device ID:

```bash
# On the tablet
/home/root/.entware/bin/syncthing --device-id --home=/home/root/.config/syncthing
```

This prints a string like `AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH`.

On your computer's Syncthing web UI:
1. Click **Add Remote Device**
2. Paste the tablet's device ID
3. Set the address to `tcp://10.11.99.1:22000` (USB) or `tcp://<tablet-wifi-ip>:22000` (WiFi)
4. Save

On the tablet, you will need to add your computer's device ID to the tablet's config similarly. The bridge does this automatically, but for manual testing, use the Syncthing web UI on the tablet via SSH tunnel:

```bash
# On your computer: create an SSH tunnel to the tablet's Syncthing GUI
ssh -L 8385:127.0.0.1:8384 root@10.11.99.1
```

Then open `http://127.0.0.1:8385` in your browser. This is the tablet's Syncthing UI.

Add your computer as a remote device. Then set up a shared folder pointing to `/home/root/.local/share/remarkable/xochitl` as **Send Only**.

### 4.7 Test a sync

1. Start Syncthing on both devices
2. Wait for them to connect (check the Syncthing UIs)
3. The xochitl folder should start syncing to your computer
4. Monitor RAM in Session 2 throughout
5. After the initial sync completes, add a highlight on a PDF on the tablet
6. Watch the modified `.rm` file sync within a few minutes

### 4.8 Stop Syncthing

When done testing:

```bash
# Press Ctrl+C in Session 1 to stop Syncthing on the tablet
```

Syncthing is not running as a service, so it will not start on reboot.

### 4.9 rsync fallback (if Syncthing uses too much RAM)

If Syncthing pushes Free RAM below 100MB consistently, use rsync instead. rsync uses ~2MB per invocation and exits immediately.

Check if rsync is available:

```bash
ssh root@10.11.99.1 "command -v rsync && echo 'Available' || echo 'Not available'"
```

If not available, install via Entware:

```bash
ssh root@10.11.99.1 "/home/root/.entware/bin/opkg install rsync"
```

Run a one-time sync from your computer (pull mode):

```bash
# On your computer:
mkdir -p ~/remarkable-sync/xochitl

rsync -az --delete --partial \
  --exclude='.thumbnails/' \
  --exclude='.cache/' \
  --exclude='*.tmp' \
  -e "ssh -o StrictHostKeyChecking=no" \
  root@10.11.99.1:/home/root/.local/share/remarkable/xochitl/ \
  ~/remarkable-sync/xochitl/
```

To sync periodically, run this command on a schedule (cron on Linux/macOS, Task Scheduler on Windows).

**rsync advantages over Syncthing for rM1:**
- Uses 2MB RAM per run vs 50-100MB continuously
- No background daemon on the tablet
- No pairing or configuration needed
- Works over USB or WiFi

**rsync disadvantages:**
- Not real-time -- you run it manually or on a schedule
- Requires SSH access at sync time (tablet must be awake and connected)

### 4.10 Clean up Syncthing (if not proceeding to Phase 5)

```bash
ssh root@10.11.99.1

# Remove Syncthing config
rm -rf /home/root/.config/syncthing

# Uninstall Syncthing package
/home/root/.entware/bin/opkg remove syncthing
```

---

## Phase 5: Service Activation

**Only proceed here after Phase 4 proves stable.** Specifically:
- [ ] Syncthing ran for at least 30 minutes without Free RAM dropping below 100MB
- [ ] Syncthing RSS stayed under 64MB
- [ ] Tablet UI remained responsive during sync
- [ ] At least one file synced successfully

### 5.1 Create the systemd service

```bash
ssh root@10.11.99.1

# Create the Syncthing service unit
cat > /etc/systemd/system/remarkable-sync.service << 'EOF'
[Unit]
Description=Syncthing file sync for reMarkable-Obsidian bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/root/.entware/bin/syncthing serve --no-browser --no-restart --home=/home/root/.config/syncthing
Restart=on-failure
RestartSec=30
StartLimitIntervalSec=300
StartLimitBurst=5

# Memory constraints: protect xochitl from OOM
MemoryHigh=51M
MemoryMax=64M
OOMScoreAdjust=500

# CPU priority: be nice to xochitl
Nice=19
IOSchedulingClass=idle
IOSchedulingPriority=7

# Environment
Environment=GOMAXPROCS=1
Environment=STNOUPGRADE=1
Environment=HOME=/home/root

[Install]
WantedBy=multi-user.target
EOF
```

### 5.2 Create the memory watchdog

```bash
# Create the watchdog script
mkdir -p /home/root/.config/syncthing

cat > /home/root/.config/syncthing/memory-watchdog.sh << 'EOF'
#!/bin/sh
# Memory watchdog: pauses sync when free RAM drops below 100MB.
# Resumes when free RAM recovers above 120MB.

SERVICE="remarkable-sync"
MIN_FREE_MB=100
RECOVERY_MB=120
CHECK_INTERVAL=30
PAUSED=0

get_free_ram_mb() {
    awk '/^MemAvailable:/ { printf "%d", $2/1024 }' /proc/meminfo
}

while true; do
    FREE_MB=$(get_free_ram_mb)

    if [ "$PAUSED" -eq 0 ] && [ "$FREE_MB" -lt "$MIN_FREE_MB" ]; then
        echo "[watchdog] Free RAM $FREE_MB MB < $MIN_FREE_MB MB. Pausing sync."
        systemctl stop "$SERVICE" 2>/dev/null
        PAUSED=1
    elif [ "$PAUSED" -eq 1 ] && [ "$FREE_MB" -gt "$RECOVERY_MB" ]; then
        echo "[watchdog] Free RAM $FREE_MB MB > $RECOVERY_MB MB. Resuming sync."
        systemctl start "$SERVICE" 2>/dev/null
        PAUSED=0
    fi

    sleep $CHECK_INTERVAL
done
EOF

chmod +x /home/root/.config/syncthing/memory-watchdog.sh

# Create the watchdog service unit
cat > /etc/systemd/system/remarkable-sync-watchdog.service << 'EOF'
[Unit]
Description=Memory watchdog for reMarkable-Obsidian bridge
After=remarkable-sync.service
BindsTo=remarkable-sync.service

[Service]
Type=simple
ExecStart=/bin/sh /home/root/.config/syncthing/memory-watchdog.sh
Restart=on-failure
RestartSec=10
Nice=19
OOMScoreAdjust=900

[Install]
WantedBy=multi-user.target
EOF
```

### 5.3 Enable and start

```bash
# Reload systemd to pick up new unit files
systemctl daemon-reload

# Enable both services (start on boot)
systemctl enable remarkable-sync
systemctl enable remarkable-sync-watchdog

# Start both services now
systemctl start remarkable-sync
systemctl start remarkable-sync-watchdog
```

### 5.4 Verify services are running

```bash
systemctl status remarkable-sync
systemctl status remarkable-sync-watchdog
```

**Expected:** Both show `active (running)`.

```bash
# Check Syncthing memory usage
ps -o rss= -C syncthing | awk '{printf "Syncthing RSS: %d MB\n", $1/1024}'

# Check overall memory
free -m
```

### 5.5 Verify the watchdog works

Test the watchdog by checking its journal:

```bash
journalctl -u remarkable-sync-watchdog -n 20 --no-pager
```

You should see the watchdog running silently. It only logs when it pauses or resumes the sync service.

### 5.6 Test service restart behavior

```bash
# Kill Syncthing to test auto-restart
systemctl kill remarkable-sync

# Wait 30 seconds (RestartSec=30), then check
sleep 35
systemctl is-active remarkable-sync
```

**Expected:** `active` -- systemd restarted it automatically.

### 5.7 Verify sync survives a reboot

```bash
# Reboot the tablet
reboot
```

Wait for the tablet to boot up (1-2 minutes). Reconnect SSH and check:

```bash
ssh root@10.11.99.1
systemctl is-active remarkable-sync
systemctl is-active remarkable-sync-watchdog
```

**Expected:** Both show `active`.

### 5.8 How to disable everything

```bash
ssh root@10.11.99.1

# Stop and disable both services
systemctl stop remarkable-sync-watchdog
systemctl stop remarkable-sync
systemctl disable remarkable-sync-watchdog
systemctl disable remarkable-sync

# Verify they are stopped
systemctl is-active remarkable-sync 2>/dev/null || echo "Sync: stopped"
systemctl is-active remarkable-sync-watchdog 2>/dev/null || echo "Watchdog: stopped"
```

To fully remove (see Panic Button section for the complete uninstall).

### 5.9 Ongoing monitoring

After the services are running, periodically check health:

```bash
ssh root@10.11.99.1

echo "=== Bridge Health Check ==="
echo "Sync service: $(systemctl is-active remarkable-sync 2>/dev/null)"
echo "Watchdog: $(systemctl is-active remarkable-sync-watchdog 2>/dev/null)"
SYNC_RSS=$(ps -o rss= -C syncthing 2>/dev/null | awk '{sum+=$1} END {if(NR>0) printf "%d", sum/1024; else print "0"}')
echo "Syncthing RSS: ${SYNC_RSS}MB"
FREE=$(awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo)
echo "Free RAM: ${FREE}MB"
df -h /home | tail -1 | awk '{print "/home free: " $4}'
echo "=== End Health Check ==="
```

---

## Quick Reference

| What | Path on tablet |
|---|---|
| Firmware version | `/etc/version` |
| Device model | `/sys/devices/soc0/machine` |
| xochitl documents | `/home/root/.local/share/remarkable/xochitl/` |
| Entware installation | `/home/root/.entware/` |
| Syncthing binary | `/home/root/.entware/bin/syncthing` |
| Syncthing config | `/home/root/.config/syncthing/` |
| Syncthing service | `/etc/systemd/system/remarkable-sync.service` |
| Watchdog service | `/etc/systemd/system/remarkable-sync-watchdog.service` |
| Watchdog script | `/home/root/.config/syncthing/memory-watchdog.sh` |
| Root password | Settings > Help > About > Copyrights and Licenses |
| USB IP address | `10.11.99.1` |
| Syncthing protocol port | `22000` |
| Syncthing GUI port | `8384` (localhost only) |

| RAM Threshold | Action |
|---|---|
| Free RAM < 80MB | Kill Syncthing immediately |
| Free RAM < 100MB | Watchdog pauses sync automatically |
| Free RAM > 120MB | Watchdog resumes sync |
| Syncthing RSS > 64MB | Investigate; may need rsync fallback |
| Syncthing RSS > 80MB | Kill and switch to rsync |
