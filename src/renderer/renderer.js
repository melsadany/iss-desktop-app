/* Iowa Speech Sample — renderer
 *
 * Pure browser code. Talks to main process via window.iss (preload bridge).
 */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- navigation ----------
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach((b) => b.classList.remove('active'));
    $$('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    $(`#view-${btn.dataset.view}`).classList.add('active');
    onViewChange(btn.dataset.view);
  });
});

// External links
$$('[data-href]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    window.iss.openExternal(el.dataset.href);
  });
});

$('#open-data-folder').addEventListener('click', async () => {
  const p = await window.iss.paths();
  window.iss.openPath(p.userData);
});

// ---------- theme toggle ----------
(function setupTheme() {
  const btn   = $('#theme-toggle');
  const icon  = $('#theme-icon');
  const label = $('#theme-label');

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('iss-theme', theme); } catch (e) {}
    if (theme === 'dark') {
      icon.textContent  = '\u263E';
      label.textContent = 'Dark';
    } else {
      icon.textContent  = '\u2600';
      label.textContent = 'Light';
    }
  }

  const initial = document.documentElement.getAttribute('data-theme') || 'light';
  apply(initial);

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    apply(current === 'dark' ? 'light' : 'dark');
  });
})();

// ---------- state ----------
let state = {
  paths: null,
  participants: [],
  pipelineStages: [],
  selectedRecParticipant: null,
  selectedRunParticipant: null,
  selectedRunSession: null,
  selectedResParticipant: null,
  audioStream: null,
  audioContext: null,
  mediaRecorder: null,
  audioChunks: [],
  taskVideoUrl: 'assets/task_video.mp4',
  // review tab state
  reviewFilePath: null,
  reviewRows: null,
  reviewDirty: false,
  // review audio playlist
  // Each entry: { stem, fileUrl, rows: [rowIdx, ...] }
  reviewPlaylist: [],
  reviewPlaylistIdx: -1,
  // column index cache
  revCols: null,
};

// ---------- bootstrap ----------
(async function init() {
  state.paths = await window.iss.paths();
  state.pipelineStages = await window.iss.pipelineStages();
  await refreshParticipants();
  await refreshSetup();
  bindSetup();
  bindParticipants();
  bindRecord();
  bindRun();
  bindReview();
  bindResults();
})();

async function onViewChange(name) {
  if (name === 'setup')        refreshSetup();
  if (name === 'participants') refreshParticipantsTable();
  if (name === 'record')       fillParticipantSelect('#rec-participant');
  if (name === 'run')          { fillParticipantSelect('#run-participant'); refreshRunSessions(); }
  if (name === 'review')       { fillParticipantSelect('#rev-participant'); }
  if (name === 'results')      { fillParticipantSelect('#res-participant'); refreshResults(); }
}

// ====================================================================
// SETUP
// ====================================================================
function bindSetup() {
  $('#btn-recheck').addEventListener('click', refreshSetup);
  $('#btn-pull').addEventListener('click', pullDockerImage);
  $('#btn-refdata').addEventListener('click', downloadReferenceData);

  window.iss.onDockerPullLog((line) => {
    const log = $('#pull-log');
    log.hidden = false;
    log.textContent += line;
    log.scrollTop = log.scrollHeight;
  });

  window.iss.onReferenceProgress((msg) => {
    const log = $('#ref-log');
    const bar = $('#ref-progress');
    log.hidden = false;
    bar.hidden = false;
    if (msg.phase === 'downloading' && msg.total) {
      bar.value = Math.round(msg.pct * 100);
      log.textContent = `Downloading\u2026 ${(msg.received/1e6).toFixed(1)} / ${(msg.total/1e6).toFixed(1)} MB (${(msg.pct*100).toFixed(1)}%)`;
    } else {
      log.textContent += `\n[${msg.phase}] ${msg.message || ''}`;
    }
  });
}

async function refreshSetup() {
  const s = await window.iss.systemCheck();
  setStatus('#docker-status', s.dockerRunning ? 'ok' : (s.dockerInstalled ? 'warn' : 'bad'),
    s.dockerRunning ? 'running' : (s.dockerInstalled ? 'not running' : 'not installed'));
  setStatus('#image-status', s.imagePresent ? 'ok' : 'warn',
    s.imagePresent ? 'present' : 'missing');
  setStatus('#ref-status',   s.referenceDataPresent ? 'ok' : 'warn',
    s.referenceDataPresent ? 'ready' : 'missing');

  $('#btn-pull').disabled    = !s.dockerRunning || s.imagePresent;
  $('#btn-refdata').disabled = s.referenceDataPresent;
}

function setStatus(sel, kind, text) {
  const el = $(sel);
  el.className = 'status ' + kind;
  el.textContent = text;
}

async function pullDockerImage() {
  $('#pull-log').hidden = false;
  $('#pull-log').textContent = '';
  $('#btn-pull').disabled = true;
  try {
    await window.iss.pullDockerImage();
    await refreshSetup();
  } catch (err) {
    $('#pull-log').textContent += `\n[error] ${err.message}`;
  } finally {
    $('#btn-pull').disabled = false;
  }
}

async function downloadReferenceData() {
  $('#btn-refdata').disabled = true;
  $('#ref-progress').hidden = false;
  $('#ref-log').hidden = false;
  try {
    await window.iss.downloadReferenceData();
    await refreshSetup();
  } catch (err) {
    $('#ref-log').textContent += `\n[error] ${err.message}`;
  } finally {
    $('#btn-refdata').disabled = false;
  }
}

// ====================================================================
// PARTICIPANTS
// ====================================================================
function bindParticipants() {
  $('#np-create').addEventListener('click', async () => {
    const id            = $('#np-id').value.trim();
    const label         = $('#np-label').value.trim();
    const notes         = $('#np-notes').value.trim();
    const age           = $('#np-age').value.trim();
    const sex           = $('#np-sex').value;
    const educationYears = $('#np-education').value.trim();
    const handedness    = $('#np-handedness').value;
    const msg           = $('#np-msg');
    msg.textContent = '';
    try {
      await window.iss.createParticipant({
        id, label, notes,
        age:           age           ? Number(age)           : null,
        sex:           sex           || null,
        educationYears: educationYears ? Number(educationYears) : null,
        handedness:    handedness    || null
      });
      ['#np-id','#np-label','#np-notes','#np-age','#np-education'].forEach(s => $(s).value = '');
      $('#np-sex').value = '';
      $('#np-handedness').value = '';
      msg.textContent = `Created ${id}.`;
      await refreshParticipants();
      refreshParticipantsTable();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

async function refreshParticipants() {
  state.participants = await window.iss.listParticipants();
}

async function refreshParticipantsTable() {
  await refreshParticipants();
  const tbody = $('#participants-table tbody');
  tbody.innerHTML = '';
  for (const p of state.participants) {
    const sessions = await window.iss.listSessions(p.id);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${p.id}</code></td>
      <td>${escapeHtml(p.label || '')}</td>
      <td>${new Date(p.createdAt).toLocaleString()}</td>
      <td>${sessions.length}</td>
      <td>
        <button data-action="open" data-id="${p.id}">Open folder</button>
        <button data-action="delete" data-id="${p.id}">Remove</button>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const p = state.participants.find((x) => x.id === btn.dataset.id);
    if (!p) return;
    if (btn.dataset.action === 'open') {
      window.iss.openPath(p.dir);
    } else if (btn.dataset.action === 'delete') {
      if (!confirm(`Remove ${p.id} from the index? Files on disk are kept.`)) return;
      await window.iss.deleteParticipant(p.id);
      await refreshParticipantsTable();
    }
  }, { once: true });
}

function fillParticipantSelect(selector) {
  const sel = $(selector);
  sel.innerHTML = '';
  if (state.participants.length === 0) {
    sel.innerHTML = '<option value="">No participants yet \u2014 create one first.</option>';
    return;
  }
  for (const p of state.participants) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.id}${p.label && p.label !== p.id ? ' \u2014 ' + p.label : ''}`;
    sel.appendChild(opt);
  }
}

// ====================================================================
// RECORD
// ====================================================================
function bindRecord() {
  const v = $('#rec-video');
  v.src = state.taskVideoUrl;

  $('#rec-mic').addEventListener('click', async () => {
    try {
      state.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      $('#rec-mic').disabled = true;
      $('#rec-start').disabled = false;
      $('#rec-status').textContent = 'Microphone enabled. Press Start task when ready.';
    } catch (err) {
      $('#rec-status').textContent = 'Could not access microphone: ' + err.message;
    }
  });

  $('#rec-start').addEventListener('click', startTask);
  $('#rec-stop').addEventListener('click', () => {
    if (state.mediaRecorder?.state === 'recording') state.mediaRecorder.stop();
  });

  const v2 = $('#rec-video');
  v2.addEventListener('ended', () => {
    if (state.mediaRecorder?.state === 'recording') state.mediaRecorder.stop();
  });
}

async function startTask() {
  const pid = $('#rec-participant').value;
  if (!pid) { $('#rec-status').textContent = 'Select a participant first.'; return; }
  if (!state.audioStream) { $('#rec-status').textContent = 'Enable microphone first.'; return; }

  state.audioChunks = [];
  const fmt = $('#rec-format').value;
  const mimeType = pickMimeType();

  try {
    state.mediaRecorder = new MediaRecorder(state.audioStream, { mimeType });
  } catch (err) {
    $('#rec-status').textContent = 'MediaRecorder error: ' + err.message;
    return;
  }

  state.mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.audioChunks.push(e.data);
  };

  state.mediaRecorder.onstop = async () => {
    $('#rec-status').textContent = 'Processing audio\u2026';
    const blob = new Blob(state.audioChunks, { type: state.mediaRecorder.mimeType });
    let finalBlob = blob;
    let extension = (state.mediaRecorder.mimeType.includes('ogg') ? 'ogg' :
                     state.mediaRecorder.mimeType.includes('webm') ? 'webm' : 'audio');
    try {
      if (fmt === 'mp3')  { finalBlob = await convertToMp3(blob); extension = 'mp3'; }
      if (fmt === 'wav')  { finalBlob = await convertToWav(blob); extension = 'wav'; }
    } catch (err) {
      $('#rec-status').textContent = 'Conversion failed: ' + err.message;
      return;
    }

    const buffer  = await finalBlob.arrayBuffer();
    const session = await window.iss.saveRecording({ participantId: pid, buffer, extension });
    $('#rec-status').textContent = `Saved ${session.audioFilename}. Switch to "Run pipeline" to analyze.`;
    $('#rec-stop').disabled  = true;
    $('#rec-start').disabled = false;
  };

  const v = $('#rec-video');
  try {
    if (v.requestFullscreen)            await v.requestFullscreen();
    else if (v.webkitRequestFullscreen)  v.webkitRequestFullscreen();
  } catch {}
  v.controls = false;

  state.mediaRecorder.start();
  v.currentTime = 0;
  v.play();

  $('#rec-status').textContent = 'Task running \u00b7 recording audio\u2026';
  $('#rec-start').disabled = true;
  $('#rec-stop').disabled  = false;
}

function pickMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  for (const t of types) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

async function convertToMp3(blob) {
  const ab = await blob.arrayBuffer();
  const buf = await state.audioContext.decodeAudioData(ab);
  const samples = buf.getChannelData(0);
  const sr = buf.sampleRate;
  const i16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const enc = new lamejs.Mp3Encoder(1, sr, 128);
  const out = [];
  const block = 1152;
  for (let i = 0; i < i16.length; i += block) {
    const c = i16.subarray(i, i + block);
    const m = enc.encodeBuffer(c);
    if (m.length) out.push(m);
  }
  const tail = enc.flush();
  if (tail.length) out.push(tail);
  return new Blob(out, { type: 'audio/mp3' });
}

async function convertToWav(blob) {
  const ab = await blob.arrayBuffer();
  const buf = await state.audioContext.decodeAudioData(ab);
  const samples = buf.getChannelData(0);
  const sr = buf.sampleRate;
  const dataLen = samples.length * 2;
  const out = new ArrayBuffer(44 + dataLen);
  const v = new DataView(out);
  v.setUint32(0,  0x52494646, false);
  v.setUint32(4,  36 + dataLen, true);
  v.setUint32(8,  0x57415645, false);
  v.setUint32(12, 0x666d7420, false);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1,  true);
  v.setUint16(22, 1,  true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2,  true);
  v.setUint16(34, 16, true);
  v.setUint32(36, 0x64617461, false);
  v.setUint32(40, dataLen, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([out], { type: 'audio/wav' });
}

// ====================================================================
// RUN
// ====================================================================

function buildStagePanel() {
  const list = $('#stage-list');
  list.innerHTML = '';
  for (const stage of state.pipelineStages) {
    const li = document.createElement('li');
    li.className = 'stage-item';
    li.dataset.stageId = stage.id;
    li.innerHTML = `
      <span class="stage-dot"></span>
      <span class="stage-label">${escapeHtml(stage.label)}</span>
      <span class="stage-badge"></span>`;
    list.appendChild(li);
  }
}

function buildStageChecklist() {
  const ul = $('#stage-checklist');
  ul.innerHTML = '';
  for (const stage of state.pipelineStages) {
    const li = document.createElement('li');
    li.className = 'stage-check-item';
    li.innerHTML = `
      <label class="stage-check-label">
        <input type="checkbox" class="stage-checkbox" data-stage-id="${escapeHtml(stage.id)}" checked />
        <span>${escapeHtml(stage.label)}</span>
        <span class="stage-check-badge" data-stage-id="${escapeHtml(stage.id)}"></span>
      </label>`;
    ul.appendChild(li);
  }

  const stage2cb = $('.stage-checkbox[data-stage-id="stage2"]');
  if (stage2cb) {
    stage2cb.addEventListener('change', updateWhisperModelVisibility);
    updateWhisperModelVisibility();
  }
}

function updateWhisperModelVisibility() {
  const stage2cb = $('.stage-checkbox[data-stage-id="stage2"]');
  const row = $('#whisper-model-row');
  if (!stage2cb || !row) return;
  const visible = stage2cb.checked && !stage2cb.disabled;
  row.hidden = !visible;
}

function updateWhisperRamWarn() {
  const sel  = $('#whisper-model');
  const warn = $('#whisper-ram-warn');
  if (!sel || !warn) return;
  warn.hidden = sel.value === 'small';
}

function resetStagePanel() {
  $$('.stage-item').forEach((li) => {
    li.className = 'stage-item';
    li.querySelector('.stage-badge').textContent = '';
  });
}

function updateStageUI(stageId, status) {
  const li = $(`.stage-item[data-stage-id="${stageId}"]`);
  if (!li) return;
  li.className = `stage-item ${status}`;
  const badge = li.querySelector('.stage-badge');
  const labels = { running: 'running', completed: 'done', error: 'error', cancelled: 'cancelled' };
  badge.textContent = labels[status] || '';
}

async function detectRunnableStages() {
  const sessionId = $('#run-session').value;
  if (!sessionId) {
    $('#detect-hint').textContent = 'Select a session first.';
    return;
  }

  $('#btn-detect-stages').disabled = true;
  $('#detect-hint').textContent = 'Scanning output folder\u2026';

  try {
    const results = await window.iss.detectPipelineStages({ sessionId });

    for (const r of results) {
      const cb = $(`.stage-checkbox[data-stage-id="${r.id}"]`);
      const badge = $(`.stage-check-badge[data-stage-id="${r.id}"]`);
      if (!cb) continue;

      cb.disabled = !r.canRun;
      cb.checked  = r.canRun;

      if (!r.canRun) {
        badge.textContent = 'prereq missing';
        badge.className = 'stage-check-badge badge-disabled';
      } else if (r.outputExists) {
        badge.textContent = 'output exists \u2014 will re-run';
        badge.className = 'stage-check-badge badge-warn';
      } else {
        badge.textContent = '';
        badge.className = 'stage-check-badge';
      }
    }

    updateWhisperModelVisibility();

    const runnable = results.filter((r) => r.canRun).length;
    $('#detect-hint').textContent =
      `${runnable} of ${results.length} stages can run. Uncheck any you want to skip.`;
  } catch (err) {
    $('#detect-hint').textContent = 'Detection failed: ' + err.message;
  } finally {
    $('#btn-detect-stages').disabled = false;
  }
}

function bindRun() {
  buildStagePanel();
  buildStageChecklist();

  $('#run-participant').addEventListener('change', refreshRunSessions);
  $('#run-session').addEventListener('change', () => {
    $$('.stage-check-badge').forEach((b) => { b.textContent = ''; b.className = 'stage-check-badge'; });
    $$('.stage-checkbox').forEach((cb) => { cb.disabled = false; cb.checked = true; });
    $('#whisper-model').value = 'small';
    updateWhisperModelVisibility();
    updateWhisperRamWarn();
    $('#detect-hint').textContent = 'Select a session, then click Detect to auto-select runnable stages.';
  });

  $('#whisper-model').addEventListener('change', updateWhisperRamWarn);
  $('#btn-detect-stages').addEventListener('click', detectRunnableStages);
  $('#run-start').addEventListener('click', runPipeline);

  $('#run-cancel').addEventListener('click', async () => {
    $('#run-cancel').disabled = true;
    $('#run-status').textContent = 'Stopping\u2026';
    await window.iss.cancelPipeline();
  });

  window.iss.onPipelineLog(({ line }) => {
    const log = $('#run-log');
    log.textContent += line;
    log.scrollTop = log.scrollHeight;
  });

  window.iss.onPipelineStageUpdate(({ stageId, status }) => {
    updateStageUI(stageId, status);
  });
}

async function refreshRunSessions() {
  const pid = $('#run-participant').value;
  const sel = $('#run-session');
  sel.innerHTML = '';
  if (!pid) return;
  const sessions = await window.iss.listSessions(pid);
  if (sessions.length === 0) {
    sel.innerHTML = '<option value="">No recordings yet for this participant.</option>';
    return;
  }
  for (const s of sessions.slice().reverse()) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.audioFilename} \u00b7 ${new Date(s.recordedAt).toLocaleString()} \u00b7 ${s.pipelineStatus}`;
    sel.appendChild(opt);
  }
  sel.dispatchEvent(new Event('change'));
}

async function runPipeline() {
  const sessionId = $('#run-session').value;
  if (!sessionId) { $('#run-status').textContent = 'Pick a session first.'; return; }

  const selectedStages = $$('.stage-checkbox')
    .filter((cb) => cb.checked && !cb.disabled)
    .map((cb) => cb.dataset.stageId);

  if (selectedStages.length === 0) {
    $('#run-status').textContent = 'Check at least one stage to run.';
    return;
  }

  const whisperModel = selectedStages.includes('stage2')
    ? ($('#whisper-model').value || 'small')
    : null;

  $('#run-log').textContent = '';
  $('#run-status').textContent = 'Starting\u2026';
  $('#run-start').disabled  = true;
  $('#run-cancel').disabled = false;
  $('#stage-panel').hidden  = false;
  resetStagePanel();

  $$('.stage-item').forEach((li) => {
    if (!selectedStages.includes(li.dataset.stageId)) {
      li.classList.add('skipped');
    }
  });

  try {
    const r = await window.iss.runPipeline({ sessionId, stages: selectedStages, whisperModel });
    $('#run-status').textContent = r.ok
      ? 'Pipeline finished successfully.'
      : `Pipeline exited with code ${r.exitCode ?? '?'}.`;
  } catch (err) {
    $('#run-status').textContent = 'Error: ' + err.message;
  } finally {
    $('#run-start').disabled  = false;
    $('#run-cancel').disabled = true;
  }
}

// ====================================================================
// REVIEW
// ====================================================================

// TSV column names we care about. Resolved once per load.
const REV_EXPECTED_COLS = ['audio_file', 'start', 'end', 'response', 'drop', 'comment'];

function bindReview() {
  $('#rev-load').addEventListener('click', loadReview);
  $('#rev-save').addEventListener('click', saveReview);

  // audio ended → auto-advance to next clip in playlist
  const audio = $('#rev-audio');
  audio.addEventListener('ended', () => revPlaylistAdvance(1));

  // timeupdate → highlight active row
  audio.addEventListener('timeupdate', () => {
    const ct = audio.currentTime;
    const entry = state.reviewPlaylist[state.reviewPlaylistIdx];
    if (!entry || !state.revCols) return;

    const startCol = state.revCols.start;
    const endCol   = state.revCols.end;

    // Clear all highlights first
    $$('#rev-table tbody tr.rev-row-active').forEach((r) => r.classList.remove('rev-row-active'));

    // Find which row's window contains currentTime
    for (const rowIdx of entry.rowIdxs) {
      const row = state.reviewRows[rowIdx];
      if (!row) continue;
      const s = parseFloat(row[startCol]);
      const e = parseFloat(row[endCol]);
      if (!isNaN(s) && !isNaN(e) && ct >= s && ct <= e) {
        const tr = $(`#rev-table tbody tr[data-row-idx="${rowIdx}"]`);
        if (tr) {
          tr.classList.add('rev-row-active');
          tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        break;
      }
    }
  });
}

async function loadReview() {
  const pid = $('#rev-participant').value;
  if (!pid) { $('#rev-status').textContent = 'Select a participant first.'; return; }

  $('#rev-load').disabled = true;
  $('#rev-status').textContent = 'Loading\u2026';

  // Reset audio player
  const audio = $('#rev-audio');
  audio.pause();
  audio.src = '';
  state.reviewPlaylist    = [];
  state.reviewPlaylistIdx = -1;
  $('#rev-audio-wrap').hidden = true;

  try {
    const [{ rows, filePath, error }, audioFiles] = await Promise.all([
      window.iss.loadReview(pid),
      window.iss.getAudioFiles(pid),
    ]);

    if (error) {
      $('#rev-status').textContent = error;
      $('#rev-table-wrap').hidden = true;
      $('#rev-empty').hidden = false;
      $('#rev-save').disabled = true;
      state.reviewFilePath = null;
      state.reviewRows = null;
      return;
    }

    // ---- resolve column indices from header row ----
    const header = rows[0];
    const colIdx = (name) => header.indexOf(name);

    let dropCol    = colIdx('drop');
    let commentCol = colIdx('comment');

    // If drop/comment columns don't exist yet, append them
    const needDrop    = dropCol    === -1;
    const needComment = commentCol === -1;

    const workRows = rows.map((r) => [...r]); // deep copy

    if (needDrop) {
      workRows[0].push('drop');
      dropCol = workRows[0].length - 1;
      for (let i = 1; i < workRows.length; i++) workRows[i].push('FALSE');
    }
    if (needComment) {
      workRows[0].push('comment');
      commentCol = workRows[0].length - 1;
      for (let i = 1; i < workRows.length; i++) workRows[i].push('FALSE');
    }

    const audioFileCol = colIdx('audio_file');
    const startCol     = colIdx('start');
    const endCol       = colIdx('end');
    const responseCol  = colIdx('response');

    state.revCols = {
      audioFile: audioFileCol,
      start:     startCol,
      end:       endCol,
      response:  responseCol,
      drop:      dropCol,
      comment:   commentCol,
    };

    state.reviewFilePath = filePath;
    state.reviewRows     = workRows;
    state.reviewDirty    = false;

    // ---- build audio playlist ----
    // audioFiles is [{ stem, fileUrl }, ...] ordered by filename
    // Map each unique audio_file stem from TSV → fileUrl
    const stemToUrl = {};
    for (const af of audioFiles) stemToUrl[af.stem] = af.fileUrl;

    // Walk data rows in order, group consecutive rows by audio_file
    const playlist = [];
    const seenStems = new Map(); // stem -> playlist index
    for (let i = 1; i < workRows.length; i++) {
      const stem = workRows[i][audioFileCol];
      if (!stem || stem === 'NA') continue;
      if (!seenStems.has(stem)) {
        seenStems.set(stem, playlist.length);
        playlist.push({ stem, fileUrl: stemToUrl[stem] || null, rowIdxs: [] });
      }
      playlist[seenStems.get(stem)].rowIdxs.push(i);
    }
    state.reviewPlaylist = playlist;

    // ---- render table ----
    $('#rev-filename').textContent = filePath.split(/[\\/]/).pop();
    renderReviewTable(workRows);
    $('#rev-table-wrap').hidden = false;
    $('#rev-empty').hidden = true;
    $('#rev-save').disabled = false;
    $('#rev-status').textContent =
      `Loaded ${workRows.length - 1} rows across ${playlist.length} audio clip(s).`;

    // ---- build playlist UI and load first clip ----
    if (playlist.length > 0) {
      buildRevPlaylistUI();
      revLoadClip(0);
      $('#rev-audio-wrap').hidden = false;
    }
  } catch (err) {
    $('#rev-status').textContent = 'Error: ' + err.message;
  } finally {
    $('#rev-load').disabled = false;
  }
}

// Build the clickable clip buttons inside #rev-playlist
function buildRevPlaylistUI() {
  const container = $('#rev-playlist');
  container.innerHTML = '';
  state.reviewPlaylist.forEach((entry, idx) => {
    const btn = document.createElement('button');
    btn.className = 'rev-clip-btn';
    btn.dataset.clipIdx = idx;
    // Show a readable label: strip participantId prefix and underscores
    btn.textContent = entry.stem.replace(/^[^_]+_/, '').replace(/_/g, ' ');
    btn.title = entry.stem;
    if (!entry.fileUrl) {
      btn.disabled = true;
      btn.title += ' (file not found)';
    }
    btn.addEventListener('click', () => revLoadClip(idx));
    container.appendChild(btn);
  });
}

// Load a specific clip by playlist index and start playing
function revLoadClip(idx) {
  if (idx < 0 || idx >= state.reviewPlaylist.length) return;
  const entry = state.reviewPlaylist[idx];
  if (!entry.fileUrl) return;

  state.reviewPlaylistIdx = idx;

  const audio = $('#rev-audio');
  audio.src = entry.fileUrl;
  audio.load();

  // Update label
  $('#rev-clip-label').textContent =
    `Clip ${idx + 1} / ${state.reviewPlaylist.length}: ${entry.stem.replace(/^[^_]+_/, '').replace(/_/g, ' ')}`;

  // Highlight active playlist button
  $$('#rev-playlist .rev-clip-btn').forEach((b) => b.classList.remove('active'));
  const activeBtn = $(`#rev-playlist .rev-clip-btn[data-clip-idx="${idx}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  // Highlight the first row of this clip in the table
  $$('#rev-table tbody tr.rev-row-active').forEach((r) => r.classList.remove('rev-row-active'));
  const firstRowIdx = entry.rowIdxs[0];
  if (firstRowIdx != null) {
    const tr = $(`#rev-table tbody tr[data-row-idx="${firstRowIdx}"]`);
    if (tr) tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// Advance to next or previous clip
function revPlaylistAdvance(delta) {
  const next = state.reviewPlaylistIdx + delta;
  if (next >= 0 && next < state.reviewPlaylist.length) {
    revLoadClip(next);
    $('#rev-audio').play();
  }
}

function renderReviewTable(rows) {
  const thead = $('#rev-table thead');
  const tbody = $('#rev-table tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';
  if (!rows.length) return;

  const cols = state.revCols || {};

  // Header row
  const htr = document.createElement('tr');
  rows[0].forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    htr.appendChild(th);
  });
  thead.appendChild(htr);

  // Data rows
  rows.slice(1).forEach((row, zeroIdx) => {
    const rowIdx = zeroIdx + 1; // index into state.reviewRows (0 = header)
    const tr = document.createElement('tr');
    tr.dataset.rowIdx = rowIdx;

    // Click anywhere on the row → jump to that clip+timestamp
    tr.addEventListener('click', (e) => {
      // Don't hijack clicks on editable cells or checkboxes
      if (e.target.contentEditable === 'true' || e.target.tagName === 'INPUT') return;
      revSeekToRow(rowIdx);
    });

    row.forEach((cell, colIdx) => {
      const td = document.createElement('td');

      if (colIdx === cols.drop || colIdx === cols.comment) {
        // Checkbox cell
        td.className = 'rev-check-cell';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = (cell === 'TRUE');
        cb.addEventListener('change', () => {
          state.reviewRows[rowIdx][colIdx] = cb.checked ? 'TRUE' : 'FALSE';
          state.reviewDirty = true;
          $('#rev-save').classList.add('unsaved');
          // Visually dim the row if dropped
          if (colIdx === cols.drop) {
            tr.classList.toggle('rev-row-dropped', cb.checked);
          }
        });
        // Apply initial dropped styling
        if (colIdx === cols.drop && cell === 'TRUE') tr.classList.add('rev-row-dropped');
        td.appendChild(cb);
      } else if (colIdx === cols.response) {
        // Editable text cell
        td.textContent = cell;
        td.contentEditable = 'true';
        td.dataset.row = rowIdx;
        td.dataset.col = colIdx;
        td.addEventListener('input', () => {
          state.reviewRows[rowIdx][colIdx] = td.textContent;
          state.reviewDirty = true;
          $('#rev-save').classList.add('unsaved');
        });
        td.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const next = tbody.querySelector(`td[data-row="${rowIdx}"][data-col="${colIdx + 1}"]`);
            if (next) next.focus();
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            const next = tbody.querySelector(`td[data-row="${rowIdx + 1}"][data-col="${colIdx}"]`);
            if (next) next.focus();
          }
        });
      } else {
        // Read-only display cell
        td.textContent = cell;
      }

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

// Seek the audio player to the start time of a given TSV row,
// switching clips if needed.
function revSeekToRow(rowIdx) {
  if (!state.revCols || !state.reviewRows) return;
  const row = state.reviewRows[rowIdx];
  if (!row) return;

  const stem  = row[state.revCols.audioFile];
  const start = parseFloat(row[state.revCols.start]);
  if (!stem || isNaN(start)) return;

  // Find this stem in the playlist
  const pIdx = state.reviewPlaylist.findIndex((e) => e.stem === stem);
  if (pIdx === -1) return;

  const audio = $('#rev-audio');

  if (pIdx !== state.reviewPlaylistIdx) {
    // Different clip — load it, then seek after loadedmetadata
    revLoadClip(pIdx);
    audio.addEventListener('loadedmetadata', () => {
      audio.currentTime = start;
      audio.play();
    }, { once: true });
  } else {
    // Same clip — just seek
    audio.currentTime = start;
    audio.play();
  }
}

async function saveReview() {
  if (!state.reviewFilePath || !state.reviewRows) return;
  $('#rev-save').disabled = true;
  $('#rev-status').textContent = 'Saving\u2026';
  try {
    await window.iss.saveReview({ filePath: state.reviewFilePath, rows: state.reviewRows });
    state.reviewDirty = false;
    $('#rev-save').classList.remove('unsaved');
    $('#rev-status').textContent = 'Saved.';
  } catch (err) {
    $('#rev-status').textContent = 'Save failed: ' + err.message;
  } finally {
    $('#rev-save').disabled = false;
  }
}

// ====================================================================
// RESULTS
// ====================================================================
function bindResults() {
  $('#res-participant').addEventListener('change', refreshResults);
  $('#res-refresh').addEventListener('click', refreshResults);
  $('#res-open-folder').addEventListener('click', async () => {
    const pid = $('#res-participant').value;
    if (!pid) return;
    const p = state.participants.find((x) => x.id === pid);
    if (p) window.iss.openPath(p.dir + '/output');
  });
}

async function refreshResults() {
  const pid = $('#res-participant').value;
  const ul  = $('#res-files');
  ul.innerHTML = '';
  clearResultPreview();
  if (!pid) return;

  const files = await window.iss.listResults(pid);
  if (files.length === 0) {
    ul.innerHTML = '<li class="muted">No output files found \u2014 run the pipeline first.</li>';
    return;
  }

  files.forEach((f) => {
    const li  = document.createElement('li');
    const ext = f.ext.replace('.', '');
    li.innerHTML = `
      <span>
        <span class="file-ext-badge ${escapeHtml(ext)}">${escapeHtml(ext)}</span>
        ${escapeHtml(f.name)}
      </span>
      <span class="file-meta">${(f.size / 1024).toFixed(1)} KB</span>
    `;
    li.addEventListener('click', () => {
      $$('#res-files li').forEach((x) => x.classList.remove('selected'));
      li.classList.add('selected');
      openResultFile(f);
    });
    ul.appendChild(li);
  });
}

async function openResultFile(f) {
  $('#res-filename').textContent = f.name;
  $('#btn-open-file').hidden = false;
  $('#btn-open-file').onclick = () => window.iss.openPath(f.path);
  $('#res-filemeta').textContent =
    `${(f.size / 1024).toFixed(1)} KB  \u00b7  ${new Date(f.mtime).toLocaleString()}`;

  const tabular = ['.csv', '.tsv'];

  if (tabular.includes(f.ext)) {
    $('#res-table-wrap').hidden = false;
    $('#res-nontabular').hidden = true;
    try {
      const { rows, truncated } = await window.iss.readCsv(f.path);
      renderTable(rows);
      if (truncated) $('#res-filemeta').textContent += '  \u00b7  (first 2 MB shown)';
    } catch (err) {
      $('#res-filemeta').textContent += `  \u00b7  Error reading file: ${err.message}`;
    }
  } else {
    $('#res-table-wrap').hidden = true;
    $('#res-nontabular').hidden = false;
    const messages = {
      '.rds':  `RDS file \u2014 open in R with <code>readRDS("${escapeHtml(f.name)}")</code>`,
      '.json': 'JSON file \u2014 click "Open in folder" to inspect it.',
      '.txt':  'Text file \u2014 click "Open in folder" to view it.',
    };
    $('#res-nontabular-msg').innerHTML =
      messages[f.ext] || 'Binary or unsupported format \u2014 click "Open in folder" to view.';
  }
}

function clearResultPreview() {
  $('#res-filename').textContent = 'No file selected';
  $('#btn-open-file').hidden = true;
  $('#res-filemeta').textContent = '';
  $('#res-table-wrap').hidden = true;
  $('#res-nontabular').hidden = true;
  $('#res-table thead').innerHTML = '';
  $('#res-table tbody').innerHTML = '';
}

function renderTable(rows) {
  const thead = $('#res-table thead');
  const tbody = $('#res-table tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';
  if (!rows.length) return;
  const htr = document.createElement('tr');
  rows[0].forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  rows.slice(1).forEach((row) => {
    const tr = document.createElement('tr');
    row.forEach((cell) => {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
