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
    _lsSelectedFilename = filename;
    _lsSelectedTitle = title;
    _lsSelectedArtist = artist;

    document.getElementById('ls-search-results').innerHTML = '';
    document.getElementById('ls-search').value = '';
    document.getElementById('ls-selected-song').classList.remove('hidden');
    document.getElementById('ls-selected-label').textContent = `${title} — ${artist}`;
    _lsUpdateAlignBtn();
}

function lsClearSong() {
    _lsSelectedFilename = null;
    _lsSelectedTitle = "";
    _lsSelectedArtist = "";
    document.getElementById('ls-selected-song').classList.add('hidden');
    document.getElementById('ls-selected-label').textContent = '';
    _lsUpdateAlignBtn();
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

// ── Screen hook ──────────────────────────────────────────────────────────

(function() {
    // Idempotency: if screen.js is re-evaluated (loader cache miss, hot reload,
    // older core builds without the load-side guard), don't re-wrap showScreen —
    // each re-wrap captures the previous wrapper, growing the chain and
    // leaking closures.
    const HOOK_KEY = '__slopsmithLyricsSyncHooksInstalled';
    if (window[HOOK_KEY]) return;
    window[HOOK_KEY] = true;

    const origShowScreen = window.showScreen;
    window.showScreen = function(id) {
        origShowScreen(id);
        if (id === 'plugin-lyrics_sync') lsLoadDashboard();
    };
})();
