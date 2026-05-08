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
  reviewInitials: null,       // set once per app launch via initials modal
  reviewPriorVotes: null,     // { "audio_file::start" -> { dropCount, commentCount, total, raters[] } }
  reviewRaters: [],           // unique initials of prior reviewers
  // review audio playlist
  reviewPlaylist: [],
  reviewPlaylistIdx: -1,
  // column index cache (indices into the FULL underlying row, not the visible columns)
  revCols: null,
};

// Columns shown in the review table, in display order.
// 'response' is editable; 'drop' and 'comment' become checkboxes.
// 'prior_votes' is a synthetic read-only column added by the renderer.
const REV_VISIBLE_COLS = ['task', 'prompt', 'trial', 'response', 'confidence', 'drop', 'comment', 'prior_votes'];

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
      } else if (r.reviewedTsvPresent) {
        badge.textContent = 'reviewed TSV found \u2014 re-run to apply';
        badge.className = 'stage-check-badge badge-warn';
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
// REVIEW — initials modal
// ====================================================================

/**
 * Show the initials modal and resolve with the entered initials.
 * If 