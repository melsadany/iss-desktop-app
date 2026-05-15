/* Iowa Speech Sample — renderer
 *
 * Pure browser code. Talks to main process via window.iss (preload bridge).
 */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- navigation ----------
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const viewId = `#view-${btn.dataset.view}`;
    const target = $(viewId);
    if (!target) return; // guard: skip if view section doesn't exist
    $$('.nav-item').forEach((b) => b.classList.remove('active'));
    $$('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    target.classList.add('active');
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
  reviewInitials: null,
  reviewPriorVotes: null,
  reviewRaters: [],
  reviewPlaylist: [],
  reviewPlaylistIdx: -1,
  revCols: null,
};

const REV_VISIBLE_COLS = ['task', 'prompt', 'trial', 'response', 'confidence', 'drop', 'comment', 'prior_votes'];

// ---------- bootstrap ----------
// IMPORTANT: bind all event listeners FIRST (synchronous), then do async data
// loading. This ensures the UI is fully interactive immediately — Docker checks
// and other slow IPC calls cannot block button registration.
(async function init() {
  // 1. Bind everything synchronously — UI is immediately interactive
  bindSetup();
  bindParticipants();
  bindRecord();
  bindRun();
  bindReview();
  bindResults();

  // 2. Load data async — slow calls (Docker check, disk scan) happen in background
  try {
    state.paths          = await window.iss.paths();
    state.pipelineStages = await window.iss.pipelineStages();
    buildStagePanel();
    buildStageChecklist();
  } catch (err) {
    console.error('[init] paths/stages failed:', err);
  }

  try {
    await refreshParticipants();
  } catch (err) {
    console.error('[init] refreshParticipants failed:', err);
  }

  // System check runs last — it can take up to 10s waiting on Docker
  refreshSetup().catch((err) => console.error('[init] refreshSetup failed:', err));
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
  if (!state.pipelineStages.length) return;
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
  if (!state.pipelineStages.length) return;
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

  const stage3cb = $('.stage-checkbox[data-stage-id="stage3"]');
  if (stage3cb) {
    stage3cb.addEventListener('change', () => {
      updateTranscriptionSettingsVisibility();
      updateStage3ReviewerPanel();
    });
    updateTranscriptionSettingsVisibility();
    updateStage3ReviewerPanel();
  }
}

function updateWhisperModelVisibility() {
  const stage2cb = $('.stage-checkbox[data-stage-id="stage2"]');
  const row = $('#whisper-model-row');
  if (!stage2cb || !row) return;
  const visible = stage2cb.checked && !stage2cb.disabled;
  row.hidden = !visible;
}

function updateTranscriptionSettingsVisibility() {
  const stage3cb = $('.stage-checkbox[data-stage-id="stage3"]');
  const settings = $('#transcription-settings');
  if (!stage3cb || !settings) return;
  const visible = stage3cb.checked && !stage3cb.disabled;
  settings.hidden = !visible;
}

// Show/hide the stage 3 reviewer panel and populate the reviewer checkbox list
async function updateStage3ReviewerPanel() {
  const stage3cb = $('.stage-checkbox[data-stage-id="stage3"]');
  const panel    = $('#stage3-reviewer-panel');
  if (!panel) return;

  const show = stage3cb && stage3cb.checked && !stage3cb.disabled;
  panel.classList.toggle('visible', show);
  if (!show) return;

  // Populate reviewer checkboxes for the currently selected participant
  const pid = $('#run-participant').value;
  if (!pid) return;

  const listDiv  = $('#stage3-reviewer-list');
  const emptyMsg = $('#stage3-reviewer-list-empty');

  // Remove any previously rendered rater checkboxes
  listDiv.querySelectorAll('.s3-rater-label').forEach((el) => el.remove());

  try {
    const files = await window.iss.listReviewFiles(pid);
    // Keep only the latest file per rater
    const byRater = {};
    for (const f of files) {
      if (!byRater[f.initials] || f.timestamp > byRater[f.initials].timestamp)
        byRater[f.initials] = f;
    }
    const raters = Object.keys(byRater);

    if (raters.length === 0) {
      emptyMsg.textContent = 'No reviewer files found for this participant.';
      emptyMsg.hidden = false;
      // Force "none" mode — no reviewers available
      const noneRadio = $('#s3-mode-none');
      if (noneRadio) { noneRadio.checked = true; listDiv.classList.remove('visible'); }
      return;
    }

    emptyMsg.hidden = true;
    for (const initials of raters) {
      const lbl = document.createElement('label');
      lbl.className = 's3-rater-label';
      lbl.innerHTML = `
        <input type="checkbox" class="s3-rater-cb" data-initials="${escapeHtml(initials)}" checked />
        <span>${escapeHtml(initials)}</span>
        <span class="s3-rater-timestamp">${byRater[initials].timestamp.slice(0, 8)}</span>`;
      listDiv.appendChild(lbl);
    }
  } catch (err) {
    emptyMsg.textContent = 'Could not load reviewer files.';
    emptyMsg.hidden = false;
  }
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
    updateTranscriptionSettingsVisibility();
    updateStage3ReviewerPanel();

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
  $('#run-participant').addEventListener('change', () => {
    refreshRunSessions();
    updateStage3ReviewerPanel();
  });
  $('#run-session').addEventListener('change', () => {
    $$('.stage-check-badge').forEach((b) => { b.textContent = ''; b.className = 'stage-check-badge'; });
    $$('.stage-checkbox').forEach((cb) => { cb.disabled = false; cb.checked = true; });
    const wm = $('#whisper-model');
    if (wm) wm.value = 'small';
    updateWhisperModelVisibility();
    updateTranscriptionSettingsVisibility();
    updateWhisperRamWarn();
    updateStage3ReviewerPanel();
    $('#detect-hint').textContent = 'Select a session, then click Detect to auto-select runnable stages.';
  });

  // Stage 3 reviewer list: show/hide when "Select specific reviewers" is chosen
  document.querySelectorAll('input[name="stage3-mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      const listDiv = $('#stage3-reviewer-list');
      if (listDiv) listDiv.classList.toggle('visible', r.value === 'select' && r.checked);
    });
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

  // Collect stage 3 reviewer selection
  let stage3Mode      = 'all';
  let stage3Reviewers = null; // null = all

  if (selectedStages.includes('stage3')) {
    const modeRadio = document.querySelector('input[name="stage3-mode"]:checked');
    stage3Mode = modeRadio ? modeRadio.value : 'all';

    if (stage3Mode === 'select') {
      stage3Reviewers = Array.from(document.querySelectorAll('.s3-rater-cb:checked'))
        .map((cb) => cb.dataset.initials);
      if (stage3Reviewers.length === 0) {
        $('#run-status').textContent = 'Select at least one reviewer, or choose \u201cNo reviewers\u201d or \u201cAll reviewers\u201d.';
        return;
      }
    } else if (stage3Mode === 'none') {
      stage3Reviewers = []; // empty array signals no-reviewer mode to main process
    }
    // 'all' => stage3Reviewers stays null (main process uses all files)
  }

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
    const r = await window.iss.runPipeline({ sessionId, stages: selectedStages, whisperModel, stage3Mode, stage3Reviewers });
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
 * If state.reviewInitials is already set, resolves immediately.
 * Live input filtering: strips non-alphanumeric characters as the user
 * types and shows an inline hint/warning so they know what is allowed.
 */
function askInitials() {
  if (state.reviewInitials) return Promise.resolve(state.reviewInitials);
  return new Promise((resolve) => {
    const overlay = $('#initials-overlay');
    const input   = $('#initials-input');
    const confirm = $('#initials-confirm');
    const errEl   = $('#initials-error');
    const hintEl  = $('#initials-hint');

    input.value        = '';
    errEl.textContent  = '';
    hintEl.textContent = 'Letters (A\u2013Z) and numbers (0\u20139) only';
    hintEl.style.color = '';
    overlay.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);

    // Remove any previous listener before adding a fresh one
    const newInput = input.cloneNode(true);
    input.parentNode.replaceChild(newInput, input);
    const inp = $('#initials-input');

    inp.addEventListener('input', () => {
      const raw     = inp.value;
      const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (raw !== cleaned) {
        inp.value          = cleaned;
        hintEl.textContent = 'Only letters and numbers are allowed \u2014 other characters are removed automatically.';
        hintEl.style.color = 'var(--color-warning, #964219)';
      } else {
        hintEl.textContent = 'Letters (A\u2013Z) and numbers (0\u20139) only';
        hintEl.style.color = '';
      }
      errEl.textContent = '';
    });

    function submit() {
      const val = inp.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (val.length < 2) {
        errEl.textContent = 'Please enter at least 2 characters.';
        return;
      }
      state.reviewInitials = val;
      overlay.classList.add('hidden');
      resolve(val);
    }

    confirm.onclick = submit;
    inp.onkeydown   = (e) => { if (e.key === 'Enter') submit(); };
  });
}

// ====================================================================
// REVIEW
// ====================================================================
function bindReview() {
  // Initials badge — click to change initials
  $('#rev-initials-badge').addEventListener('click', () => {
    state.reviewInitials = null;
    askInitials().then(updateInitialsBadge);
  });

  // Load buttons
  $('#rev-load-raw').addEventListener('click', async () => {
    const pid = $('#rev-participant').value;
    if (!pid) { $('#rev-status').textContent = 'Select a participant first.'; return; }
    const initials = await askInitials();
    updateInitialsBadge(initials);
    await loadReviewData(pid, 'raw');
  });

  $('#rev-load-own').addEventListener('click', async () => {
    const pid = $('#rev-participant').value;
    if (!pid) { $('#rev-status').textContent = 'Select a participant first.'; return; }
    const initials = await askInitials();
    updateInitialsBadge(initials);
    await loadReviewData(pid, 'own');
  });

  // Save button
  $('#rev-save').addEventListener('click', saveReview);

  // Participant change — refresh rater list
  $('#rev-participant').addEventListener('change', async () => {
    const pid = $('#rev-participant').value;
    if (pid) await refreshRaterStatus(pid);
  });

  // Transcription slider
  const slider = $('#conf-auto');
  const sliderVal = $('#conf-auto-value');
  if (slider && sliderVal) {
    slider.addEventListener('input', () => { sliderVal.textContent = parseFloat(slider.value).toFixed(2); });
    slider.addEventListener('change', async () => {
      const v = parseFloat(slider.value);
      try {
        await window.iss.writeConfidence({ strict: 0.9, review: 0.8, auto: v });
        const saved = $('#conf-saved');
        if (saved) { saved.textContent = 'Saved'; setTimeout(() => { saved.textContent = ''; }, 1500); }
      } catch (err) {
        console.error('writeConfidence failed:', err);
      }
    });
    // Load existing value
    window.iss.readConfig().then((cfg) => {
      if (cfg.ok && cfg.thresholds) {
        slider.value = cfg.thresholds.auto ?? 0;
        sliderVal.textContent = parseFloat(slider.value).toFixed(2);
      }
    }).catch(() => {});
  }
}

function updateInitialsBadge(initials) {
  const badge = $('#rev-initials-badge');
  badge.textContent = initials ? `\u2713 ${initials}` : '\u2014';
}

async function refreshRaterStatus(pid) {
  const list = $('#rev-rater-list');
  if (!list) return;
  try {
    const files = await window.iss.listReviewFiles(pid);
    if (!files || files.length === 0) {
      list.innerHTML = '<li class="no-raters">No review files yet for this participant.</li>';
      return;
    }
    // Latest file per rater
    const byRater = {};
    for (const f of files) {
      if (!byRater[f.initials] || f.timestamp > byRater[f.initials].timestamp) byRater[f.initials] = f;
    }
    list.innerHTML = Object.values(byRater).map((f) =>
      `<li class="rev-rater-chip">${escapeHtml(f.initials)} <span class="chip-time">${f.timestamp.slice(0,8)}</span></li>`
    ).join('');
  } catch (err) {
    list.innerHTML = '<li class="no-raters">Could not load reviewer list.</li>';
  }
}

async function loadReviewData(pid, mode) {
  $('#rev-status').textContent = 'Loading\u2026';
  $('#rev-save').disabled = true;
  try {
    let data;
    if (mode === 'own') {
      data = await window.iss.loadOwnReview(pid, state.reviewInitials);
      if (data.resumedFrom) {
        $('#rev-status').textContent = `Resumed from ${data.resumedFrom}`;
      } else {
        $('#rev-status').textContent = 'No previous review found \u2014 loaded fresh transcription.';
      }
    } else {
      data = await window.iss.loadRawReview(pid);
      $('#rev-status').textContent = 'Loaded. Edit cells, then save.';
    }

    if (data.error) {
      $('#rev-status').textContent = `Error: ${data.error}`;
      return;
    }

    state.reviewRows      = data.rows;
    state.reviewFilePath  = data.filePath;
    state.reviewPriorVotes = data.priorVotes || {};
    state.reviewRaters    = data.raters || [];
    state.reviewDirty     = false;
    state.revCols         = null;

    renderReviewTable(data.rows);
    await refreshRaterStatus(pid);
    await loadReviewAudio(pid);
    $('#rev-save').disabled = false;
    $('#rev-filename').textContent = data.filePath ? data.filePath.split('/').pop().split('\\').pop() : 'Transcription';
  } catch (err) {
    $('#rev-status').textContent = `Failed to load: ${err.message}`;
  }
}

function renderReviewTable(rows) {
  const wrap  = $('#rev-table-wrap');
  const empty = $('#rev-empty');
  const table = $('#rev-table');

  if (!rows || rows.length < 2) {
    wrap.hidden  = true;
    empty.hidden = false;
    empty.textContent = 'No rows found in file.';
    return;
  }

  wrap.hidden  = false;
  empty.hidden = true;

  const header = rows[0];
  // Build column index cache
  state.revCols = {};
  header.forEach((h, i) => { state.revCols[h] = i; });

  const visibleIndices = REV_VISIBLE_COLS.map((col) => (col === 'prior_votes' ? -1 : header.indexOf(col)));

  // Header
  const thead = table.querySelector('thead');
  thead.innerHTML = '<tr>' + REV_VISIBLE_COLS.map((c) => `<th>${escapeHtml(c.replace('_',' '))}</th>`).join('') + '</tr>';

  // Body
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';

  for (let ri = 1; ri < rows.length; ri++) {
    const row = rows[ri];
    const tr  = document.createElement('tr');
    tr.dataset.rowIdx = ri;

    // Build a unique key for prior-votes lookup
    const afIdx = header.indexOf('audio_file');
    const stIdx = header.indexOf('start');
    const rowKey = (afIdx >= 0 && stIdx >= 0) ? `${row[afIdx]}::${row[stIdx]}` : null;
    const votes  = rowKey ? (state.reviewPriorVotes[rowKey] || null) : null;

    REV_VISIBLE_COLS.forEach((col, ci) => {
      const td = document.createElement('td');
      const realIdx = visibleIndices[ci];

      if (col === 'prior_votes') {
        if (votes && votes.total > 0) {
          td.innerHTML = `<span title="${votes.raters.join(', ')}">${votes.dropCount}/${votes.total} drop</span>`;
          td.style.color = 'var(--color-text-muted)';
          td.style.fontSize = '0.8em';
        }
      } else if (col === 'drop' || col === 'comment') {
        const cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.checked = realIdx >= 0 && (row[realIdx] === 'TRUE' || row[realIdx] === 'true' || row[realIdx] === '1');
        cb.addEventListener('change', () => {
          if (realIdx >= 0) rows[ri][realIdx] = cb.checked ? 'TRUE' : 'FALSE';
          state.reviewDirty = true;
        });
        td.appendChild(cb);
      } else if (col === 'response') {
        td.contentEditable = 'true';
        td.textContent = realIdx >= 0 ? (row[realIdx] || '') : '';
        td.classList.add('editable');
        td.addEventListener('input', () => {
          if (realIdx >= 0) rows[ri][realIdx] = td.textContent;
          state.reviewDirty = true;
        });
        // Play audio on row click
        td.addEventListener('focus', () => playReviewRowAudio(row, header));
      } else {
        td.textContent = realIdx >= 0 ? (row[realIdx] || '') : '';
        // Play audio on row click for non-editable cells too
        td.addEventListener('click', () => playReviewRowAudio(row, header));
      }

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  }
}

async function saveReview() {
  if (!state.reviewRows) { $('#rev-status').textContent = 'Nothing to save.'; return; }
  const pid = $('#rev-participant').value;
  const initials = state.reviewInitials;
  if (!initials) { $('#rev-status').textContent = 'No initials set.'; return; }
  $('#rev-save').disabled = true;
  try {
    const result = await window.iss.saveReview({
      participantId: pid,
      initials,
      rows: state.reviewRows,
      filePath: null, // always save as new timestamped file
    });
    state.reviewDirty = false;
    $('#rev-status').textContent = `Saved \u2192 ${result.filename}`;
    await refreshRaterStatus(pid);
  } catch (err) {
    $('#rev-status').textContent = `Save failed: ${err.message}`;
  } finally {
    $('#rev-save').disabled = false;
  }
}

// ====================================================================
// REVIEW — audio playlist
// ====================================================================
async function loadReviewAudio(pid) {
  const wrap = $('#rev-audio-wrap');
  try {
    const files = await window.iss.getAudioFiles(pid);
    state.reviewPlaylist    = files || [];
    state.reviewPlaylistIdx = -1;
    if (state.reviewPlaylist.length === 0) { wrap.hidden = true; return; }
    wrap.hidden = false;
    renderPlaylist();
  } catch {
    wrap.hidden = true;
    state.reviewPlaylist = [];
  }
}

function renderPlaylist() {
  const container = $('#rev-playlist');
  container.innerHTML = '';
  state.reviewPlaylist.forEach((f, i) => {
    const btn = document.createElement('button');
    btn.className   = 'rev-clip-btn';
    btn.textContent = f.stem;
    btn.dataset.idx = i;
    btn.addEventListener('click', () => playClip(i));
    container.appendChild(btn);
  });
}

function playClip(idx) {
  const f = state.reviewPlaylist[idx];
  if (!f) return;
  state.reviewPlaylistIdx = idx;
  const audio = $('#rev-audio');
  const label = $('#rev-clip-label');
  audio.src = f.fileUrl;
  label.textContent = f.stem;
  audio.play().catch(() => {});
  // Highlight active button
  $$('.rev-clip-btn').forEach((b, i) => b.classList.toggle('active', i === idx));
}

function playReviewRowAudio(row, header) {
  const afIdx = header.indexOf('audio_file');
  if (afIdx < 0) return;
  const audioFile = row[afIdx];
  if (!audioFile) return;
  const stem = audioFile.replace(/\.[^.]+$/, '').split('/').pop().split('\\').pop();
  const idx  = state.reviewPlaylist.findIndex((f) => f.stem === stem || f.stem.includes(stem) || stem.includes(f.stem));
  if (idx >= 0) playClip(idx);
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
    if (p) window.iss.openPath(path.join(p.dir, 'output', 'features'));
  });
  $('#btn-open-file').addEventListener('click', () => {
    const pid = $('#res-participant').value;
    if (!pid || !state.selectedResParticipant) return;
    window.iss.openPath(state.selectedResParticipant);
  });
  $('#res-files').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-path]');
    if (!li) return;
    $$('#res-files li').forEach((l) => l.classList.remove('active'));
    li.classList.add('active');
    state.selectedResParticipant = li.dataset.path;
    await loadResultFile(li.dataset.path, li.dataset.ext);
    const openBtn = $('#btn-open-file');
    if (openBtn) openBtn.hidden = false;
  });
}

async function refreshResults() {
  const pid = $('#res-participant').value;
  if (!pid) return;
  const files = await window.iss.listResults(pid);
  const ul = $('#res-files');
  ul.innerHTML = '';
  if (!files.length) {
    ul.innerHTML = '<li class="muted">No result files yet. Run the full pipeline first.</li>';
    return;
  }
  for (const f of files) {
    const li = document.createElement('li');
    li.dataset.path = f.path;
    li.dataset.ext  = f.ext;
    li.innerHTML = `<span class="fname">${escapeHtml(f.name)}</span><span class="fmeta">${(f.size/1024).toFixed(1)} KB</span>`;
    ul.appendChild(li);
  }
}

async function loadResultFile(filePath, ext) {
  const tableWrap  = $('#res-table-wrap');
  const nonTabular = $('#res-nontabular');
  const truncated  = $('#res-truncated');
  tableWrap.hidden  = true;
  nonTabular.hidden = true;
  truncated.textContent = '';
  $('#res-filemeta').textContent = filePath.split('/').pop().split('\\').pop();

  if (ext === '.csv' || ext === '.tsv') {
    try {
      const { rows, truncated: trunc } = await window.iss.readCsv(filePath);
      if (!rows.length) { nonTabular.hidden = false; $('#res-nontabular-msg').textContent = 'Empty file.'; return; }
      const thead = $('#res-table thead');
      const tbody = $('#res-table tbody');
      thead.innerHTML = '<tr>' + rows[0].map((h) => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>';
      tbody.innerHTML = '';
      for (let i = 1; i < rows.length; i++) {
        const tr = document.createElement('tr');
        tr.innerHTML = rows[i].map((c) => `<td>${escapeHtml(c)}</td>`).join('');
        tbody.appendChild(tr);
      }
      tableWrap.hidden = false;
      if (trunc) truncated.textContent = 'File truncated at 2 MB.';
    } catch (err) {
      nonTabular.hidden = false;
      $('#res-nontabular-msg').textContent = 'Could not read file: ' + err.message;
    }
  } else {
    nonTabular.hidden = false;
    $('#res-nontabular-msg').textContent = `${ext.toUpperCase()} files cannot be previewed. Open in folder to view.`;
  }
}

// ====================================================================
// UTILS
// ====================================================================
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
