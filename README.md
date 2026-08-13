# Lyrics Sync

A [feedBack](https://github.com/got-feedback/feedback) plugin for authoring and
time-aligning song lyrics: generate synced timing with Whisper forced
alignment against an isolated vocals stem, or hand-edit with tap-to-time and
waveform drag-editing.

## How it works

### AI alignment

1. Select a sloppak song that has split stems (vocals track required)
2. Paste or upload plain text lyrics
3. The plugin sends the vocals stem to your [feedBack Demucs Server](https://github.com/byrongamatos/slopsmith-demucs-server) for Whisper forced alignment
4. Preview the timestamped result, then download as `.lrc`, save directly into the sloppak, or open it in the manual editor to fix anything alignment got wrong

### Manual editor

Click **Open Editor** once a song is selected — it loads that song's existing
lyrics for correction, or starts empty for authoring from scratch. Click
**Edit Manually** on an alignment preview to review/fix the result before
saving.

- **Tap-to-time** — play the song and tap Space along with the vocal; each
  tap stamps the next syllable's start time and closes the previous one's
  duration, so a whole verse can be timed in one pass
- **Waveform drag-editing** — syllable blocks are laid over the stem's
  waveform; drag a block to move it, drag an edge to resize it, double-click
  to edit its text. Blocks snap to neighbouring edges (hold Alt to bypass)
- **Seed from text** — paste plain lyrics to create untimed syllables; mark
  syllable splits within a word with `/` (e.g. `won/der/ful`)
- **A–B loop + speed control** — loop a phrase and slow playback down while
  timing a tricky section
- **Undo/redo**, and a stem picker for switching between the vocals track and
  the full mix

## Features

- **Line, word, and syllable granularity** for AI alignment — choose the level of timing precision
- **Language hint** — optional language code to improve accuracy for non-English lyrics
- **LRC export** — standard `[mm:ss.xx] line` format compatible with any LRC player
- **Save to song** — writes synced lyrics into the sloppak so they display during playback via the lyrics toggle. Directory-form sloppaks are rewritten in place; zip-form `.sloppak` files are re-zipped (with a one-time `.bak`) so edits land in the distributable file, not just the extraction cache
- **Preview panel** — review AI-aligned timestamps before exporting or saving
- **Manual editor** — tap-to-time, waveform drag-editing, and text seeding for authoring or correcting lyrics by hand

## Requirements

- The manual editor works on any sloppak — no external service required
- AI alignment additionally needs a running [feedBack Demucs Server](https://github.com/byrongamatos/slopsmith-demucs-server) with the `/align` endpoint (v2+), configured in feedBack settings, and split stems on the song (use the Sloppak Converter plugin with Demucs splitting enabled)

## Install

```bash
cd plugins
git clone https://github.com/got-feedback/feedback-plugin-lyrics-sync.git lyrics_sync
```

Restart feedBack and the plugin will appear in the Plugins dropdown.
