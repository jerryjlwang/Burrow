"""
Watch for a scan and put the guest next to the rabbit.

    python3 tools/sprites/scan_watch.py

Leave it running on the demo laptop. Drop a photo of the sketch into `scans/` (a phone over AirDrop,
or the laptop's own camera) and within a second the sprite is built and written into
`extension/dist/characters/guest/`, which the running extension picks up on its own: no rebuild, no
reload, because `characters/*` is already web accessible. The newest photo wins, so a second shot
just replaces the first.
"""

import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
WATCH = os.path.join(ROOT, "scans")
DIST = os.path.join(ROOT, "extension", "dist", "characters", "guest")
EXTS = (".jpg", ".jpeg", ".png", ".heic", ".webp")


def newest():
    try:
        files = [os.path.join(WATCH, f) for f in os.listdir(WATCH) if f.lower().endswith(EXTS)]
    except OSError:
        return None
    return max(files, key=os.path.getmtime) if files else None


def main():
    os.makedirs(WATCH, exist_ok=True)
    print(f"[watch] drop a photo into {WATCH}")
    seen = None
    while True:
        f = newest()
        if f and f != seen:
            seen = f
            t0 = time.time()
            r = subprocess.run(
                [sys.executable, os.path.join(HERE, "scan.py"), "--in", f, "--name", "guest", "--out", DIST],
                capture_output=True, text=True,
            )
            sys.stdout.write(r.stdout or "")
            sys.stderr.write(r.stderr or "")
            if r.returncode == 0:
                print(f"[watch] {os.path.basename(f)} -> the guest is on screen in about {time.time() - t0 + 2:.0f}s")
        time.sleep(0.5)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
