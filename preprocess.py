import csv
import re
from datetime import datetime

RAW = "data/spotify_songs.csv"
OUT = "data/spotify_clean.csv"

# Tries to extract a year from several common formats
def extract_year(date_str: str):
  if not date_str:
    return None
  s = str(date_str).strip()
  m = re.match(r"^(\d{4})", s)
  if m:
    y = int(m.group(1))
    if 1900 <= y <= 2100:
      return y
  return None

def to_float(x):
  try:
    if x is None:
      return None
    s = str(x).strip()
    if s == "":
      return None
    return float(s)
  except:
    return None

def to_int(x):
  try:
    if x is None:
      return None
    s = str(x).strip()
    if s == "":
      return None
    return int(float(s))
  except:
    return None

# Choose genre column
GENRE_COL_CANDIDATES = ["playlist_genre", "genre"]

NUM_COLS = [
  "track_popularity",
  "danceability",
  "energy",
  "loudness",
  "speechiness",
  "acousticness",
  "instrumentalness",
  "liveness",
  "valence",
  "tempo",
  "duration_ms",
]

TEXT_COLS = ["track_id", "track_name", "track_artist", "track_album_release_date"]

def main():
  with open(RAW, "r", encoding="utf-8", newline="") as f:
    reader = csv.DictReader(f)
    cols = reader.fieldnames or []
    genre_col = None
    for c in GENRE_COL_CANDIDATES:
      if c in cols:
        genre_col = c
        break
    if genre_col is None:
      raise RuntimeError(f"Could not find genre column. Available columns: {cols}")

    out_cols = [
      "id",
      "track_name",
      "track_artist",
      "genre",
      "year",
      "popularity",
      "danceability",
      "energy",
      "loudness",
      "speechiness",
      "acousticness",
      "instrumentalness",
      "liveness",
      "valence",
      "tempo",
      "duration_ms",
    ]

    rows = []
    seen = set()

    for d in reader:
      tid = (d.get("track_id") or "").strip()
      if not tid:
        continue

      # de-dup by track_id
      if tid in seen:
        continue
      seen.add(tid)

      year = extract_year(d.get("track_album_release_date"))
      pop = to_int(d.get("track_popularity"))
      if year is None or pop is None:
        continue

      genre = (d.get(genre_col) or "").strip()
      if not genre:
        continue

      # numeric
      vals = {k: to_float(d.get(k)) for k in NUM_COLS}
      if vals["energy"] is None:
        continue

      rows.append({
        "id": tid,
        "track_name": (d.get("track_name") or "").strip(),
        "track_artist": (d.get("track_artist") or "").strip(),
        "genre": genre,
        "year": year,
        "popularity": pop,
        "danceability": vals["danceability"],
        "energy": vals["energy"],
        "loudness": vals["loudness"],
        "speechiness": vals["speechiness"],
        "acousticness": vals["acousticness"],
        "instrumentalness": vals["instrumentalness"],
        "liveness": vals["liveness"],
        "valence": vals["valence"],
        "tempo": vals["tempo"],
        "duration_ms": to_int(vals["duration_ms"]) if vals["duration_ms"] is not None else None,
      })

    # Keep top 10 genres by track count to keep dashboard readable
    counts = {}
    for r in rows:
      counts[r["genre"]] = counts.get(r["genre"], 0) + 1
    top = set([g for g, _ in sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:10]])
    rows = [r for r in rows if r["genre"] in top]

    with open(OUT, "w", encoding="utf-8", newline="") as f:
      w = csv.DictWriter(f, fieldnames=out_cols)
      w.writeheader()
      w.writerows(rows)

    print(f"Wrote {len(rows)} rows to {OUT}")

if __name__ == "__main__":
  main()
