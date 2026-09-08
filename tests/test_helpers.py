"""Module-level pure(ish) helpers: path containment, manifest IO, and
lyrics persistence. No setup() required — these are plain functions.

Deliberately does NOT exercise `_resolve_sloppak` / `_find_vocals_stem` /
any `setup()`-registered route — those import core's `sloppak` module,
which isn't available in this plugin repo's isolated CI (it's supplied by
the feedBack host at plugin-load time). Mirrors the scope boundary the
lyrics_karaoke plugin's own test suite already draws for the same reason.
"""

import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import routes  # noqa: E402


# ── path containment ───────────────────────────────────────────────────────

def test_safe_dlc_path_rejects_traversal_and_absolute(tmp_path):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    assert routes._safe_dlc_path(dlc, "../../etc/passwd.sloppak") is None
    assert routes._safe_dlc_path(dlc, "/etc/passwd.sloppak") is None
    assert routes._safe_dlc_path(dlc, "C:\\evil.sloppak") is None
    assert routes._safe_dlc_path(dlc, "a\x00b.sloppak") is None
    assert routes._safe_dlc_path(dlc, "") is None


def test_safe_dlc_path_resolves_legitimate_relative_path(tmp_path):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    result = routes._safe_dlc_path(dlc, "Artist/Song.sloppak")
    assert result == dlc.resolve() / "Artist" / "Song.sloppak"


def test_safe_source_path_rejects_traversal_and_absolute(tmp_path):
    source_dir = tmp_path / "song.sloppak"
    source_dir.mkdir()
    assert routes._safe_source_path(source_dir, "../../../etc/passwd") is None
    assert routes._safe_source_path(source_dir, "/etc/passwd") is None
    assert routes._safe_source_path(source_dir, "..\\..\\evil") is None
    assert routes._safe_source_path(source_dir, "a\x00b") is None
    assert routes._safe_source_path(source_dir, "") is None


def test_safe_source_path_resolves_legitimate_relative_path(tmp_path):
    source_dir = tmp_path / "song.sloppak"
    source_dir.mkdir()
    result = routes._safe_source_path(source_dir, "stems/vocals.ogg")
    assert result == source_dir.resolve() / "stems" / "vocals.ogg"


# ── manifest helpers ─────────────────────────────────────────────────────────

def test_manifest_path_prefers_yaml_over_yml(tmp_path):
    (tmp_path / "manifest.yaml").write_text("a: 1\n")
    (tmp_path / "manifest.yml").write_text("a: 2\n")
    assert routes._manifest_path(tmp_path).name == "manifest.yaml"


def test_manifest_path_falls_back_to_yml(tmp_path):
    (tmp_path / "manifest.yml").write_text("a: 1\n")
    assert routes._manifest_path(tmp_path).name == "manifest.yml"


def test_read_write_manifest_roundtrip(tmp_path):
    (tmp_path / "manifest.yaml").write_text("schema: 1\n")
    manifest = routes._read_manifest(tmp_path)
    assert manifest == {"schema": 1}
    manifest["lyrics"] = "lyrics.json"
    routes._write_manifest(tmp_path, manifest)
    assert routes._read_manifest(tmp_path) == {"schema": 1, "lyrics": "lyrics.json"}


# ── atomic json write ───────────────────────────────────────────────────────

def test_atomic_write_json_writes_and_cleans_tmp(tmp_path):
    target = tmp_path / "out.json"
    routes._atomic_write_json(target, {"a": 1})
    assert json.loads(target.read_text(encoding="utf-8")) == {"a": 1}
    assert not target.with_suffix(".json.tmp").exists()


# ── rezip ─────────────────────────────────────────────────────────────────────

def test_rezip_sloppak_packs_source_dir_contents(tmp_path):
    source_dir = tmp_path / "song_src"
    source_dir.mkdir()
    (source_dir / "manifest.yaml").write_text("schema: 1\n")
    (source_dir / "lyrics.json").write_text("[]")
    (source_dir / "stems").mkdir()
    (source_dir / "stems" / "vocals.ogg").write_bytes(b"audio")

    output_path = tmp_path / "song.sloppak"
    routes._rezip_sloppak(source_dir, output_path)

    with zipfile.ZipFile(output_path) as zf:
        names = set(zf.namelist())
    assert names == {"manifest.yaml", "lyrics.json", "stems/vocals.ogg"}


def test_rezip_sloppak_backs_up_existing_zip_once(tmp_path):
    source_dir = tmp_path / "song_src"
    source_dir.mkdir()
    (source_dir / "manifest.yaml").write_text("schema: 1\n")

    output_path = tmp_path / "song.sloppak"
    with zipfile.ZipFile(output_path, "w") as zf:
        zf.writestr("manifest.yaml", "schema: 0\n")  # original content

    routes._rezip_sloppak(source_dir, output_path)
    backup = output_path.with_suffix(output_path.suffix + ".bak")
    assert backup.exists()
    with zipfile.ZipFile(backup) as zf:
        assert zf.read("manifest.yaml") == b"schema: 0\n"

    # A second rezip must not clobber the one-time backup with newer content.
    (source_dir / "manifest.yaml").write_text("schema: 2\n")
    routes._rezip_sloppak(source_dir, output_path)
    with zipfile.ZipFile(backup) as zf:
        assert zf.read("manifest.yaml") == b"schema: 0\n"


# ── lyrics persistence — the zip-persistence regression coverage ────────────

def test_persist_lyrics_writes_file_and_updates_manifest_dir_form(tmp_path):
    (tmp_path / "manifest.yaml").write_text("schema: 1\n")
    manifest = {"schema": 1}
    lyrics_data = [
        {"t": 1.0, "d": 0.3, "w": "Hel-"},
        {"t": 1.3, "d": 0.4, "w": "lo+"},
    ]

    count = routes._persist_lyrics(tmp_path, manifest, lyrics_data, tmp_path / "song.sloppak", is_zip=False)
    assert count == 2

    on_disk = json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8"))
    assert on_disk == lyrics_data
    assert manifest["lyrics"] == "lyrics.json"
    assert manifest["lyrics_source"] == "user"
    persisted_manifest = routes._read_manifest(tmp_path)
    assert persisted_manifest["lyrics"] == "lyrics.json"
    assert persisted_manifest["lyrics_source"] == "user"


def test_persist_lyrics_rezips_zip_form_sloppak(tmp_path):
    """Regression test for the bug this PR fixes: saving into a zip-form
    sloppak used to write lyrics.json only into the extraction cache
    (`source_dir`), never into the distributable .sloppak archive — so
    the edit vanished the next time the cache was invalidated. Assert
    the write lands inside the actual zip, not just source_dir."""
    source_dir = tmp_path / "cache" / "song.sloppak"
    source_dir.mkdir(parents=True)
    (source_dir / "manifest.yaml").write_text("schema: 1\n")

    dlc_path = tmp_path / "dlc" / "song.sloppak"
    dlc_path.parent.mkdir(parents=True)
    with zipfile.ZipFile(dlc_path, "w") as zf:
        zf.writestr("manifest.yaml", "schema: 1\n")

    lyrics_data = [{"t": 0.5, "d": 0.2, "w": "hi"}]
    count = routes._persist_lyrics(source_dir, {"schema": 1}, lyrics_data, dlc_path, is_zip=True)
    assert count == 1

    # The extraction cache alone is not the fix being verified here —
    # the archive itself must carry the write.
    with zipfile.ZipFile(dlc_path) as zf:
        names = zf.namelist()
        assert "lyrics.json" in names
        assert json.loads(zf.read("lyrics.json")) == lyrics_data
        manifest_in_zip = zf.read("manifest.yaml").decode("utf-8")
        assert "lyrics: lyrics.json" in manifest_in_zip
        assert "lyrics_source: user" in manifest_in_zip

    assert dlc_path.with_suffix(dlc_path.suffix + ".bak").exists()


def test_persist_lyrics_empty_list_is_a_valid_clear(tmp_path):
    (tmp_path / "manifest.yaml").write_text("lyrics: lyrics.json\nlyrics_source: user\n")
    (tmp_path / "lyrics.json").write_text(json.dumps([{"t": 0, "d": 1, "w": "old"}]))
    manifest = routes._read_manifest(tmp_path)

    count = routes._persist_lyrics(tmp_path, manifest, [], tmp_path / "song.sloppak", is_zip=False)
    assert count == 0
    assert json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8")) == []


def test_persist_lyrics_custom_source_value(tmp_path):
    (tmp_path / "manifest.yaml").write_text("schema: 1\n")
    manifest = {"schema": 1}
    routes._persist_lyrics(tmp_path, manifest, [{"t": 0, "d": 1, "w": "x"}],
                            tmp_path / "song.sloppak", is_zip=False, source="transcribed")
    assert manifest["lyrics_source"] == "transcribed"


# ── LRC export ────────────────────────────────────────────────────────────────

def test_format_lrc_basic_timestamps():
    segments = [
        {"start": 0.0, "text": "Hello"},
        {"start": 65.5, "text": "World"},
    ]
    lrc = routes._format_lrc(segments)
    assert lrc == "[00:00.00]Hello\n[01:05.50]World\n"


def test_format_lrc_empty_segments_yields_trailing_newline_only():
    assert routes._format_lrc([]) == "\n"


def test_ascii_safe_filename_component_folds_non_latin1_chars():
    # Starlette encodes header values as Latin-1; anything above U+00FF must
    # be folded before it reaches a raw `filename=` fallback or the response
    # raises UnicodeEncodeError at send time.
    folded = routes._ascii_safe_filename_component("\u7c73\u6d25\u7384\u5e2b - Lemon")
    assert folded == "____ - Lemon"
    folded.encode("latin-1")  # must not raise


def test_ascii_safe_filename_component_leaves_ascii_untouched():
    assert routes._ascii_safe_filename_component("My Song - Artist") == "My Song - Artist"


def test_format_lrc_word_level_inlines_word_timestamps():
    segments = [
        {"start": 0.0, "text": "Hello World", "words": [
            {"start": 0.0, "text": "Hello"},
            {"start": 0.5, "text": "World"},
        ]},
    ]
    lrc = routes._format_lrc_word_level(segments)
    assert lrc == "[00:00.00]<00:00.00>Hello <00:00.50>World\n"


def test_lrc_timestamp_rolls_seconds_into_next_minute_on_rounding():
    # int(t // 60) + f"{t % 60:05.2f}" independently truncates the minute and
    # rounds the seconds, so a value like 119.999 used to print the invalid
    # "01:60.00" instead of rolling over to "02:00.00". Round to whole
    # centiseconds first, then split, so the carry happens before formatting.
    assert routes._lrc_timestamp(119.999) == "02:00.00"
    assert routes._lrc_timestamp(59.996) == "01:00.00"
    assert routes._lrc_timestamp(65.0) == "01:05.00"
    assert routes._lrc_timestamp(0.0) == "00:00.00"


def test_format_lrc_skips_malformed_segments_instead_of_raising():
    segments = [
        {"start": 1.0, "text": "kept"},
        {"text": "missing start"},
        "not a dict",
        {"start": "not a number", "text": "bad start"},
        None,
    ]
    assert routes._format_lrc(segments) == "[00:01.00]kept\n"


def test_format_lrc_missing_text_defaults_to_empty_string():
    assert routes._format_lrc([{"start": 1.0}]) == "[00:01.00]\n"


def test_format_lrc_word_level_skips_malformed_words():
    segments = [
        {"start": 0.0, "text": "Hello World", "words": [
            {"start": 0.0, "text": "Hello"},
            {"text": "no start, dropped"},
            "not a dict",
            {"start": 0.5, "text": "World"},
        ]},
    ]
    lrc = routes._format_lrc_word_level(segments)
    assert lrc == "[00:00.00]<00:00.00>Hello <00:00.50>World\n"


def test_format_lrc_word_level_tolerates_null_words_field():
    # "words": null iterated directly (`for w in seg["words"]`) raises
    # TypeError outside any try/except -- a 500 on otherwise well-formed
    # input. `isinstance(seg.get("words"), list)` must reject None the
    # same way it rejects any other non-list shape.
    segments = [{"start": 0.0, "text": "Hello", "words": None}]
    assert routes._format_lrc_word_level(segments) == "[00:00.00]Hello\n"


def test_format_lrc_skips_non_finite_start_instead_of_raising():
    # float("inf")/float("nan") parse without raising, so the existing
    # KeyError/TypeError/ValueError guard doesn't catch them -- they used
    # to reach _lrc_timestamp's `round(inf * 100)`, which raises
    # OverflowError ("cannot convert float infinity to integer") and 500s
    # the export. Same for the numeric-literal overflow case (1e999 is inf).
    segments = [
        {"start": 1.0, "text": "kept"},
        {"start": float("inf"), "text": "inf dropped"},
        {"start": float("-inf"), "text": "-inf dropped"},
        {"start": float("nan"), "text": "nan dropped"},
        {"start": 1e999, "text": "overflow-literal dropped"},
    ]
    assert routes._format_lrc(segments) == "[00:01.00]kept\n"


def test_format_lrc_word_level_skips_non_finite_start_and_word_start():
    segments = [
        {"start": float("inf"), "text": "seg dropped", "words": [
            {"start": 0.0, "text": "irrelevant"},
        ]},
        {"start": 0.0, "text": "kept", "words": [
            {"start": float("nan"), "text": "word dropped"},
            {"start": 0.5, "text": "kept-word"},
        ]},
    ]
    lrc = routes._format_lrc_word_level(segments)
    assert lrc == "[00:00.00]<00:00.50>kept-word\n"
