// Lyrics Sync plugin

let _lsSelectedFilename = null;
let _lsSelectedTitle = "";
let _lsSelectedArtist = "";
let _lsAlignmentResult = null;

// ── Dashboard ───────────────────────────────────────────────────────────

async function lsLoadDashboard() {
    const status = document.getElementById('ls-status');
    try {
        const resp = await fetch('/api/plugins/lyrics_sync/status');
        const data = await resp.json();
        if (data.available) {
            status.innerHTML = `
                <div class="bg-green-900/20 border border-green-800/30 rounded-xl p-3 text-sm">
                    <span class="text-green-400">Alignment server ready</span>
                </div>`;
        } else {
            status.innerHTML = `
                <div class="bg-yellow-900/20 border border-yellow-800/30 rounded-xl p-4 text-sm">
                    <p class="text-yellow-400 font-semibold mb-1">Alignment server unavailable</p>
                    <p class="text-gray-400">${esc(data.reason || 'Unknown error')}</p>
                </div>`;
        }
    } catch (e) {
        status.innerHTML = `
            <div class="bg-red-900/20 border border-red-800/30 rounded-xl p-3 text-sm">
                <span class="text-red-400">Failed to check server status</span>
            </div>`;
    }
    _lsUpdateAlignBtn();
}

// ── Song search ──────────────────────────────────────────────────────────

async function lsSearchSongs() {
    const q = document.getElementById('ls-search').value.trim();
    if (!q) return;

    const resp = await fetch(`/api/library?q=${encodeURIComponent(q)}&page=0&size=20&sort=artist&format=sloppak`);
    const data = await resp.json();
    const container = document.getElementById('ls-search-results');

    // Filter to songs with stems (stem_count > 1 means split stems, not just full.ogg)
    const withStems = (data.songs || []).filter(s => s.stem_count > 1);

    if (withStems.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-xs py-2">No sloppak songs with stems found. Songs need stem separation first.</p>';
        return;
    }

    // Built with createElement + textContent (not an interpolated onclick="")
    // string: `esc()` only escapes <, >, & for text-node use — it does not
    // escape quotes, so splicing song title/artist into an HTML attribute
    // (further nested inside a JS string literal) let a title/artist
    // containing a `"` or `'` break out and inject arbitrary attributes/
    // markup. Song metadata comes from imported files (GP/MusicXML tags,
    // manifest.json, MusicBrainz enrichment) so it isn't trusted input.
    container.innerHTML = '';
    for (const s of withStems) {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-dark-700/50 transition cursor-pointer';
        row.addEventListener('click', () => lsSelectSong(s.filename, s.title, s.artist));

        const info = document.createElement('div');
        info.className = 'flex-1 min-w-0';
        const titleEl = document.createElement('span');
        titleEl.className = 'text-sm text-white';
        titleEl.textContent = s.title;
        const artistEl = document.createElement('span');
        artistEl.className = 'text-xs text-gray-500 ml-2';
        artistEl.textContent = s.artist;
        info.appendChild(titleEl);
        info.appendChild(artistEl);

        const stemsEl = document.createElement('span');
        stemsEl.className = 'text-xs text-gray-600';
        stemsEl.textContent = `${s.stem_count} stems`;

        row.appendChild(info);
        row.appendChild(stemsEl);
        container.appendChild(row);
    }
}

function lsSelectSong(filename, title, artist) {
    // Editor state (loaded lyrics, undo history, audio src) belongs to
    // whatever song was selected when it was opened — switching songs
    // without closing first would let a save land on the wrong file.
    if (typeof lsCloseEditor === 'function') lsCloseEditor();

    _lsSelectedFilename = filename;
    _lsSelectedTitle = title;
    _lsSelectedArtist = artist;

    document.getElementById('ls-search-results').innerHTML = '';
    document.getElementById('ls-search').value = '';
    document.getElementById('ls-selected-song').classList.remove('hidden');
    document.getElementById('ls-selected-label').textContent = `${title} — ${artist}`;
    _lsUpdateAlignBtn();
    if (typeof _lsUpdateOpenEditorBtn === 'function') _lsUpdateOpenEditorBtn();
}

function lsClearSong() {
    if (typeof lsCloseEditor === 'function') lsCloseEditor();

    _lsSelectedFilename = null;
    _lsSelectedTitle = "";
    _lsSelectedArtist = "";
    document.getElementById('ls-selected-song').classList.add('hidden');
    document.getElementById('ls-selected-label').textContent = '';
    _lsUpdateAlignBtn();
    if (typeof _lsUpdateOpenEditorBtn === 'function') _lsUpdateOpenEditorBtn();
}

// ── Lyrics input ─────────────────────────────────────────────────────────

function lsFileUpload(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        document.getElementById('ls-lyrics').value = reader.result;
        _lsUpdateLineCount();
        _lsUpdateAlignBtn();
    };
    reader.readAsText(file);
    input.value = '';
}

function _lsUpdateLineCount() {
    const text = document.getElementById('ls-lyrics').value.trim();
    const count = text ? text.split('\n').filter(l => l.trim()).length : 0;
    document.getElementById('ls-lyrics-count').textContent = `${count} line${count !== 1 ? 's' : ''}`;
}

function _lsUpdateAlignBtn() {
    const hasLyrics = document.getElementById('ls-lyrics').value.trim().length > 0;
    const btn = document.getElementById('ls-align-btn');
    btn.disabled = !_lsSelectedFilename || !hasLyrics;
}

// Update line count on input
document.getElementById('ls-lyrics')?.addEventListener('input', () => {
    _lsUpdateLineCount();
    _lsUpdateAlignBtn();
});

// ── Alignment ────────────────────────────────────────────────────────────

function _lsGetGranularity() {
    const checked = document.querySelector('input[name="ls-granularity"]:checked');
    return checked ? checked.value : 'line';
}

async function lsAlign() {
    if (!_lsSelectedFilename) return;
    const lyricsText = document.getElementById('ls-lyrics').value.trim();
    if (!lyricsText) return;

    const language = document.getElementById('ls-language').value.trim();
    const granularity = _lsGetGranularity();

    // Show progress
    document.getElementById('ls-progress').classList.remove('hidden');
    document.getElementById('ls-preview').classList.add('hidden');
    document.getElementById('ls-align-btn').disabled = true;

    try {
        const resp = await fetch('/api/plugins/lyrics_sync/align', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: _lsSelectedFilename,
                lyrics_text: lyricsText,
                language: language || undefined,
                granularity: granularity,
            }),
        });

        const data = await resp.json();

        if (data.error) {
            document.getElementById('ls-progress').innerHTML = `
                <div class="bg-red-900/20 border border-red-800/30 rounded-xl p-4 text-sm">
                    <p class="text-red-400 font-semibold mb-1">Alignment failed</p>
                    <p class="text-gray-400">${esc(data.error)}</p>
                </div>`;
            return;
        }

        _lsAlignmentResult = data.segments;
        document.getElementById('ls-progress').classList.add('hidden');
        _lsRenderPreview(data.segments);
    } catch (e) {
        document.getElementById('ls-progress').innerHTML = `
            <div class="bg-red-900/20 border border-red-800/30 rounded-xl p-4 text-sm">
                <p class="text-red-400">Connection error: ${esc(e.message)}</p>
            </div>`;
    } finally {
        _lsUpdateAlignBtn();
    }
}

function _lsFormatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(2).padStart(5, '0');
    return `${String(m).padStart(2, '0')}:${s}`;
}

function _lsGroupSegmentsByLine(segments) {
    // word/syllable granularity returns one segment per word/syllable, with
    // `new_line: true` on the first entry of each ORIGINAL input line (see
    // the demucs-server's /align docs). Re-group them back into one chunk
    // per line so the preview reads the way the lyrics were typed, instead
    // of one row per individual word.
    const lines = [];
    for (const seg of segments) {
        if (seg.new_line || lines.length === 0) {
            lines.push({ start: seg.start, words: [seg.text] });
        } else {
            lines[lines.length - 1].words.push(seg.text);
        }
    }
    return lines.map(l => ({ start: l.start, text: l.words.join(' ') }));
}

function _lsRenderPreview(segments) {
    const container = document.getElementById('ls-preview-lines');
    const granularity = _lsGetGranularity();

    // 'line' granularity: each segment already IS a whole input line.
    // 'word'/'syllable': re-group into one row per line so chunks line up
    // with how the lyrics were typed, rather than one row per token.
    const rows = granularity === 'line' ? segments : _lsGroupSegmentsByLine(segments);

    container.innerHTML = rows.map((row) => `
        <div class="flex gap-3 py-1 hover:bg-dark-700/30 rounded px-2 transition">
            <span class="text-accent/70 text-xs whitespace-nowrap mt-0.5">[${_lsFormatTime(row.start)}]</span>
            <span class="text-gray-300">${esc(row.text)}</span>
        </div>`).join('');

    document.getElementById('ls-preview').classList.remove('hidden');
}

// ── Export ────────────────────────────────────────────────────────────────

async function lsExport() {
    if (!_lsAlignmentResult || _lsAlignmentResult.length === 0) return;

    const resp = await fetch('/api/plugins/lyrics_sync/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            segments: _lsAlignmentResult,
            title: _lsSelectedTitle,
            artist: _lsSelectedArtist,
        }),
    });

    if (!resp.ok) return;

    // Download the file
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const disposition = resp.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="(.+)"/);
    a.download = match ? match[1] : 'lyrics.lrc';
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ── Save to song ─────────────────────────────────────────────────────────

async function lsSave() {
    if (!_lsAlignmentResult || !_lsSelectedFilename) return;

    const statusEl = document.getElementById('ls-save-status');
    const btn = document.getElementById('ls-save-btn');
    btn.disabled = true;
    statusEl.textContent = 'Saving...';
    statusEl.classList.remove('hidden');
    statusEl.className = 'text-xs text-gray-400 mt-2';

    try {
        const resp = await fetch('/api/plugins/lyrics_sync/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: _lsSelectedFilename,
                segments: _lsAlignmentResult,
                granularity: _lsGetGranularity(),
            }),
        });

        const data = await resp.json();
        if (data.ok) {
            statusEl.textContent = `Saved ${data.lyrics_count} synced lyrics entries to song. They will appear during playback.`;
            statusEl.className = 'text-xs text-green-400 mt-2';
        } else {
            statusEl.textContent = `Error: ${data.error}`;
            statusEl.className = 'text-xs text-red-400 mt-2';
        }
    } catch (e) {
        statusEl.textContent = `Failed: ${e.message}`;
        statusEl.className = 'text-xs text-red-400 mt-2';
    } finally {
        btn.disabled = false;
    }
}

// ── Manual editor ────────────────────────────────────────────────────────
//
// A hand-editing surface for the same {t, d, w} syllable list `/save`
// writes, layered on the alignment flow above rather than replacing it:
// "Edit Manually" in the align preview seeds the editor from a fresh
// alignment result, and "Open Editor" loads whatever's already saved on
// the selected song (via GET /lyrics) for correction. Model is a flat
// array in render order with the wire markers decoded into booleans:
//
//   { w: "Hel", t: 12.34, d: 0.18, join: true, brk: false }
//   //  join → trailing "-" (joins next syllable)   brk → trailing "+" (line break)
//
// join/brk are mutually exclusive — a line-ending syllable can't also
// join the next word — and are re-encoded as a single trailing suffix on
// save, matching the exactly-one-marker contract core's sylText() (static/
// js/highway-draw.js) decodes on read.

let _lsEditorSyllables = [];      // [{w, t, d, join, brk}], t/d null = untimed
let _lsEditorSelectedIndex = -1;
let _lsEditorHistory = [];        // snapshot stack of _lsEditorSyllables
let _lsEditorHistoryIndex = -1;
let _lsEditorSource = "";         // lyrics_source of whatever was loaded
let _lsEditorStems = [];          // [{id, file, url}]
let _lsEditorDuration = 0;        // best-known song duration (manifest, then <audio>)
let _lsEditorPxPerSec = 40;
let _lsEditorLoopA = null;
let _lsEditorLoopB = null;
let _lsEditorLoopOn = false;
let _lsEditorTapMode = false;
let _lsEditorTapIndex = -1;
let _lsEditorRafId = null;
let _lsEditorWaveformPeaks = null;   // Float32Array [min,max] pairs, one per column
let _lsEditorWaveformDuration = 0;
let _lsEditorOffscreen = null;       // waveform pre-rendered here; blitted every frame
let _lsEditorDragState = null;       // {index, mode, startX, origT, origD, pointerId}
const _lsEditorEls = {};             // cached DOM refs, (re)resolved in _lsEditorCacheEls

function _lsEditorCloneSyllables(arr) {
    return (typeof structuredClone === 'function')
        ? structuredClone(arr)
        : JSON.parse(JSON.stringify(arr));
}

function _lsDecodeSyllable(raw) {
    let w = raw.w || "";
    let join = false, brk = false;
    if (w.endsWith('+')) { brk = true; w = w.slice(0, -1); }
    else if (w.endsWith('-')) { join = true; w = w.slice(0, -1); }
    return { w, t: (raw.t == null ? null : raw.t), d: (raw.d == null ? null : raw.d), join, brk };
}

function _lsEncodeSyllable(syl) {
    const suffix = syl.join ? '-' : (syl.brk ? '+' : '');
    return { t: syl.t, d: syl.d, w: syl.w + suffix };
}

function _lsEditorIsOpen() {
    return !!(_lsEditorEls.container && !_lsEditorEls.container.classList.contains('hidden'));
}

// ── History ──────────────────────────────────────────────────────────────

function _lsEditorPushHistory() {
    _lsEditorHistory = _lsEditorHistory.slice(0, _lsEditorHistoryIndex + 1);
    _lsEditorHistory.push(_lsEditorCloneSyllables(_lsEditorSyllables));
    if (_lsEditorHistory.length > 50) _lsEditorHistory.shift();
    _lsEditorHistoryIndex = _lsEditorHistory.length - 1;
    _lsEditorUpdateUndoRedoButtons();
}

function lsEditorUndo() {
    if (_lsEditorHistoryIndex <= 0) return;
    _lsEditorHistoryIndex--;
    _lsEditorSyllables = _lsEditorCloneSyllables(_lsEditorHistory[_lsEditorHistoryIndex]);
    _lsEditorSelectedIndex = -1;
    _lsEditorRenderAll();
}

function lsEditorRedo() {
    if (_lsEditorHistoryIndex >= _lsEditorHistory.length - 1) return;
    _lsEditorHistoryIndex++;
    _lsEditorSyllables = _lsEditorCloneSyllables(_lsEditorHistory[_lsEditorHistoryIndex]);
    _lsEditorSelectedIndex = -1;
    _lsEditorRenderAll();
}

function _lsEditorUpdateUndoRedoButtons() {
    if (_lsEditorEls.undoBtn) _lsEditorEls.undoBtn.disabled = _lsEditorHistoryIndex <= 0;
    if (_lsEditorEls.redoBtn) _lsEditorEls.redoBtn.disabled = _lsEditorHistoryIndex >= _lsEditorHistory.length - 1;
}

// ── Open / close ─────────────────────────────────────────────────────────

function _lsUpdateOpenEditorBtn() {
    const btn = document.getElementById('ls-open-editor-btn');
    if (btn) btn.disabled = !_lsSelectedFilename;
}

async function lsOpenEditor() {
    if (!_lsSelectedFilename) return;
    _lsEditorCacheEls();
    _lsEditorEls.container.classList.remove('hidden');

    let lyrics = [], source = '', stems = [], duration = 0;
    try {
        const resp = await fetch(`/api/plugins/lyrics_sync/lyrics?filename=${encodeURIComponent(_lsSelectedFilename)}`);
        const data = await resp.json();
        if (data.ok) {
            lyrics = data.lyrics || [];
            source = data.source || '';
            stems = data.stems || [];
            duration = typeof data.duration === 'number' ? data.duration : 0;
        }
    } catch (e) {
        console.warn('lyrics_sync: failed to load existing lyrics', e);
    }

    _lsEditorStems = stems;
    _lsEditorDuration = duration;
    _lsEditorSyllables = lyrics.map(_lsDecodeSyllable);
    _lsEditorSelectedIndex = -1;
    _lsEditorSource = source;
    _lsEditorLoopA = null;
    _lsEditorLoopB = null;
    _lsEditorLoopOn = false;
    _lsEditorHistory = [];
    _lsEditorHistoryIndex = -1;
    _lsEditorPushHistory();

    _lsEditorPopulateStemSelect();
    _lsEditorUpdateBadge();
    _lsEditorUpdateLoopButtons();
    _lsEditorRenderAll();

    const firstUrl = _lsEditorEls.stemSelect.value;
    if (firstUrl) _lsEditorSetAudioSrc(firstUrl);

    _lsEditorStartLoop();
}

function lsEditInEditor() {
    if (!_lsAlignmentResult) return;
    lsOpenEditor().then(() => {
        // Seed from the just-computed alignment result rather than what's
        // on disk, using the same "+"-marker rule `/save` applies.
        const granularity = _lsGetGranularity();
        const lyricsData = [];
        for (let i = 0; i < _lsAlignmentResult.length; i++) {
            const seg = _lsAlignmentResult[i];
            const isLineEnd = granularity === 'line'
                || i === _lsAlignmentResult.length - 1
                || !!(_lsAlignmentResult[i + 1] && _lsAlignmentResult[i + 1].new_line);
            let text = seg.text;
            if (isLineEnd && !text.endsWith('+')) text += '+';
            lyricsData.push({ t: seg.start, d: seg.end - seg.start, w: text });
        }
        _lsEditorSyllables = lyricsData.map(_lsDecodeSyllable);
        _lsEditorSelectedIndex = -1;
        _lsEditorSource = 'transcribed'; // local badge hint only; not yet saved
        _lsEditorHistory = [];
        _lsEditorHistoryIndex = -1;
        _lsEditorPushHistory();
        _lsEditorUpdateBadge();
        _lsEditorRenderAll();
    });
}

function lsCloseEditor() {
    _lsEditorStopLoop();
    _lsEditorStopTapMode();
    const audio = _lsEditorEls.audio;
    if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
    }
    if (_lsEditorEls.container) _lsEditorEls.container.classList.add('hidden');
}

function _lsEditorUpdateBadge() {
    const badge = _lsEditorEls.badge;
    if (!badge) return;
    if (['transcribed', 'whisperx', 'notechart', 'xml'].includes(_lsEditorSource)) {
        badge.textContent = 'Auto-transcribed — review before saving';
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

// ── DOM wiring ───────────────────────────────────────────────────────────

function _lsEditorCacheEls() {
    // Re-resolve (and re-wire) only when the cached container is gone —
    // the host may rebuild `.screen[id^="plugin-"]` subtrees, which would
    // otherwise leave every cached ref pointing at a detached node.
    if (_lsEditorEls.container && _lsEditorEls.container.isConnected) return;

    _lsEditorEls.container = document.getElementById('ls-editor');
    _lsEditorEls.badge = document.getElementById('ls-editor-badge');
    _lsEditorEls.undoBtn = document.getElementById('ls-editor-undo-btn');
    _lsEditorEls.redoBtn = document.getElementById('ls-editor-redo-btn');
    _lsEditorEls.playBtn = document.getElementById('ls-editor-play-btn');
    _lsEditorEls.time = document.getElementById('ls-editor-time');
    _lsEditorEls.stemSelect = document.getElementById('ls-editor-stem-select');
    _lsEditorEls.rateBtns = Array.from(document.querySelectorAll('.ls-rate-btn'));
    _lsEditorEls.loopAbtn = document.getElementById('ls-editor-loop-a-btn');
    _lsEditorEls.loopBbtn = document.getElementById('ls-editor-loop-b-btn');
    _lsEditorEls.loopToggleBtn = document.getElementById('ls-editor-loop-toggle-btn');
    _lsEditorEls.tapBtn = document.getElementById('ls-editor-tap-btn');
    _lsEditorEls.audio = document.getElementById('ls-editor-audio');
    _lsEditorEls.timelineWrap = document.getElementById('ls-editor-timeline-wrap');
    _lsEditorEls.canvas = document.getElementById('ls-editor-canvas');
    _lsEditorEls.seedText = document.getElementById('ls-editor-seed-text');
    _lsEditorEls.count = document.getElementById('ls-editor-count');
    _lsEditorEls.list = document.getElementById('ls-editor-list');
    _lsEditorEls.inspector = document.getElementById('ls-editor-inspector');
    _lsEditorEls.inspText = document.getElementById('ls-editor-insp-text');
    _lsEditorEls.inspT = document.getElementById('ls-editor-insp-t');
    _lsEditorEls.inspD = document.getElementById('ls-editor-insp-d');
    _lsEditorEls.inspJoin = document.getElementById('ls-editor-insp-join');
    _lsEditorEls.inspBrk = document.getElementById('ls-editor-insp-brk');
    _lsEditorEls.saveBtn = document.getElementById('ls-editor-save-btn');
    _lsEditorEls.saveStatus = document.getElementById('ls-editor-save-status');

    _lsEditorWireElementEvents();
}

function _lsEditorWireElementEvents() {
    // Element-scoped listeners: safe to (re)bind every time _lsEditorCacheEls
    // resolves fresh elements, since the old elements (and their listeners)
    // are discarded with the old DOM subtree. Document-level listeners are
    // wired exactly once, from the guarded screen-hook IIFE at the bottom
    // of this file, so they can't accumulate across re-resolves.
    const audio = _lsEditorEls.audio;
    if (audio) {
        audio.addEventListener('play', () => { _lsEditorEls.playBtn.textContent = '⏸'; });
        audio.addEventListener('pause', () => { _lsEditorEls.playBtn.textContent = '▶'; });
        audio.addEventListener('timeupdate', _lsEditorOnTimeUpdate);
        audio.addEventListener('loadedmetadata', () => {
            if (audio.duration && isFinite(audio.duration)) _lsEditorDuration = audio.duration;
            _lsEditorUpdateTimeLabel();
            _lsEditorRedrawWaveform();
        });
    }

    const canvas = _lsEditorEls.canvas;
    if (canvas) {
        canvas.addEventListener('pointerdown', _lsEditorOnCanvasPointerDown);
        canvas.addEventListener('dblclick', _lsEditorOnCanvasDblClick);
    }

    for (const el of [_lsEditorEls.inspText, _lsEditorEls.inspT, _lsEditorEls.inspD,
                       _lsEditorEls.inspJoin, _lsEditorEls.inspBrk]) {
        if (el) el.addEventListener('change', _lsEditorOnInspectorChange);
    }
}

// ── Transport ────────────────────────────────────────────────────────────

function lsEditorTogglePlay() {
    const audio = _lsEditorEls.audio;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
}

function lsEditorSetRate(rate) {
    if (_lsEditorEls.audio) _lsEditorEls.audio.playbackRate = rate;
    (_lsEditorEls.rateBtns || []).forEach((btn) => {
        const active = parseFloat(btn.dataset.rate) === rate;
        btn.className = 'ls-rate-btn px-2 py-1 rounded ' + (active ? 'bg-accent/30 text-accent' : 'bg-dark-700 hover:bg-dark-600');
    });
}

function lsEditorSetLoopA() {
    _lsEditorLoopA = _lsEditorEls.audio ? _lsEditorEls.audio.currentTime : 0;
    _lsEditorUpdateLoopButtons();
}

function lsEditorSetLoopB() {
    _lsEditorLoopB = _lsEditorEls.audio ? _lsEditorEls.audio.currentTime : 0;
    _lsEditorUpdateLoopButtons();
}

function lsEditorToggleLoop() {
    _lsEditorLoopOn = !_lsEditorLoopOn;
    _lsEditorUpdateLoopButtons();
}

function _lsEditorUpdateLoopButtons() {
    if (_lsEditorEls.loopAbtn) {
        _lsEditorEls.loopAbtn.textContent = _lsEditorLoopA != null ? `A: ${_lsEditorLoopA.toFixed(2)}s` : 'Set A';
    }
    if (_lsEditorEls.loopBbtn) {
        _lsEditorEls.loopBbtn.textContent = _lsEditorLoopB != null ? `B: ${_lsEditorLoopB.toFixed(2)}s` : 'Set B';
    }
    if (_lsEditorEls.loopToggleBtn) {
        _lsEditorEls.loopToggleBtn.textContent = 'Loop: ' + (_lsEditorLoopOn ? 'On' : 'Off');
        _lsEditorEls.loopToggleBtn.className = 'text-xs px-2 py-1 rounded '
            + (_lsEditorLoopOn ? 'bg-accent/30 text-accent' : 'bg-dark-700 hover:bg-dark-600 text-gray-400');
    }
}

function _lsEditorOnTimeUpdate() {
    const audio = _lsEditorEls.audio;
    if (!audio) return;
    if (_lsEditorLoopOn && _lsEditorLoopA != null && _lsEditorLoopB != null && audio.currentTime >= _lsEditorLoopB) {
        audio.currentTime = _lsEditorLoopA;
    }
    _lsEditorUpdateTimeLabel();
}

function _lsEditorUpdateTimeLabel() {
    const audio = _lsEditorEls.audio;
    const timeEl = _lsEditorEls.time;
    if (!audio || !timeEl) return;
    timeEl.textContent = `${_lsFormatTime(audio.currentTime || 0)} / ${_lsFormatTime(audio.duration || _lsEditorDuration || 0)}`;
}

function _lsEditorPopulateStemSelect() {
    const sel = _lsEditorEls.stemSelect;
    if (!sel) return;
    sel.innerHTML = '';
    if (_lsEditorStems.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No stems found';
        opt.disabled = true;
        sel.appendChild(opt);
        return;
    }
    for (const stem of _lsEditorStems) {
        const opt = document.createElement('option');
        opt.value = stem.url;
        opt.textContent = stem.id;
        if (stem.id.toLowerCase() === 'vocals') opt.selected = true;
        sel.appendChild(opt);
    }
}

function lsEditorChangeStem() {
    const sel = _lsEditorEls.stemSelect;
    if (sel && sel.value) _lsEditorSetAudioSrc(sel.value);
}

function _lsEditorSetAudioSrc(url) {
    const audio = _lsEditorEls.audio;
    if (!audio) return;
    const wasPlaying = !audio.paused;
    audio.src = url;
    audio.load();
    _lsEditorLoadWaveform(url);
    if (wasPlaying) audio.play().catch(() => {});
}

// ── Waveform ─────────────────────────────────────────────────────────────
//
// Decoded once per stem load via WebAudio (offline, not on the rAF path),
// reduced to a fixed-size peak envelope, and pre-painted into an offscreen
// canvas whenever the zoom level changes. The rAF loop only blits that
// offscreen canvas plus the playhead/blocks — see _lsEditorDrawFrame.

async function _lsEditorLoadWaveform(url) {
    _lsEditorWaveformPeaks = null;
    _lsEditorWaveformDuration = 0;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const arrayBuffer = await resp.arrayBuffer();
        let ctx;
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 8000 });
        } catch (e) {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        _lsEditorWaveformPeaks = _lsComputeWaveformPeaks(audioBuffer);
        _lsEditorWaveformDuration = audioBuffer.duration;
        if (typeof ctx.close === 'function') ctx.close();
    } catch (e) {
        console.warn('lyrics_sync: waveform decode failed', e);
        _lsEditorWaveformPeaks = null;
    }
    _lsEditorRedrawWaveform();
}

function _lsComputeWaveformPeaks(audioBuffer) {
    const COLUMNS = 2000;
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
    const len = ch0.length;
    const samplesPerColumn = Math.max(1, Math.floor(len / COLUMNS));
    const peaks = new Float32Array(COLUMNS * 2);
    for (let col = 0; col < COLUMNS; col++) {
        const start = col * samplesPerColumn;
        const end = Math.min(len, start + samplesPerColumn);
        let min = 0, max = 0;
        for (let i = start; i < end; i++) {
            const v = ch1 ? (ch0[i] + ch1[i]) / 2 : ch0[i];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        peaks[col * 2] = min;
        peaks[col * 2 + 1] = max;
    }
    return peaks;
}

function lsEditorZoom(factor) {
    _lsEditorPxPerSec = Math.max(5, Math.min(400, _lsEditorPxPerSec * factor));
    _lsEditorRedrawWaveform();
}

function _lsEditorRedrawWaveform() {
    const canvas = _lsEditorEls.canvas;
    const wrap = _lsEditorEls.timelineWrap;
    if (!canvas || !wrap) return;

    const duration = _lsEditorWaveformDuration || _lsEditorDuration || 30;
    const width = Math.max(wrap.clientWidth || 300, Math.ceil(duration * _lsEditorPxPerSec));
    const height = wrap.clientHeight || 128;
    canvas.width = width;
    canvas.height = height;

    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    const octx = off.getContext('2d');
    octx.fillStyle = '#0b0e14';
    octx.fillRect(0, 0, width, height);

    if (_lsEditorWaveformPeaks) {
        const mid = height / 2;
        const cols = _lsEditorWaveformPeaks.length / 2;
        octx.strokeStyle = 'rgba(96,165,250,0.55)';
        octx.lineWidth = 1;
        octx.beginPath();
        for (let col = 0; col < cols; col++) {
            const x = (col / cols) * width;
            const min = _lsEditorWaveformPeaks[col * 2];
            const max = _lsEditorWaveformPeaks[col * 2 + 1];
            octx.moveTo(x, mid + min * mid);
            octx.lineTo(x, mid + max * mid);
        }
        octx.stroke();
    }

    _lsEditorOffscreen = off;
    _lsEditorDrawFrame();
}

// ── rAF draw loop — cached refs only, no DOM queries ────────────────────

function _lsEditorDrawFrame() {
    const canvas = _lsEditorEls.canvas;
    if (!canvas || !_lsEditorOffscreen) return;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(_lsEditorOffscreen, 0, 0);

    const height = canvas.height;
    const pxPerSec = _lsEditorPxPerSec;
    const wrap = _lsEditorEls.timelineWrap;
    // Cull blocks outside the scrolled viewport (+padding) so a long song
    // at a wide zoom doesn't pay for thousands of off-screen fillRect calls
    // every frame.
    const scrollLeft = wrap ? wrap.scrollLeft : 0;
    const viewW = wrap ? wrap.clientWidth : canvas.width;
    const visStart = Math.max(0, scrollLeft - 150);
    const visEnd = scrollLeft + viewW + 150;

    for (let i = 0; i < _lsEditorSyllables.length; i++) {
        const syl = _lsEditorSyllables[i];
        if (syl.t == null || syl.d == null) continue;
        const x = syl.t * pxPerSec;
        const w = Math.max(2, syl.d * pxPerSec);
        if (x + w < visStart || x > visEnd) continue;

        const selected = i === _lsEditorSelectedIndex;
        ctx.fillStyle = selected ? 'rgba(232,192,64,0.55)' : 'rgba(64,128,224,0.35)';
        ctx.strokeStyle = selected ? '#e8c040' : 'rgba(64,128,224,0.85)';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.fillRect(x, 8, w, height - 16);
        ctx.strokeRect(x, 8, w, height - 16);
        if (w > 14) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, 0, w, height);
            ctx.clip();
            ctx.fillStyle = '#e5e7eb';
            ctx.font = '11px monospace';
            ctx.textBaseline = 'middle';
            const label = syl.w + (syl.join ? '-' : syl.brk ? '+' : '');
            ctx.fillText(label, x + 3, height / 2);
            ctx.restore();
        }
    }

    if (_lsEditorLoopA != null) _lsEditorDrawMarker(ctx, _lsEditorLoopA * pxPerSec, height, '#34d399');
    if (_lsEditorLoopB != null) _lsEditorDrawMarker(ctx, _lsEditorLoopB * pxPerSec, height, '#34d399');

    const audio = _lsEditorEls.audio;
    if (audio) _lsEditorDrawMarker(ctx, (audio.currentTime || 0) * pxPerSec, height, '#ffffff');
}

function _lsEditorDrawMarker(ctx, x, height, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
}

function _lsEditorStartLoop() {
    _lsEditorStopLoop();
    const tick = () => {
        _lsEditorDrawFrame();
        _lsEditorRafId = requestAnimationFrame(tick);
    };
    _lsEditorRafId = requestAnimationFrame(tick);
}

function _lsEditorStopLoop() {
    if (_lsEditorRafId != null) {
        cancelAnimationFrame(_lsEditorRafId);
        _lsEditorRafId = null;
    }
}

// ── Syllable block interaction (drag move/resize, click, seek) ─────────────

function _lsEditorHitTestBlock(e) {
    const canvas = _lsEditorEls.canvas;
    if (!canvas) return { index: -1, mode: null, x: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const EDGE_PX = 6;
    for (let i = _lsEditorSyllables.length - 1; i >= 0; i--) {
        const syl = _lsEditorSyllables[i];
        if (syl.t == null || syl.d == null) continue;
        const sx = syl.t * _lsEditorPxPerSec;
        const sw = Math.max(2, syl.d * _lsEditorPxPerSec);
        if (x >= sx - EDGE_PX && x <= sx + sw + EDGE_PX) {
            let mode = 'move';
            if (x <= sx + EDGE_PX) mode = 'resize-l';
            else if (x >= sx + sw - EDGE_PX) mode = 'resize-r';
            return { index: i, mode, x };
        }
    }
    return { index: -1, mode: null, x };
}

function _lsEditorSnapTime(t, excludeIndex, bypass) {
    if (bypass) return Math.max(0, t);
    const snapSec = 6 / _lsEditorPxPerSec;
    let best = t, bestDist = snapSec;
    for (let i = 0; i < _lsEditorSyllables.length; i++) {
        if (i === excludeIndex) continue;
        const syl = _lsEditorSyllables[i];
        if (syl.t == null || syl.d == null) continue;
        for (const candidate of [syl.t, syl.t + syl.d]) {
            const dist = Math.abs(candidate - t);
            if (dist < bestDist) { bestDist = dist; best = candidate; }
        }
    }
    return Math.max(0, best);
}

function _lsEditorOnCanvasPointerDown(e) {
    const hit = _lsEditorHitTestBlock(e);
    if (hit.index >= 0) {
        _lsEditorSelectSyllable(hit.index);
        const syl = _lsEditorSyllables[hit.index];
        _lsEditorDragState = {
            index: hit.index, mode: hit.mode,
            startX: e.clientX, origT: syl.t, origD: syl.d,
            pointerId: e.pointerId,
        };
        _lsEditorEls.canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
    }
    const t = hit.x / _lsEditorPxPerSec;
    if (_lsEditorEls.audio) _lsEditorEls.audio.currentTime = Math.max(0, t);
    _lsEditorSelectSyllable(-1);
}

function _lsEditorOnCanvasDblClick(e) {
    const hit = _lsEditorHitTestBlock(e);
    if (hit.index >= 0) {
        _lsEditorSelectSyllable(hit.index);
        _lsEditorEls.inspText.focus();
        _lsEditorEls.inspText.select();
    }
}

function _lsEditorOnPointerMove(e) {
    const drag = _lsEditorDragState;
    if (!drag) return;
    const syl = _lsEditorSyllables[drag.index];
    if (!syl) return;
    const dt = (e.clientX - drag.startX) / _lsEditorPxPerSec;
    const bypassSnap = e.altKey;
    const MIN_D = 0.02;

    if (drag.mode === 'move') {
        syl.t = _lsEditorSnapTime(Math.max(0, drag.origT + dt), drag.index, bypassSnap);
    } else if (drag.mode === 'resize-l') {
        const end = drag.origT + drag.origD;
        const newT = _lsEditorSnapTime(Math.max(0, drag.origT + dt), drag.index, bypassSnap);
        syl.t = Math.min(newT, end - MIN_D);
        syl.d = end - syl.t;
    } else if (drag.mode === 'resize-r') {
        const newEnd = _lsEditorSnapTime(drag.origT + drag.origD + dt, drag.index, bypassSnap);
        syl.d = Math.max(MIN_D, newEnd - syl.t);
    }
    _lsEditorRenderList();
}

function _lsEditorOnPointerUp(e) {
    if (!_lsEditorDragState) return;
    const canvas = _lsEditorEls.canvas;
    try {
        if (canvas) canvas.releasePointerCapture(_lsEditorDragState.pointerId);
    } catch (err) { /* pointer may already be released */ }
    _lsEditorDragState = null;
    _lsEditorPushHistory();
    _lsEditorSyncInspector();
}

// ── Selection + inspector ───────────────────────────────────────────────

function _lsEditorSelectSyllable(index) {
    _lsEditorSelectedIndex = index;
    _lsEditorSyncInspector();
    _lsEditorRenderList();
}

function _lsEditorSyncInspector() {
    const insp = _lsEditorEls.inspector;
    if (!insp) return;
    const syl = _lsEditorSyllables[_lsEditorSelectedIndex];
    if (_lsEditorSelectedIndex < 0 || !syl) {
        insp.classList.add('hidden');
        return;
    }
    insp.classList.remove('hidden');
    _lsEditorEls.inspText.value = syl.w;
    _lsEditorEls.inspT.value = syl.t != null ? syl.t.toFixed(3) : '';
    _lsEditorEls.inspD.value = syl.d != null ? syl.d.toFixed(3) : '';
    _lsEditorEls.inspJoin.checked = !!syl.join;
    _lsEditorEls.inspBrk.checked = !!syl.brk;
}

function _lsEditorOnInspectorChange(e) {
    const syl = _lsEditorSyllables[_lsEditorSelectedIndex];
    if (!syl) return;

    syl.w = _lsEditorEls.inspText.value;
    const tVal = parseFloat(_lsEditorEls.inspT.value);
    const dVal = parseFloat(_lsEditorEls.inspD.value);
    syl.t = Number.isFinite(tVal) ? tVal : null;
    syl.d = Number.isFinite(dVal) ? dVal : null;

    // join/brk are mutually exclusive — whichever checkbox the user just
    // ticked wins, clearing the other.
    if (e.target === _lsEditorEls.inspJoin && _lsEditorEls.inspJoin.checked) {
        syl.join = true; syl.brk = false; _lsEditorEls.inspBrk.checked = false;
    } else if (e.target === _lsEditorEls.inspBrk && _lsEditorEls.inspBrk.checked) {
        syl.brk = true; syl.join = false; _lsEditorEls.inspJoin.checked = false;
    } else {
        syl.join = _lsEditorEls.inspJoin.checked;
        syl.brk = _lsEditorEls.inspBrk.checked;
    }

    _lsEditorPushHistory();
    _lsEditorRenderList();
}

function lsEditorDeleteSelected() {
    if (_lsEditorSelectedIndex < 0) return;
    _lsEditorSyllables.splice(_lsEditorSelectedIndex, 1);
    _lsEditorSelectedIndex = -1;
    _lsEditorPushHistory();
    _lsEditorRenderAll();
}

// ── Seed from text ───────────────────────────────────────────────────────
//
// Manual split only — `/` marks a syllable boundary within a word (e.g.
// "won/der/ful"). No automatic syllabification: the two align-based flows
// above already cover that case.

function lsEditorSeedFromText() {
    const raw = _lsEditorEls.seedText.value;
    if (!raw.trim()) return;

    const newSyllables = [];
    for (const rawLine of raw.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const words = line.split(/\s+/);
        for (let wi = 0; wi < words.length; wi++) {
            const parts = words[wi].split('/').filter((p) => p.length > 0);
            const useParts = parts.length > 0 ? parts : [words[wi]];
            for (let pi = 0; pi < useParts.length; pi++) {
                const isLastPartOfWord = pi === useParts.length - 1;
                const isLastWordOfLine = wi === words.length - 1;
                newSyllables.push({
                    w: useParts[pi],
                    t: null,
                    d: null,
                    join: !isLastPartOfWord,
                    brk: isLastPartOfWord && isLastWordOfLine,
                });
            }
        }
    }
    if (newSyllables.length === 0) return;

    _lsEditorSyllables = _lsEditorSyllables.concat(newSyllables);
    _lsEditorEls.seedText.value = '';
    _lsEditorPushHistory();
    _lsEditorRenderAll();
}

// ── Tap-to-time ──────────────────────────────────────────────────────────
//
// Space stamps `t` on the next untimed syllable in order, and — unless a
// duration was already set by a drag/inspector edit — closes the PREVIOUS
// syllable's `d` at the same instant, so tapping through a whole verse at
// playback speed times it end to end.

function lsEditorToggleTapMode() {
    if (_lsEditorTapMode) {
        _lsEditorStopTapMode();
        return;
    }
    if (_lsEditorSyllables.length === 0) return;
    _lsEditorTapMode = true;
    const firstUntimed = _lsEditorSyllables.findIndex((s) => s.t == null);
    _lsEditorTapIndex = firstUntimed >= 0 ? firstUntimed : 0;
    _lsEditorUpdateTapButton();
    const audio = _lsEditorEls.audio;
    if (audio && audio.paused) audio.play().catch(() => {});
}

function _lsEditorStopTapMode() {
    if (!_lsEditorTapMode) return;
    _lsEditorTapMode = false;
    _lsEditorTapIndex = -1;
    _lsEditorUpdateTapButton();
    _lsEditorPushHistory();
}

function _lsEditorUpdateTapButton() {
    const btn = _lsEditorEls.tapBtn;
    if (!btn) return;
    btn.textContent = _lsEditorTapMode ? 'Tap-to-Time: ON — Space to tap, Esc to stop' : 'Tap-to-Time (T)';
    btn.className = 'text-xs px-3 py-1.5 rounded-lg ml-auto whitespace-nowrap '
        + (_lsEditorTapMode ? 'bg-accent text-white' : 'bg-dark-700 hover:bg-dark-600 text-gray-300');
}

function _lsEditorTap() {
    if (!_lsEditorTapMode) return;
    const audio = _lsEditorEls.audio;
    if (!audio) return;
    if (_lsEditorTapIndex >= _lsEditorSyllables.length) {
        _lsEditorStopTapMode();
        return;
    }
    const now = audio.currentTime;
    if (_lsEditorTapIndex > 0) {
        const prev = _lsEditorSyllables[_lsEditorTapIndex - 1];
        if (prev.t != null && prev.d == null) {
            prev.d = Math.max(0.02, now - prev.t);
        }
    }
    const syl = _lsEditorSyllables[_lsEditorTapIndex];
    syl.t = now;
    if (syl.d == null) syl.d = 0.25; // provisional; closed by the next tap or a manual edit
    _lsEditorTapIndex++;
    if (_lsEditorTapIndex >= _lsEditorSyllables.length) _lsEditorStopTapMode();
    _lsEditorRenderList();
}

function _lsEditorOnKeyDown(e) {
    if (!_lsEditorTapMode || e.repeat) return;
    const tag = (e.target && e.target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.target && e.target.isContentEditable) return;
    if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        _lsEditorTap();
    } else if (e.key === 'Escape') {
        _lsEditorStopTapMode();
    }
}

// ── List rendering ───────────────────────────────────────────────────────

function _lsEditorRenderList() {
    const list = _lsEditorEls.list;
    if (_lsEditorEls.count) _lsEditorEls.count.textContent = String(_lsEditorSyllables.length);
    if (!list) return;

    // createElement + textContent, never interpolated markup — lyric text
    // comes from pasted/uploaded input, not trusted for HTML context.
    list.innerHTML = '';
    _lsEditorSyllables.forEach((syl, i) => {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-dark-800/60 transition '
            + (i === _lsEditorSelectedIndex ? 'bg-accent/10' : '');
        row.addEventListener('click', () => _lsEditorSelectSyllable(i));

        const timeEl = document.createElement('span');
        timeEl.className = 'text-gray-500 font-mono w-16 shrink-0';
        timeEl.textContent = syl.t != null ? `${syl.t.toFixed(2)}s` : '—';

        const wordEl = document.createElement('span');
        wordEl.className = 'text-gray-200 flex-1 truncate';
        wordEl.textContent = syl.w + (syl.join ? '-' : syl.brk ? '+' : '');

        row.appendChild(timeEl);
        row.appendChild(wordEl);

        if (syl.t == null || syl.d == null) {
            const untimedBadge = document.createElement('span');
            untimedBadge.className = 'text-[10px] text-yellow-500 shrink-0';
            untimedBadge.textContent = 'untimed';
            row.appendChild(untimedBadge);
        }

        list.appendChild(row);
    });
}

function _lsEditorRenderAll() {
    _lsEditorRenderList();
    _lsEditorSyncInspector();
    _lsEditorUpdateUndoRedoButtons();
    _lsEditorRedrawWaveform();
}

// ── Save ─────────────────────────────────────────────────────────────────

async function lsEditorSave() {
    if (!_lsSelectedFilename) return;
    const btn = _lsEditorEls.saveBtn;
    const statusEl = _lsEditorEls.saveStatus;
    if (btn) btn.disabled = true;
    if (statusEl) {
        statusEl.textContent = 'Saving...';
        statusEl.className = 'text-xs text-gray-400';
        statusEl.classList.remove('hidden');
    }

    const timed = _lsEditorSyllables.filter((s) => s.t != null && s.d != null);
    const untimedCount = _lsEditorSyllables.length - timed.length;
    const payload = timed.map(_lsEncodeSyllable);

    try {
        const resp = await fetch('/api/plugins/lyrics_sync/save-lyrics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: _lsSelectedFilename, lyrics: payload }),
        });
        const data = await resp.json();
        if (data.ok) {
            let msg = `Saved ${data.lyrics_count} synced lyrics entries to song.`;
            if (untimedCount > 0) msg += ` ${untimedCount} untimed syllable${untimedCount !== 1 ? 's' : ''} skipped.`;
            if (statusEl) { statusEl.textContent = msg; statusEl.className = 'text-xs text-green-400'; }
            _lsEditorSource = 'user';
            _lsEditorUpdateBadge();
        } else {
            if (statusEl) { statusEl.textContent = `Error: ${data.error}`; statusEl.className = 'text-xs text-red-400'; }
        }
    } catch (e) {
        if (statusEl) { statusEl.textContent = `Failed: ${e.message}`; statusEl.className = 'text-xs text-red-400'; }
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ── Screen hook ──────────────────────────────────────────────────────────

(function() {
    // Idempotency: if screen.js is re-evaluated (loader cache miss, hot reload,
    // older core builds without the load-side guard), don't re-wrap showScreen —
    // each re-wrap captures the previous wrapper, growing the chain and
    // leaking closures.
    const HOOK_KEY = '__slopsmithLyricsSyncHooksInstalled';
    if (window[HOOK_KEY]) return;
    window[HOOK_KEY] = true;

    // Document-level editor listeners — bound exactly once, here, rather
    // than at raw top-level or inside _lsEditorWireElementEvents, so a
    // screen.js re-evaluation can't grow duplicate document listeners.
    document.addEventListener('pointermove', _lsEditorOnPointerMove);
    document.addEventListener('pointerup', _lsEditorOnPointerUp);
    document.addEventListener('keydown', _lsEditorOnKeyDown);
    window.addEventListener('resize', () => {
        if (_lsEditorIsOpen()) _lsEditorRedrawWaveform();
    });

    if (typeof window.registerShortcut === 'function') {
        window.registerShortcut({
            key: 't',
            description: 'Toggle tap-to-time in the lyrics editor',
            scope: 'plugin-lyrics_sync',
            condition: () => _lsEditorIsOpen(),
            handler: () => lsEditorToggleTapMode(),
        });
        window.registerShortcut({
            key: 'z',
            description: 'Undo lyrics edit',
            scope: 'plugin-lyrics_sync',
            condition: () => _lsEditorIsOpen() && !_lsEditorTapMode,
            handler: (e) => { if (e.ctrlKey || e.metaKey) lsEditorUndo(); },
        });
        window.registerShortcut({
            key: 'Z',
            description: 'Redo lyrics edit',
            scope: 'plugin-lyrics_sync',
            condition: () => _lsEditorIsOpen() && !_lsEditorTapMode,
            handler: (e) => { if ((e.ctrlKey || e.metaKey) && e.shiftKey) lsEditorRedo(); },
        });
    }

    const origShowScreen = window.showScreen;
    window.showScreen = function(id) {
        if (id !== 'plugin-lyrics_sync' && _lsEditorIsOpen()) {
            // Leaving the screen: stop the rAF loop and any in-progress tap
            // session rather than letting them run against a hidden screen.
            lsCloseEditor();
        }
        origShowScreen(id);
        if (id === 'plugin-lyrics_sync') lsLoadDashboard();
    };
})();
