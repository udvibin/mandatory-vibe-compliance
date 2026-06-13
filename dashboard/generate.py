"""
Generates site/data.json — the single data file behind the vibe dashboard.

Pipeline:
  1. Load committed history (dashboard/history.json, from the Shridhar archive)
  2. Download the current chat export from Google Drive (same ZIP the sync
     bot uses) and parse it
  3. Splice: history covers everything BEFORE the new export's first message;
     the new export covers everything from there on (no fuzzy dedup needed)
  4. Resolve every music link to a Spotify URI (regex for Spotify links,
     HTML scrape + search for Apple links). All lookups cached in
     dashboard/resolution_cache.json -> re-runs make ~zero API calls.
  5. Fetch track + artist metadata for anything new (free Spotify Web API)
  6. Crunch stats into the data.json schema (see dev/PLAN.md)

Run locally or in CI. Requires the same .env / secrets as scripts/spotify.py.
"""
from __future__ import annotations
import os
import re
import sys
import json
import datetime
from collections import Counter, defaultdict

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from common import parse_chat, message_meta, extract_links, DISPLAY_NAMES
from genres import derive_genres
import spotify as bot

bot.LOG_FILENAME = os.path.join(HERE, "generate_log.txt")

from dotenv import load_dotenv
load_dotenv(os.path.join(ROOT, ".env"))

HISTORY_FILE = os.path.join(HERE, "history.json")
CACHE_FILE = os.path.join(HERE, "resolution_cache.json")
OUTPUT_FILE = os.path.join(ROOT, "site", "data.json")


# ─────────────────────────── load + splice chats ───────────────────────────

def load_history() -> dict:
    with open(HISTORY_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def download_current_export() -> str:
    drive = bot.load_google_drive_service()
    if not drive:
        sys.exit("Drive auth failed")
    folder_id = os.getenv("GOOGLE_DRIVE_INPUT_FOLDER_ID")
    name = os.getenv("TARGET_DRIVE_ARCHIVE_FILENAME", bot.TARGET_DRIVE_ARCHIVE_FILENAME)
    meta = bot.get_target_archive_file(drive, folder_id, name)
    if not meta:
        sys.exit("Chat archive not found in Drive")
    text = bot.download_and_extract_chat_from_archive(drive, meta["id"], meta["name"])
    if not text:
        sys.exit("Failed to extract chat from Drive ZIP")
    return text


def spliced_data() -> tuple[list[dict], list[dict]]:
    """Returns (message_metas, links) across the full merged history."""
    history = load_history()

    current = parse_chat(download_current_export())
    if not current:
        sys.exit("Current export parsed to zero messages")
    cutoff = current[0]["ts"].strftime("%Y-%m-%dT%H:%M")
    print(f"Current export: {len(current)} messages from {current[0]['ts']:%d %b %Y} "
          f"-> {current[-1]['ts']:%d %b %Y} (cutoff {cutoff})")

    msgs = [m for m in history["messages"] if m["ts"] < cutoff]
    links = [l for l in history["links"] if l["ts"] < cutoff]
    print(f"History before cutoff: {len(msgs)} messages, {len(links)} links")

    msgs += [message_meta(m) for m in current]
    links += [l for m in current for l in extract_links(m)]
    print(f"Merged: {len(msgs)} messages, {len(links)} links")
    return msgs, links


# ───────────────────────────── link resolution ─────────────────────────────

def load_cache() -> dict:
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"url_to_uri": {}, "tracks": {}, "artists": {}}


def save_cache(cache: dict) -> None:
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)


def resolve_links(links: list[dict], sp, cache: dict) -> list[dict]:
    """Returns shares: [{ts, s, uri}] for every link that resolves to a track."""
    url_to_uri = cache["url_to_uri"]
    apple_failures = bot.load_apple_failure_cache()
    new_apple = 0

    for link in links:
        url = link["url"]
        if url in url_to_uri:
            continue
        if link["kind"] == "spotify":
            url_to_uri[url] = bot.get_track_uri_from_url(url)
        else:
            if url in apple_failures:
                url_to_uri[url] = None
                continue
            meta = bot.resolve_apple_music_metadata_via_html(url)
            uri = None
            if meta["is_valid"]:
                uri = bot.search_spotify_for_apple_music_track(
                    sp, meta.get("track_name"), meta.get("artist_name"), url)
            url_to_uri[url] = uri
            new_apple += 1
            if new_apple % 10 == 0:
                print(f"  ...scraped {new_apple} new Apple links")

    shares = [{"ts": l["ts"], "s": l["s"], "uri": url_to_uri[l["url"]]}
              for l in links if url_to_uri.get(l["url"])]
    print(f"Resolved {len(shares)} shares ({new_apple} Apple links newly scraped)")
    return shares


def fetch_metadata(sp, uris: list[str], cache: dict) -> None:
    tracks = cache["tracks"]
    # entries cached before art_sm existed get refetched once (cheap, batched)
    missing = [u for u in dict.fromkeys(uris)
               if u not in tracks or (tracks[u] and "art_sm" not in tracks[u])]
    print(f"Fetching metadata: {len(missing)} new tracks ({len(set(uris))} unique total)")
    for i in range(0, len(missing), 50):
        chunk = missing[i:i + 50]
        try:
            items = (sp.tracks(tracks=chunk) or {}).get("tracks") or []
        except Exception as e:
            print(f"  WARN track fetch failed: {e}")
            items = []
        for uri, t in zip(chunk, items + [None] * (len(chunk) - len(items))):
            if not t:
                tracks[uri] = None
                continue
            images = t["album"].get("images") or []
            art = images[1]["url"] if len(images) > 1 else (images[0]["url"] if images else "")
            art_sm = images[-1]["url"] if images else ""  # 64px — mobile galaxy atlas
            tracks[uri] = {
                "name": t["name"],
                "artists": [a["name"] for a in t["artists"]],
                "artist_ids": [a["id"] for a in t["artists"] if a.get("id")],
                "album": t["album"]["name"],
                "art": art,
                "art_sm": art_sm,
                "release": t["album"].get("release_date") or "",
                "popularity": t.get("popularity", 0),
                "duration_ms": t.get("duration_ms", 0),
            }

    artists = cache["artists"]
    wanted = {aid for t in tracks.values() if t for aid in t["artist_ids"]}
    missing_a = [a for a in wanted if a not in artists]
    print(f"Fetching genres: {len(missing_a)} new artists")
    for i in range(0, len(missing_a), 50):
        chunk = missing_a[i:i + 50]
        try:
            items = (sp.artists(chunk) or {}).get("artists") or []
        except Exception as e:
            print(f"  WARN artist fetch failed: {e}")
            items = []
        for aid, a in zip(chunk, items + [None] * (len(chunk) - len(items))):
            artists[aid] = (a.get("genres") or []) if a else []


# ─────────────────────────────── stats engine ───────────────────────────────

def build_data(msgs: list[dict], shares: list[dict], cache: dict) -> dict:
    tracks_meta = cache["tracks"]
    artist_genres = cache["artists"]
    shares = [s for s in shares if tracks_meta.get(s["uri"])]

    # message-level
    msg_count, media_count, banger_count, deleted_count = Counter(), Counter(), Counter(), Counter()
    for m in msgs:
        msg_count[m["s"]] += 1
        media_count[m["s"]] += m["media"]
        banger_count[m["s"]] += m["bangers"]
        deleted_count[m["s"]] += m["deleted"]

    # share-level
    P = defaultdict(lambda: {
        "shares": 0, "unique": set(), "per_year": Counter(), "hours": [0] * 24,
        "weekdays": [0] * 7, "artists": Counter(), "genres": Counter(),
        "pops": [], "durs": [], "decades": Counter(), "first": None,
        "oldest": None, "newest": None,
    })
    years_top = defaultdict(Counter)
    timeline = defaultdict(lambda: {"total": 0, "by": Counter()})
    track_out = {}
    artist_shares = defaultdict(list)   # artist -> [(ts, person)]

    for s in shares:
        t = tracks_meta[s["uri"]]
        ts = datetime.datetime.strptime(s["ts"], "%Y-%m-%dT%H:%M")
        p = P[s["s"]]
        p["shares"] += 1
        p["unique"].add(s["uri"])
        p["per_year"][ts.year] += 1
        p["hours"][ts.hour] += 1
        p["weekdays"][ts.weekday()] += 1
        if p["first"] is None or s["ts"] < p["first"]["ts"]:
            p["first"] = {"ts": s["ts"], "uri": s["uri"]}
        for a in t["artists"]:
            p["artists"][a] += 1
            years_top[ts.year][a] += 1
            artist_shares[a].append((s["ts"], s["s"]))
        for aid in t["artist_ids"]:
            for g in artist_genres.get(aid, []):
                p["genres"][g] += 1
        p["pops"].append(t["popularity"])
        p["durs"].append(t["duration_ms"])
        rel = t["release"][:4]
        if rel.isdigit():
            p["decades"][f"{rel[:3]}0s"] += 1
            if p["oldest"] is None or t["release"] < tracks_meta[p["oldest"]]["release"]:
                p["oldest"] = s["uri"]
            if p["newest"] is None or t["release"] > tracks_meta[p["newest"]]["release"]:
                p["newest"] = s["uri"]

        ym = s["ts"][:7]
        timeline[ym]["total"] += 1
        timeline[ym]["by"][s["s"]] += 1

        if s["uri"] not in track_out:
            track_out[s["uri"]] = {
                "name": t["name"], "artists": t["artists"], "album": t["album"],
                "art": t["art"], "art_sm": t.get("art_sm", ""), "release": t["release"],
                "popularity": t["popularity"], "duration_ms": t["duration_ms"],
                "shared_by": Counter(), "first": {"by": s["s"], "ts": s["ts"]},
            }
        track_out[s["uri"]]["shared_by"][s["s"]] += 1

    people = {}
    for name, p in P.items():
        avg = lambda xs: round(sum(xs) / len(xs), 1) if xs else 0
        people[name] = {
            "display": DISPLAY_NAMES.get(name, name),
            "totals": {
                "shares": p["shares"], "unique": len(p["unique"]),
                "messages": msg_count.get(name, 0), "media": media_count.get(name, 0),
                "bangers": banger_count.get(name, 0), "deleted": deleted_count.get(name, 0),
            },
            "per_year": {str(y): c for y, c in sorted(p["per_year"].items())},
            "hours": p["hours"], "weekdays": p["weekdays"],
            "top_artists": p["artists"].most_common(8),
            "top_genres": p["genres"].most_common(5),
            "decades": dict(p["decades"].most_common()),
            "avg_popularity": avg(p["pops"]),
            "avg_duration_ms": int(avg(p["durs"])),
            "first_share": p["first"],
            "extremes": {"oldest": p["oldest"], "newest": p["newest"]},
        }

    # taste similarity: cosine over artist share-count vectors
    names = sorted(people, key=lambda n: -people[n]["totals"]["shares"])
    def cosine(a: Counter, b: Counter) -> float:
        dot = sum(a[k] * b[k] for k in a.keys() & b.keys())
        na = sum(v * v for v in a.values()) ** 0.5
        nb = sum(v * v for v in b.values()) ** 0.5
        return round(dot / (na * nb), 3) if na and nb else 0.0
    matrix = [[cosine(P[x]["artists"], P[y]["artists"]) for y in names] for x in names]

    # trendsetters: who shared an artist first, before others adopted
    trendsetters = []
    for artist, events in artist_shares.items():
        events.sort()
        sharers = {p for _, p in events}
        if len(sharers) >= 2 and len(events) >= 3:
            trendsetters.append({
                "artist": artist, "first_by": events[0][1], "first_ts": events[0][0][:10],
                "adopters": len(sharers), "total_shares": len(events),
            })
    trendsetters.sort(key=lambda t: (-t["adopters"], -t["total_shares"]))

    # authored facts
    first = min(shares, key=lambda s: s["ts"])
    ft = tracks_meta[first["uri"]]
    most_reshared_uri = max(track_out, key=lambda u: sum(track_out[u]["shared_by"].values()))
    mt = track_out[most_reshared_uri]
    biggest_month = max(timeline.items(), key=lambda kv: kv[1]["total"])
    banger_champ = banger_count.most_common(1)[0]
    facts = [
        {"title": "First song ever",
         "text": f"{ft['name']} — {', '.join(ft['artists'])}, shared by "
                 f"{first['s']} on {first['ts'][:10]}"},
        {"title": "Most re-shared",
         "text": f"{mt['name']} — {', '.join(mt['artists'])}, "
                 f"{sum(mt['shared_by'].values())} times by "
                 + (f"{len(mt['shared_by'])} different people"
                    if len(mt['shared_by']) > 1
                    else f"{next(iter(mt['shared_by']))} alone")},
        {"title": "Biggest month",
         "text": f"{biggest_month[0]}: {biggest_month[1]['total']} songs shared"},
        {"title": "Said 'banger' the most",
         "text": f"{banger_champ[0]}, {banger_champ[1]} times"},
    ]

    tracks_block = {u: {**t, "shared_by": dict(t["shared_by"])} for u, t in track_out.items()}

    all_ts = [m["ts"] for m in msgs]
    return {
        "meta": {
            "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "range": [min(all_ts)[:10], max(all_ts)[:10]],
            "totals": {
                "shares": len(shares), "unique_tracks": len(track_out),
                "messages": len(msgs), "media": sum(media_count.values()),
                "people": len(people), "artists": len(artist_shares),
            },
        },
        "people": people,
        "tracks": tracks_block,
        "years": {str(y): {"shares": sum(c.values()), "top_artists": c.most_common(15)}
                  for y, c in sorted(years_top.items())},
        "timeline": {ym: {"total": v["total"], "by": dict(v["by"])}
                     for ym, v in sorted(timeline.items())},
        "similarity": {"people": names, "matrix": matrix},
        # genre nebulae: artists bucketed into ~9 macro-families (see dashboard/genres.py)
        "genres": derive_genres(tracks_block, cache),
        "trendsetters": trendsetters[:20],
        "facts": facts,
    }


def main():
    msgs, links = spliced_data()

    sp = bot.load_spotify_client()
    if not sp:
        sys.exit("Spotify auth failed")

    cache = load_cache()
    shares = resolve_links(links, sp, cache)
    fetch_metadata(sp, [s["uri"] for s in shares], cache)
    save_cache(cache)

    data = build_data(msgs, shares, cache)

    # Bake the galaxy cover-atlas (delta: only new/tail sheets). Best-effort —
    # a bake failure must not sink the whole run; the site falls back to
    # per-cover loading for any track left without a `cell`.
    try:
        from atlas import bake_atlas
        data["atlas"] = bake_atlas(data["tracks"])
    except Exception as e:
        print(f"WARN atlas bake skipped: {e}")

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)

    size_kb = os.path.getsize(OUTPUT_FILE) / 1024
    t = data["meta"]["totals"]
    print(f"\nWrote {OUTPUT_FILE} ({size_kb:.0f} KB)")
    print(f"  {t['shares']} shares | {t['unique_tracks']} unique tracks | "
          f"{t['messages']} messages | {t['people']} people | {t['artists']} artists")
    print(f"  Range: {data['meta']['range'][0]} -> {data['meta']['range'][1]}")
    for name in data["similarity"]["people"]:
        print(f"  {name:10} {data['people'][name]['totals']['shares']:4} shares")


if __name__ == "__main__":
    main()
