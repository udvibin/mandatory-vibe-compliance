"""
Galaxy cover-atlas baker.

Composites every track's album art into a handful of 2048x2048 WebP sheets that
the site's galaxy visual samples directly — turning ~950 individual cover
requests on each page load into ~4. Runs in CI from dashboard/generate.py, and
standalone (off site/data.json) for local testing.

Design (see dev/PLAN.md "Galaxy atlas"):
  * Slots are permanent and chronological. Track order in data.json is
    first-share order and append-only, so cover N keeps slot N forever.
    slot -> sheet = slot // PER, cell = slot % PER, into a GRID x GRID tiling.
  * A sheet is FROZEN once it is full (PER cells) AND every cell baked OK; it is
    never rebuilt. Only the partially-filled tail sheet (or one with a failed
    cell, or a brand-new sheet) is re-baked on a given run -> per-run work is
    O(new covers), not O(all covers). Scales to thousands.
  * Sheet filenames carry a content hash (galaxy-<idx>.<hash>.webp) so browsers
    never serve a stale sheet.
  * Persistence lives in dashboard/atlas_manifest.json: the ordered slot->uri
    list, the current sheet filenames, and the set of slots still awaiting a
    successful bake (retried next run).

Security: image bytes come from Spotify's CDN, but we still treat them as
untrusted — Content-Type + byte-size are checked before decode,
Image.MAX_IMAGE_PIXELS guards decompression bombs, and every decode is wrapped
so one bad cover only leaves an empty cell (the client falls back to a colored
quad for any track without a `cell`).
"""
from __future__ import annotations
import io
import os
import json
import hashlib

import requests
from PIL import Image

# Guard decompression bombs: real covers are ~300px (~0.09 MP). Anything above a
# couple MP is bogus for our inputs, so reject well below Pillow's 2x-warn band.
Image.MAX_IMAGE_PIXELS = 4_000_000

CELL = 128                 # px per cover cell — must match galaxy.js
GRID = 16                  # cells per row/col
PER = GRID * GRID          # covers per sheet (256)
ATLAS = CELL * GRID        # sheet edge (2048)
MAX_BYTES = 3_000_000      # per-cover download cap (300px JPEGs are ~30 KB)
WEBP_QUALITY = 82

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
DEFAULT_ATLAS_DIR = os.path.join(_ROOT, "site", "atlas")
DEFAULT_MANIFEST = os.path.join(_HERE, "atlas_manifest.json")


def _load_manifest(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            m = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        m = {}
    m.setdefault("uris", [])
    m.setdefault("sheets", {})   # {str(sheet_idx): filename}
    m.setdefault("failed", [])   # global slots awaiting a successful bake
    return m


def _save_manifest(path: str, m: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=0)


def _download(url: str, session: requests.Session) -> bytes:
    r = session.get(url, timeout=20, stream=True)
    r.raise_for_status()
    ctype = (r.headers.get("Content-Type") or "").lower()
    if not ctype.startswith("image/"):
        raise ValueError(f"not an image: {ctype!r}")
    data = r.raw.read(MAX_BYTES + 1, decode_content=True)
    if len(data) > MAX_BYTES:
        raise ValueError("stream exceeded cap")
    return data


def _fetch_cell(url: str, session: requests.Session) -> Image.Image:
    """Download + decode + downscale one cover to a CELL x CELL RGB tile."""
    img = Image.open(io.BytesIO(_download(url, session)))
    img.load()                       # force full decode inside the try/except
    img = img.convert("RGB")
    if img.size != (CELL, CELL):
        img = img.resize((CELL, CELL), Image.Resampling.LANCZOS)
    return img


def _write_sheet(canvas: Image.Image, idx: int, old_name: str | None) -> str:
    buf = io.BytesIO()
    canvas.save(buf, "WEBP", quality=WEBP_QUALITY, method=6)
    blob = buf.getvalue()
    digest = hashlib.sha1(blob).hexdigest()[:8]
    name = f"galaxy-{idx}.{digest}.webp"
    os.makedirs(DEFAULT_ATLAS_DIR, exist_ok=True)
    with open(os.path.join(DEFAULT_ATLAS_DIR, name), "wb") as f:
        f.write(blob)
    if old_name and old_name != name:
        try:
            os.remove(os.path.join(DEFAULT_ATLAS_DIR, old_name))
        except OSError:
            pass
    return name


def bake_atlas(tracks: dict) -> dict:
    """
    Assign slots, (re)bake only the dirty sheets, and annotate `tracks` in place
    with a `cell: [sheet, cell_in_sheet]` for every successfully-baked cover.

    Returns the `atlas` block for data.json: {cell, grid, sheets:[...filenames]}.
    Tracks without art, or whose cover failed to bake, get no `cell` (the client
    shows a colored quad for those).
    """
    man = _load_manifest(DEFAULT_MANIFEST)
    uris: list[str] = list(man["uris"])
    known = set(uris)
    prev_count = len(uris)

    # append-only slot assignment in data.json (chronological) order
    for uri, t in tracks.items():
        if t.get("art") and uri not in known:
            uris.append(uri)
            known.add(uri)
    appended = set(range(prev_count, len(uris)))

    n_sheets = (len(uris) + PER - 1) // PER
    sheets: dict[str, str] = dict(man["sheets"])
    failed = set(man["failed"])

    def sheet_slots(idx: int) -> range:
        return range(idx * PER, min((idx + 1) * PER, len(uris)))

    # a sheet is dirty if it has no file yet, gained a slot this run, or still
    # holds a slot that failed to bake previously (retry). Frozen full sheets
    # with none of the above are skipped entirely.
    dirty = []
    for idx in range(n_sheets):
        slots = sheet_slots(idx)
        fname = sheets.get(str(idx))
        has_file = bool(fname) and os.path.exists(os.path.join(DEFAULT_ATLAS_DIR, fname))
        if (not has_file or any(s in appended for s in slots)
                or any(s in failed for s in slots)):
            dirty.append(idx)

    print(f"[atlas] {len(uris)} covers, {n_sheets} sheets, "
          f"{len(appended)} new, baking {len(dirty)} sheet(s): {dirty or '—'}")

    session = requests.Session()
    session.headers["User-Agent"] = "vibe-atlas-baker/1"
    failed_after = {s for s in failed if (s // PER) not in dirty}

    for idx in dirty:
        canvas = Image.new("RGB", (ATLAS, ATLAS), (0, 0, 0))
        ok = miss = 0
        for slot in sheet_slots(idx):
            cell = slot % PER
            x, y = (cell % GRID) * CELL, (cell // GRID) * CELL
            try:
                canvas.paste(_fetch_cell(tracks[uris[slot]]["art"], session), (x, y))
                failed_after.discard(slot)
                ok += 1
            except Exception as e:
                failed_after.add(slot)
                miss += 1
                if miss <= 3:
                    print(f"[atlas]   slot {slot} failed: {e}")
        sheets[str(idx)] = _write_sheet(canvas, idx, sheets.get(str(idx)))
        print(f"[atlas]   sheet {idx}: {ok} ok, {miss} failed -> {sheets[str(idx)]}")

    man.update(uris=uris, sheets=sheets, failed=sorted(failed_after))
    _save_manifest(DEFAULT_MANIFEST, man)

    # annotate tracks; emit a cell only for slots that have a good bake
    for slot, uri in enumerate(uris):
        if slot not in failed_after and uri in tracks:
            tracks[uri]["cell"] = [slot // PER, slot % PER]

    return {
        "cell": CELL,
        "grid": GRID,
        "sheets": [sheets[str(i)] for i in range(n_sheets)],
    }


if __name__ == "__main__":
    # Standalone: bake off the committed site/data.json (no Drive/Spotify auth).
    data_path = os.path.join(_ROOT, "site", "data.json")
    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["atlas"] = bake_atlas(data["tracks"])
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    n_cells = sum(1 for t in data["tracks"].values() if "cell" in t)
    print(f"[atlas] wrote {n_cells} cells into {data_path}")
