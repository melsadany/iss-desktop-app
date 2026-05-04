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
    try {
      localStorage.setItem('iss-theme', theme);
    } catch (e) {}

    if (theme === 'dark') {
      icon.textContent  = '☾';
      label.textContent = 'Dark';
    } else {
      icon.textContent  = '☀';
      label.textContent = 'Light';
    }
  }

  const initial = document.documentElement.getAttribute('data-theme') || 'light';
  apply(initial);

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    apply(next);
  });
})();

// ---------- state ----------
let state = {
  paths: null,
  participants: [],
  selectedRecParticipant: null,
  selectedRunParticipant: null,
  selectedRunSession: null,
  selectedResParticipant: null,
  // recorder
  audioStream: null,
  audioContext: null,
  mediaRecorder: null,
  audioChunks: [],
  taskVideoUrl: 'assets/task_video.mp4'
};

// ---------- bootstrap ----------
(async function init() {
  state.paths = await window.iss.paths();
  await refreshParticipants();
  await refreshSetup();
  bindSetup();
  bindParticipants();
  bindRecord();
  bindRun();
  bindResults();
})();

async function onViewChange(name) {
  if (name === 'setup')        refreshSetup();
  if (name === 'participants') refreshParticipantsTable();
  if (name === 'record')       fillParticipantSelect('#rec-participant');
  if (name === 'run')          { fillParticipantSelect('#run-participant'); refreshRunSessions(); }
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
      log.textContent = `Downloading… ${(msg.received/1e6).toFixed(1)} / ${(msg.total/1e6).toFixed(1)} MB (${(msg.pct*100).toFixed(1)}%)`;
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
    const id    = $('#np-id').value.trim();
    const label = $('#np-label').value.trim();
    const notes = $('#np-notes').value.trim();
    const msg   = $('#np-msg');
    msg.textContent = '';
    try {
      await window.iss.createParticipant({ id, label, notes });
      $('#np-id').value = '';
      $('#np-label').value = '';
      $('#np-notes').value = '';
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
    sel.innerHTML = '<option value="">No participants yet — create one first.</option>';
    return;
  }
  for (const p of state.participants) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.id}${p.label && p.label !== p.id ? ' — ' + p.label : ''}`;
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

  v.addEventListener('ended', () => {
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
    $('#rec-status').textContent = 'Processing audio…';
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
    const session = await window.iss.saveRecording({
      participantId: pid,
      buffer,
      extension
    });
    $('#rec-status').textContent = `Saved ${session.audioFilename}. Switch to “Run pipeline” to analyze.`;
    $('#rec-stop').disabled  = true;
    $('#rec-start').disabled = false;
  };

  // Fullscreen the video
  const v = $('#rec-video');
  try {
    if (v.requestFullscreen)        await v.requestFullscreen();
    else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
  } catch {}
  v.controls = false;

  state.mediaRecorder.start();
  v.currentTime = 0;
  v.play();

  $('#rec-status').textContent = 'Task running · recording audio…';
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

  v.setUint32(0, 0x52494646, false);     // 'RIFF'
  v.setUint32(4, 36 + dataLen, true);
  v.setUint32(8, 0x57415645, false);     // 'WAVE'
  v.setUint32(12, 0x666d7420, false);    // 'fmt '
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  v.setUint32(36, 0x64617461, false);    // 'data'
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
function bindRun() {
  $('#run-participant').addEventListener('change', refreshRunSessions);
  $('#run-start').addEventListener('click', runPipeline);
  $('#run-cancel').addEventListener('click', () => window.iss.cancelPipeline());
  window.iss.onPipelineLog(({ line }) => {
    const log = $('#run-log');
    log.textContent += line;
    log.scrollTop = log.scrollHeight;
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
    opt.textContent = `${s.audioFilename} · ${new Date(s.recordedAt).toLocaleString()} · ${s.pipelineStatus}`;
    sel.appendChild(opt);
  }
}

async function runPipeline() {
  const sessionId = $('#run-session').value;
  if (!sessionId) { $('#run-status').textContent = 'Pick a session first.'; return; }
  $('#run-log').textContent = '';
  $('#run-status').textContent = 'Starting…';
  $('#run-start').disabled = true;
  $('#run-cancel').disabled = false;
  try {
    const r = await window.iss.runPipeline({ sessionId });
    $('#run-status').textContent = r.ok
      ? 'Pipeline finished successfully.'
      : `Pipeline exited with code ${r.exitCode ?? '?'}.`;
  } catch (err) {
    $('#run-status').textContent = 'Error: ' + err.message;
  } finally {
    $('#run-start').disabled = false;
    $('#run-cancel').disabled = true;
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
  const ul = $('#res-files');
  ul.innerHTML = '';
  $('#res-table thead').innerHTML = '';
  $('#res-table tbody').innerHTML = '';
  $('#res-truncated').textContent = '';
  if (!pid) return;
  const files = await window.iss.listResults(pid);
  if (files.length === 0) {
    ul.innerHTML = '<li class="muted">No CSVs found yet — run the pipeline first.</li>';
    return;
  }
  files.forEach((f) => {
    const li = document.createElement('li');
    const ext = f.ext.replace('.', '');
    li.innerHTML = `
      <span>
        <span class="file-ext-badge ${ext}">${ext}</span>
        ${esc(f.name)}
      </span>
      <span class="file-meta">${(f.size / 1024).toFixed(1)} KB</span>
    `;
    li.addEventListener('click', () => {
      $$('#res-files li').forEach((x) => x.classList.remove('selected'));
      li.classList.add('selected');
      loadCsv(f);
    });
    ul.appendChild(li);
  }
}

async function openResultFile(f) {
  $('#res-filename').textContent = f.name;
  $('#btn-open-file').hidden = false;
  $('#btn-open-file').onclick = () => window.iss.openPath(f.path);
  $('#res-filemeta').textContent =
    `${(f.size / 1024).toFixed(1)} KB  •  ${new Date(f.mtime).toLocaleString()}`;

  const tabular = ['.csv', '.tsv'];

  if (tabular.includes(f.ext)) {
    $('#res-table-wrap').hidden = false;
    $('#res-nontabular').hidden = true;

    try {
      const { rows, truncated } = await window.iss.readCsv(f.path);
      renderTable(rows);
      if (truncated) {
        $('#res-filemeta').textContent += '  •  (first 2 MB shown)';
      }
    } catch (err) {
      $('#res-filemeta').textContent += `  •  Error reading file: ${err.message}`;
    }
  } else {
    $('#res-table-wrap').hidden = true;
    $('#res-nontabular').hidden = false;

    const messages = {
      '.rds':  `RDS file — open in R with <code>readRDS("${f.name}")</code>`,
      '.json': 'JSON file — click "Open in folder" to inspect it.',
      '.txt':  'Text file — click "Open in folder" to view it.',
    };

    $('#res-nontabular-msg').innerHTML =
      messages[f.ext] || 'Binary or unsupported format — click "Open in folder" to view.';
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
// ---------- helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;" }[c]));
}
