"""
Pixel audit of every rabbit frame against the sprite rules.

Usage: python tools/sprites/audit.py

Checks: the cream rim surrounds every frame, the body is symmetric outside the watch and chain,
feet end on row 53 when he stands on the ground, the hole stays in rows 50 to 55, no doubled
outline corners, no stray pixels, and the blink and mouth overlays cover the eyes and mouth on
every frame that lists them. Prints one line per finding. Exit code 1 when anything is found.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rabbit_px as rp  # noqa: E402

W, H, OFF, CX = rp.W, rp.H, rp.OFF, rp.CX
EIGHT = [(dr, dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if dr or dc]
# States whose pose is asymmetric on purpose, checked only for the rim and outline rules.
ASYMMETRIC = {"confused", "to_confused", "from_confused", "wave", "idle_flick", "idle_tap", "thinking", "to_thinking",
              "aha", "dragged", "panic"}
GROUNDED = {"idle", "listening", "to_listening", "from_listening", "thinking", "to_thinking", "aha", "confused",
            "to_confused", "from_confused", "wave", "sleepy", "to_sleepy", "from_sleepy", "idle_tap", "idle_watch",
            "idle_flick", "land", "panic", "settle"}


def watch_mask(f):
    """Cells the watch, chain and glyphs occupy, grown by two for their outline and rim, plus the mirror of that."""
    cells = {(r, c) for r in range(H) for c in range(W) if (f[r][c] in "gf" and c > CX + 5) or f[r][c] == "y"}
    grown = {(r + dr, c + dc) for r, c in cells for dr in range(-2, 3) for dc in range(-2, 3)}
    return grown | {(r, W - 1 - c) for r, c in grown}


def audit(S):
    out = []
    for name, st in S.items():
        overlay = name.startswith("overlay")
        for i, f in enumerate(st["frames"]):
            tag = f"{name}[{i}]"
            solid = [[f[r][c] != "." for c in range(W)] for r in range(H)]
            # Rim: every transparent cell next to a non rim pixel must be rim.
            if not overlay:
                for r in range(H):
                    for c in range(W):
                        if f[r][c] in ".R":
                            continue
                        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                            rr, cc = r + dr, c + dc
                            if 0 <= rr < H and 0 <= cc < W and f[rr][cc] == ".":
                                out.append(f"{tag}: rim missing next to row {r} col {c}")
                                break
            # Stray pixels: a non rim pixel with no non rim neighbour, diagonals included (the chain is diagonal).
            for r in range(H):
                for c in range(W):
                    if f[r][c] in ".R":
                        continue
                    if not any(0 <= r + dr < H and 0 <= c + dc < W and f[r + dr][c + dc] not in ".R" for dr, dc in EIGHT):
                        out.append(f"{tag}: stray pixel at row {r} col {c}")
            # Doubled outline: a 2 x 2 block that is all outline means the line is two pixels thick there.
            if not overlay:
                for r in range(H - 1):
                    for c in range(W - 1):
                        if f[r][c] == f[r][c + 1] == f[r + 1][c] == f[r + 1][c + 1] == "o":
                            out.append(f"{tag}: doubled outline at row {r} col {c}")
            # Symmetry outside the watch and chain.
            if name not in ASYMMETRIC and not overlay and not (name == "idle" and i == 1) and name != "hole_wait":
                skip = watch_mask(f)
                bad = [(r, c) for r in range(H) for c in range(W // 2)
                       if (r, c) not in skip and f[r][c] != f[r][W - 1 - c] and "h" not in (f[r][c], f[r][W - 1 - c])]
                if bad:
                    out.append(f"{tag}: {len(bad)} pixels break left right symmetry outside the watch, first at {bad[0]}")
            # Feet and hole rows.
            if name in GROUNDED:
                low = max((r for r in range(H) for c in range(W) if f[r][c] not in ".R"), default=-1)
                if low != 53:
                    out.append(f"{tag}: lowest body row is {low}, feet should end on row 53")
            for r in range(H):
                if any(f[r][c] in "HL" for c in range(W)) and not 50 <= r <= 55:
                    out.append(f"{tag}: hole pixels on row {r}, outside rows 50 to 55")
    # Overlays must cover the eyes and mouth on every frame that lists them.
    blink = S["overlay_blink"]["frames"]
    mouth = S["overlay_mouth"]["frames"]
    for name, st in S.items():
        for kind, patches, chars, rows in (("blink", blink, "eh", range(21, 28)), ("mouth", mouth, "ohmM", range(28, 32))):
            if kind not in st.get("overlays", []):
                continue
            dys = st.get("head_dy") or [0] * len(st["frames"])
            for i, f in enumerate(st["frames"]):
                dy = dys[i] if i < len(dys) else 0
                target = {(r, c) for r in rows for c in range(CX - 8, CX + 10) if f[r + dy][c] in chars}
                for j, p in enumerate(patches):
                    covered = {(r + dy, c) for r in range(H) for c in range(W) if p[r][c] != "." and r + dy < H}
                    missing = {(r + dy, c) for r, c in target} - covered
                    if missing:
                        out.append(f"{name}[{i}] {kind} overlay frame {j} misses {len(missing)} face pixels, first at {sorted(missing)[0]}")
    return out


if __name__ == "__main__":
    findings = audit(rp.build())
    for line in findings:
        print(line)
    print(f"{len(findings)} findings")
    sys.exit(1 if findings else 0)
