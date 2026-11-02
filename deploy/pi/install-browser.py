#!/usr/bin/env python3
"""Install a pinned, frame-only Chromium build without changing OS packages."""

import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path


def main():
    if os.geteuid() == 0:
        raise SystemExit("Run this as the desktop user, not root.")
    if platform.machine() != "aarch64":
        raise SystemExit("The HEVC browser requires an ARM64 Raspberry Pi 5 or CM5.")
    if 'VERSION_CODENAME=trixie' not in Path('/etc/os-release').read_text():
        raise SystemExit("This pinned browser build requires Raspberry Pi OS Trixie.")
    if not Path('/sys/module/rpi_hevc_dec').exists():
        raise SystemExit("The rpi_hevc_dec kernel driver is required. Update Raspberry Pi OS and reboot first.")

    manifest_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name('chromium-hevc.json')
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    release = manifest['release']
    if not re.fullmatch(r'[A-Za-z0-9_.+-]+', release):
        raise SystemExit("Invalid release directory name.")
    installed = subprocess.check_output(['/usr/bin/chromium', '--version'], text=True)
    version = re.search(r'\b(\d+\.\d+\.\d+\.\d+)\b', installed)
    if not version or version[1] != manifest['version']:
        raise SystemExit("The pinned HEVC build must match the OS Chromium version. Update the manifest before installing.")

    browser_root = Path.home() / '.local/share/imframe/browsers'
    browser_root.mkdir(parents=True, exist_ok=True)
    destination = browser_root / release
    binary = destination / 'usr/lib/chromium/chromium'
    fingerprint = hashlib.sha256(manifest_bytes).hexdigest()
    marker = destination / '.manifest-sha256'

    if destination.exists():
        if not marker.is_file() or marker.read_text().strip() != fingerprint or not binary.is_file():
            raise SystemExit(f"Existing browser installation needs repair: {destination}")
    else:
        with tempfile.TemporaryDirectory(prefix='.install-', dir=browser_root) as temporary:
            temporary = Path(temporary)
            extracted = temporary / 'browser'
            extracted.mkdir()
            for asset in manifest['assets']:
                name = asset['name']
                if Path(name).name != name or not name.endswith('.deb'):
                    raise SystemExit("Invalid browser package filename.")
                package = temporary / name
                digest = hashlib.sha256()
                print(f"Downloading {name}", flush=True)
                request = urllib.request.Request(asset['url'], headers={'User-Agent': 'imframe-setup'})
                with urllib.request.urlopen(request, timeout=60) as response, package.open('wb') as output:
                    while block := response.read(1024 * 1024):
                        digest.update(block)
                        output.write(block)
                if digest.hexdigest() != asset['sha256']:
                    raise SystemExit(f"Checksum mismatch: {name}")
                subprocess.run(['dpkg-deb', '--extract', str(package), str(extracted)], check=True)
                package.unlink()

            # Reuse the OS's root-owned sandbox helper; never disable sandboxing.
            sandbox = extracted / 'usr/lib/chromium/chrome-sandbox'
            sandbox.unlink(missing_ok=True)
            system_sandbox = Path('/usr/lib/chromium/chrome-sandbox')
            if system_sandbox.is_file():
                info = system_sandbox.stat()
                if info.st_uid == 0 and info.st_mode & stat.S_ISUID:
                    sandbox.symlink_to(system_sandbox)
            (extracted / '.manifest-sha256').write_text(fingerprint + '\n')
            shutil.move(str(extracted), str(destination))

    configuration = Path.home() / '.config/imframe/browser.env'
    configuration.parent.mkdir(parents=True, exist_ok=True)
    configuration.write_text('IMFRAME_CHROMIUM=' + json.dumps(str(binary)) + '\n')
    configuration.chmod(0o600)
    print(f"Installed frame browser: {binary}")
    print("System Chromium packages were left unchanged.")


if __name__ == '__main__':
    main()
