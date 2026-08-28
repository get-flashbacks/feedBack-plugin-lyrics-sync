"""Lyrics Sync plugin — author, time-align, and hand-edit synced lyrics."""

import json
import os
import shutil
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath
from urllib.parse import quote

import yaml
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response

_config_dir = None
_get_dlc_dir = None

SLOPPAK_CACHE_DIR = None


def _safe_dlc_path(dlc: Path, filename: str) -> Path | None:
    """Resolve `filename` under `dlc` and refuse anything that escapes it.

    `filename` arrives straight from a JSON request body, so it can contain
    `..` traversal segments or be an absolute path — `dlc / filename`
    discards `dlc` entirely when `filename` is absolute. Without this guard
    `_find_vocals_stem`/save handlers would read/write files anywhere on disk
    that happens to be named `*.sloppak`/`*.feedpak`, not just inside the
    configured DLC folder. Mirrors the containment check core's
    `lib/dlc_paths._resolve_dlc_path` applies for its own filename-bound
    handlers (lexical normalization, not symlink-following, so a DLC folder
    reached through a mounted junction still resolves).
    """
    if not filename:
        return None
    safe = filename.replace("\\", "/")
    if "\x00" in safe:
        return None
    if (PurePosixPath(safe).is_absolute()
            or PureWindowsPath(safe).is_absolute()
            or PureWindowsPath(safe).drive):
        return None
    try:
        root = dlc.resolve()
        candidate = Path(os.path.normpath(root / safe))
        if not candidate.is_relative_to(root):
            return None
    except (ValueError, OSError):
        return None
    return candidate


def _safe_source_path(source_dir: Path, rel: str) -> Path | None:
    """Resolve a manifest-declared relative path under `source_dir`,
    refusing anything that escapes it.

    Manifest content (`stems[].file`, `lyrics`) is untrusted — it comes from
    inside a `.sloppak`/`.feedpak` package that may have been authored or
    shared by someone other than the library owner. Without this check,
    `source_dir / rel` has two failure modes: an absolute `rel` (e.g.
    `/etc/passwd`) silently discards `source_dir` entirely (a pathlib
    quirk), and a `rel` containing `..` walks out of the pack directory.
    Either lets a crafted pack make this plugin read an arbitrary local
    file — and for the vocals stem, upload its bytes to the configured
    alignment/demucs server.
    """
    if not rel:
        return None
    safe = str(rel).replace("\\", "/")
    if "\x00" in safe:
        return None
    if (PurePosixPath(safe).is_absolute()
            or PureWindowsPath(safe).is_absolute()
            or PureWindowsPath(safe).drive):
        return None
    try:
        root = source_dir.resolve()
        candidate = Path(os.path.normpath(root / safe))
        if not candidate.is_relative_to(root):
            return None
    except (ValueError, OSError):
        return None
    return candidate


# ── Manifest helpers ────────────────────────────────────────────────────────

def _manifest_path(source_dir: Path) -> Path:
    p = source_dir / "manifest.yaml"
    if not p.exists():
        alt = source_dir / "manifest.yml"
        if alt.exists():
            return alt
    return p


def _read_manifest(source_dir: Path) -> dict:
    mp = _manifest_path(source_dir)
    return yaml.safe_load(mp.read_text(encoding="utf-8")) or {}


def _write_manifest(source_dir: Path, manifest: dict) -> None:
    mp = _manifest_path(source_dir)
    mp.write_text(
        yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


def _resolve_sloppak(filename: str):
    """Resolve a sloppak filename to its source dir, manifest, and zip flag.

    Returns `(source_dir, manifest, dlc_path, is_zip)` or `None` when the
    target is missing or isn't a sloppak.
    """
    import sloppak as sloppak_mod

    if not filename:
        return None
    dlc = _get_dlc_dir() if _get_dlc_dir else None
    if not dlc:
        return None
    dlc_path = _safe_dlc_path(dlc, filename)
    if dlc_path is None or not dlc_path.exists():
        return None
    if not sloppak_mod.is_sloppak(dlc_path):
        return None
    source_dir = sloppak_mod.resolve_source_dir(filename, dlc, SLOPPAK_CACHE_DIR)
    manifest = _read_manifest(source_dir)
    return source_dir, manifest, dlc_path, dlc_path.is_file()


def _get_demucs_server_url() -> str | None:
    """Get the configured demucs server URL from config.json."""
    config_file = _config_dir / "config.json"
    if config_file.exists():
        try:
            cfg = json.loads(config_file.read_text())
            url = cfg.get("demucs_server_url", "")
            if url:
                return url.rstrip("/")
        except Exception:
            pass
    return None


def _find_vocals_stem(filename: str) -> Path | None:
    """Find the vocals stem file for a sloppak song."""
    resolved = _resolve_sloppak(filename)
    if resolved is None:
        return None
    source_dir, manifest, _dlc_path, _is_zip = resolved

    for s in manifest.get("stems", []) or []:
        if not isinstance(s, dict):
            continue
        sid = str(s.get("id", "")).lower()
        sfile = str(s.get("file", ""))
        if sid != "vocals" or not sfile:
            continue
        vocals_path = _safe_source_path(source_dir, sfile)
        if vocals_path is not None and vocals_path.exists():
            return vocals_path
    return None


def _format_lrc(segments: list[dict]) -> str:
    """Convert alignment segments to standard LRC format."""
    lines = []
    for seg in segments:
        t = seg["start"]
        minutes = int(t // 60)
        seconds = t % 60
        lines.append(f"[{minutes:02d}:{seconds:05.2f}]{seg['text']}")
    return "\n".join(lines) + "\n"


def _format_lrc_word_level(segments: list[dict]) -> str:
    """Convert word-level alignment segments to enhanced LRC format."""
    lines = []
    for seg in segments:
        t = seg["start"]
        minutes = int(t // 60)
        seconds = t % 60
        text = seg["text"]
        # Word-level: include inline timestamps for each word
        if "words" in seg:
            word_parts = []
            for w in seg["words"]:
                wt = w["start"]
                wm = int(wt // 60)
                ws = wt % 60
                word_parts.append(f"<{wm:02d}:{ws:05.2f}>{w['text']}")
            text = " ".join(word_parts)
        lines.append(f"[{minutes:02d}:{seconds:05.2f}]{text}")
    return "\n".join(lines) + "\n"


# ── Persistence: write lyrics.json + patch manifest + re-zip ──────────────────

def _atomic_write_json(path: Path, payload) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _rezip_sloppak(source_dir: Path, output_path: Path) -> None:
    """Replace the zip-form sloppak with the contents of source_dir.

    Keeps a one-time `.bak` of the original next to it so a botched run
    is recoverable. Writes via `.tmp` + atomic replace so a crash mid-zip
    doesn't leave a half-written archive.
    """
    if output_path.exists() and output_path.is_file():
        backup = output_path.with_suffix(output_path.suffix + ".bak")
        if not backup.exists():
            shutil.copy2(output_path, backup)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_zip = output_path.with_suffix(output_path.suffix + ".tmp")
    if tmp_zip.exists():
        tmp_zip.unlink()
    with zipfile.ZipFile(str(tmp_zip), "w", zipfile.ZIP_DEFLATED) as zf:
        for f in source_dir.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(source_dir).as_posix())
    tmp_zip.replace(output_path)


def _persist_lyrics(
    source_dir: Path,
    manifest: dict,
    lyrics_data: list[dict],
    dlc_path: Path,
    is_zip: bool,
    source: str = "user",
) -> int:
    """Write `lyrics_data` to `lyrics.json`, patch the manifest, and (for
    zip-form packs) re-zip so the edit reaches the distributable `.sloppak`
    file rather than only the extraction cache.

    An empty `lyrics_data` list is valid — it's how a track gets cleared —
    and is still written and manifest-patched like any other save.

    Returns the number of lyric entries written.
    """
    _atomic_write_json(source_dir / "lyrics.json", lyrics_data)

    if manifest.get("lyrics") != "lyrics.json" or manifest.get("lyrics_source") != source:
        manifest["lyrics"] = "lyrics.json"
        manifest["lyrics_source"] = source
        _write_manifest(source_dir, manifest)

    if is_zip:
        _rezip_sloppak(source_dir, dlc_path)

    return len(lyrics_data)


def setup(app: FastAPI, context: dict):
    global _config_dir, _get_dlc_dir, SLOPPAK_CACHE_DIR

    _config_dir = context["config_dir"]
    _get_dlc_dir = context["get_dlc_dir"]
    static_dir = Path(os.environ.get("STATIC_DIR", "/app/static"))
    SLOPPAK_CACHE_DIR = static_dir / "sloppak_cache"

    @app.get("/api/plugins/lyrics_sync/status")
    def ls_status():
        """Check if the alignment server is reachable AND actually ready to
        align — not just that /health returns 200.

        The demucs-server's /health responds 200 with `status: "ok"` as soon
        as the process is up, well before its models finish loading — during
        that window its `warmup` block reports fields like `whisperx:
        "downloading"`. Treating any 200 as "ready" (the previous behavior)
        showed a green "Alignment server ready" notice while a request would
        still hit the server mid-warmup, surfacing as a confusing
        "Cannot connect to alignment server" once the user actually clicked
        Align. `/align` needs whisperx (transcription, used for VAD-anchored
        alignment windows — see the demucs-server's own /align docs) loaded
        first; per-language aligners load lazily on demand and are not
        gated on here.
        """
        url = _get_demucs_server_url()
        if not url:
            return {"available": False, "reason": "No demucs server configured"}
        try:
            import requests
            resp = requests.get(f"{url}/health", timeout=5)
            if resp.status_code != 200:
                return {"available": False, "reason": f"Server returned {resp.status_code}"}
            body = resp.json()
            warmup = body.get("warmup") or {}
            whisperx_state = warmup.get("whisperx")
            if whisperx_state != "ready":
                return {
                    "available": False,
                    "reason": (
                        f"Alignment model still loading ({whisperx_state or 'unknown'}) "
                        "— try again in a moment."
                    ),
                }
            return {"available": True, "server_url": url}
        except Exception as e:
            return {"available": False, "reason": str(e)}

    @app.post("/api/plugins/lyrics_sync/align")
    def ls_align(data: dict):
        """Align lyrics text against a sloppak song's vocals stem.

        Expects: {"filename": str, "lyrics_text": str, "language": str?, "granularity": str?}
        Returns: {"segments": [{"start": float, "end": float, "text": str}, ...]}
        """
        filename = data.get("filename", "")
        lyrics_text = data.get("lyrics_text", "").strip()
        language = data.get("language", "")
        granularity = data.get("granularity", "line")

        if not filename:
            return JSONResponse({"error": "filename required"}, 400)
        if not lyrics_text:
            return JSONResponse({"error": "lyrics_text required"}, 400)

        # Find the vocals stem
        vocals_path = _find_vocals_stem(filename)
        if not vocals_path:
            return JSONResponse(
                {"error": "No vocals stem found. Song must be a sloppak with split stems."},
                400,
            )

        # Get demucs server URL
        server_url = _get_demucs_server_url()
        if not server_url:
            return JSONResponse({"error": "No demucs server configured"}, 400)

        # Send vocals + text to the alignment server
        import requests
        try:
            with open(vocals_path, "rb") as f:
                resp = requests.post(
                    f"{server_url}/align",
                    files={"file": (vocals_path.name, f, "audio/ogg")},
                    data={
                        "text": lyrics_text,
                        "language": language,
                        "granularity": granularity,
                    },
                    timeout=300,
                )

            if resp.status_code != 200:
                return JSONResponse(
                    {"error": f"Alignment server error: {resp.text[:500]}"},
                    502,
                )

            try:
                result = resp.json()
            except ValueError:
                return JSONResponse(
                    {"error": "Alignment server returned a malformed response"},
                    502,
                )
            if "error" in result:
                return JSONResponse(
                    {"error": f"Alignment failed: {result['error']}"},
                    502,
                )

            return result
        except requests.Timeout:
            return JSONResponse({"error": "Alignment request timed out"}, 504)
        except requests.ConnectionError:
            return JSONResponse({"error": "Cannot connect to alignment server"}, 502)

    @app.post("/api/plugins/lyrics_sync/export")
    def ls_export(data: dict):
        """Export alignment segments as an LRC file.

        Expects: {"segments": [...], "title": str?, "artist": str?}
        Returns: LRC file download.
        """
        segments = data.get("segments", [])
        if not segments:
            return JSONResponse({"error": "No segments provided"}, 400)

        title = data.get("title", "")
        artist = data.get("artist", "")

        # Build LRC header + body
        header_lines = []
        if title:
            header_lines.append(f"[ti:{title}]")
        if artist:
            header_lines.append(f"[ar:{artist}]")
        header_lines.append("[by:Slopsmith Lyrics Sync]")
        header = "\n".join(header_lines) + "\n"

        lrc = header + _format_lrc(segments)

        safe_name = f"{artist} - {title}".strip(" -") or "lyrics"
        safe_name = safe_name.replace("/", "_").replace("\\", "_")

        # Quote-escape for the legacy `filename=` fallback, and provide an
        # RFC 5987 `filename*=` form so non-ASCII / quote characters in
        # title-artist can't corrupt or break out of the header value.
        # The `\` escape is a no-op today (safe_name already stripped `\`
        # above) but guards this line if that stripping ever changes.
        ascii_name = safe_name.replace("\\", "\\\\").replace('"', '\\"')
        encoded_name = quote(f"{safe_name}.lrc", safe="")

        return Response(
            content=lrc,
            media_type="text/plain",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{ascii_name}.lrc"; '
                    f"filename*=UTF-8''{encoded_name}"
                ),
            },
        )

    @app.post("/api/plugins/lyrics_sync/save")
    def ls_save(data: dict):
        """Save aligned lyrics into the sloppak for playback display.

        Expects: {"filename": str, "segments": [...], "granularity": str?}
        Converts Whisper alignment segments to the sloppak lyrics format and
        persists via `_persist_lyrics` — directory-form packs are rewritten
        in place; zip-form packs are re-zipped so the edit lands in the
        distributable `.sloppak` file, not just the extraction cache.
        """
        filename = data.get("filename", "")
        segments = data.get("segments", [])
        granularity = data.get("granularity", "line")

        if not filename or not segments:
            return JSONResponse({"error": "filename and segments required"}, 400)

        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse({"error": "Not a sloppak"}, 400)
        source_dir, manifest, dlc_path, is_zip = resolved

        # Convert alignment segments to the sloppak lyrics format:
        # [{"t": time, "d": duration, "w": word}, ...]
        #
        # A trailing "+" on `w` is the sloppak-spec line-break marker (docs/
        # sloppak-hand-editing.md §Lyrics) — the renderer wraps to a new line
        # right after a syllable/word ending in "+". Without it every song
        # renders as one unbroken line, since nothing else in lyrics.json
        # carries line-boundary information.
        #
        # `line` granularity: the /align server returns one segment per
        # line (no `new_line` field — see the demucs-server's own /align
        # docs), so every entry here already *is* a whole line and gets "+".
        # `word`/`syllable` granularity: the server flags the FIRST entry of
        # each line with `new_line: true`; the line-ending entry is instead
        # the one immediately BEFORE that (or the very last segment overall).
        lyrics_data = []
        for i, seg in enumerate(segments):
            text = seg["text"]
            is_line_end = (
                granularity == "line"
                or i == len(segments) - 1
                or bool(segments[i + 1].get("new_line"))
            )
            if is_line_end and not text.endswith("+"):
                text = text + "+"
            lyrics_data.append({
                "t": round(seg["start"], 3),
                "d": round(seg["end"] - seg["start"], 3),
                "w": text,
            })

        try:
            count = _persist_lyrics(source_dir, manifest, lyrics_data, dlc_path, is_zip)
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"error": f"Persist failed: {exc}"}, 500)

        return {"ok": True, "lyrics_count": count}

    @app.get("/api/plugins/lyrics_sync/lyrics")
    def ls_get_lyrics(filename: str = ""):
        """Load a sloppak's existing lyrics + audio info for the editor.

        Returns: {ok, lyrics: [{t,d,w}], source, duration,
                   stems: [{id, file, url}]}
        """
        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse({"error": "Not a sloppak"}, 400)
        source_dir, manifest, _dlc_path, _is_zip = resolved

        lyrics: list[dict] = []
        rel = manifest.get("lyrics")
        if rel:
            p = _safe_source_path(source_dir, str(rel))
            if p is not None and p.exists():
                try:
                    raw = json.loads(p.read_text(encoding="utf-8"))
                except Exception:
                    raw = None
                if isinstance(raw, list):
                    for item in raw:
                        if not isinstance(item, dict):
                            continue
                        try:
                            t = float(item.get("t", 0.0))
                            d = float(item.get("d", 0.0))
                        except (TypeError, ValueError):
                            continue
                        lyrics.append({"t": t, "d": d, "w": str(item.get("w", ""))})

        raw_source = manifest.get("lyrics_source")
        source = raw_source if isinstance(raw_source, str) else ""

        # Stem URLs use the same core-served endpoint (and the same
        # encoding) that the highway WebSocket hands the player —
        # `/api/sloppak/{filename}/file/{rel_path}` (lib/routers/media.py).
        # Building the URL here means the editor never has to duplicate
        # this encoding logic client-side.
        q_fn = quote(filename, safe="")
        stems = []
        for s in manifest.get("stems", []) or []:
            if not isinstance(s, dict):
                continue
            sid = str(s.get("id", ""))
            sfile = str(s.get("file", ""))
            if sid and sfile:
                stems.append({
                    "id": sid,
                    "file": sfile,
                    "url": f"/api/sloppak/{q_fn}/file/{quote(sfile)}",
                })

        duration = manifest.get("duration")
        try:
            duration = float(duration) if duration is not None else None
        except (TypeError, ValueError):
            duration = None

        return {
            "ok": True,
            "lyrics": lyrics,
            "source": source,
            "duration": duration,
            "stems": stems,
        }

    @app.post("/api/plugins/lyrics_sync/save-lyrics")
    def ls_save_lyrics(data: dict):
        """Persist hand-edited lyrics from the editor.

        Expects: {"filename": str, "lyrics": [{"t": float, "d": float, "w": str}, ...]}

        Unlike `/save` (which derives entries from Whisper alignment
        segments), this takes the editor's `{t, d, w}` list verbatim —
        markers ('-' join / '+' line-break) are already encoded into `w`
        by the client. Validated *more strictly* than the sloppak loader's
        own read-side filter (lib/sloppak.py, which only checks `w` is a
        str and `t`/`d` are int/float — no finiteness check, no `d <= 0`
        drop, no rounding): every entry here must have a string `w` and
        finite numeric `t`/`d`; entries with `d <= 0` are dropped; the
        rest are rounded and sorted by `t`. The extra strictness keeps
        what a save writes well-formed rather than merely
        loader-tolerated.

        An empty list is a valid save — it clears the lyrics track.
        """
        filename = data.get("filename", "")
        raw_lyrics = data.get("lyrics", [])

        if not filename:
            return JSONResponse({"error": "filename required"}, 400)
        if not isinstance(raw_lyrics, list):
            return JSONResponse({"error": "lyrics must be a list"}, 400)

        import math

        lyrics_data = []
        for item in raw_lyrics:
            if not isinstance(item, dict):
                continue
            w = item.get("w")
            if not isinstance(w, str):
                continue
            try:
                t = float(item.get("t"))
                d = float(item.get("d"))
            except (TypeError, ValueError):
                continue
            if not (math.isfinite(t) and math.isfinite(d)):
                continue
            if d <= 0:
                continue
            lyrics_data.append({"t": round(t, 3), "d": round(d, 3), "w": w})

        lyrics_data.sort(key=lambda e: e["t"])

        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse({"error": "Not a sloppak"}, 400)
        source_dir, manifest, dlc_path, is_zip = resolved

        try:
            count = _persist_lyrics(source_dir, manifest, lyrics_data, dlc_path, is_zip)
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"error": f"Persist failed: {exc}"}, 500)

        return {"ok": True, "lyrics_count": count}
