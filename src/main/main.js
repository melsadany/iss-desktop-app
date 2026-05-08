/* Iowa Speech Sample — Electron main process */

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn, exec } = require('child_process');
const { pipeline } = require('stream/promises');
const https = require('https');
// NOTE: no external deps — js-yaml is NOT in package.json, so we use built-in helpers below.

// ---------- paths ----------
const USER_DATA      = () => app.getPath('userData');
const DB_PATH        = () => path.join(USER_DATA(), 'iss_db.json');
const PARTICIPANTS_D = () => path.join(USER_DATA(), 'participants');
const REF_DATA_DIR   = () => path.join(USER_DATA(), 'reference_data');
const CONFIG_DIR     = () => path.join(USER_DATA(), 'config');
const CONFIG_FILE    = () => path.join(CONFIG_DIR(), 'task_template.yaml');

const DOCKER_IMAGE = 'melsadany/iowa_speech_sample:latest';
const ZENODO_URL   = 'https://zenodo.org/records/18675411/files/reference_data.zip?download=1';

// ---------- minimal YAML helpers (no external dep) ----------
// Reads the three confidence_threshold values from the YAML file using regex.
// Returns { strict, review, auto } with numeric defaults if not found.
function readYamlThresholds(raw) {
  const get = (key, def) => {
    const m = raw.match(new RegExp(`\\b${key}\\s*:\\s*([0-9.]+)`));
    return m ? parseFloat(m[1]) : def;
  };
  return {
    strict: get('strict', 0.9),
    review: get('review', 0.8),
    auto:   get('auto',   0.0),
  };
}

// Writes the three values back into the YAML string, preserving all other content.
// If a key already exists it is updated in-place; if it doesn't exist the whole
// confidence_threshold block is appended under transcription:.
function writeYamlThresholds(raw, { strict, review, auto }) {
  const tryReplace = (text, key, val) => {
    const re = new RegExp(`(\\b${key}\\s*:\\s*)[0-9.]+`);
    return re.test(text) ? text.replace(re, `$1${val}`) : null;
  };
  let out = raw;
  for (const [k, v] of [['strict', strict], ['review', review], ['auto', auto]]) {
    const replaced = tryReplace(out, k, v);
    if (replaced !== null) { out = replaced; continue; }
    // Key missing — append under transcription: block or at end
    if (/^transcription\s*:/m.test(out)) {
      out = out.replace(
        /^(transcription\s*:.*)/m,
        `$1\n  confidence_threshold:\n    strict: ${strict}\n    review: ${review}\n    auto: ${auto}`
      );
    } else {
      out += `\ntranscription:\n  confidence_threshold:\n    strict: ${strict}\n    review: ${review}\n    auto: ${auto}\n`;
    }
    break; // all three written at once in the block above
  }
  return out;
}

// ---------- pipeline stages ----------
const PIPELINE_STAGES = [
  { id: 'stage1', label: 'Audio preprocessing',    stageArg: '1', outputCheck: 'cropped_audio'  },
  { id: 'stage2', label: 'Transcription',            stageArg: '2', outputCheck: 'transcriptions' },
  { id: 'stage3', label: 'Transcription cleanup',    stageArg: '3', outputCheck: 'review_files'   },
  { id: 'stage4', label: 'Feature extraction',       stageArg: '4', outputCheck: 'features'       },
];

async function stageOutputExists(outputDir, check, participantId) {
  const subDir = path.join(outputDir, check, participantId);
  try {
    const entries = await fsp.readdir(subDir);
    if (entries.length > 0) return true;
  } catch {}
  const flatDir = path.join(outputDir, check);
  try {
    const entries = await fsp.readdir(flatDir);
    return entries.some((f) => f.startsWith(participantId));
  } catch {
    return false;
  }
}

// ---------- DB ----------
async function loadDB() {
  try {
    return JSON.parse(await fsp.readFile(DB_PATH(), 'utf8'));
  } catch {
    return { participants: [], sessions: [] };
  }
}
async function saveDB(db) {
  await fsp.mkdir(USER_DATA(), { recursive: true });
  await fsp.writeFile(DB_PATH(), JSON.stringify(db, null, 2), 'utf8');
}

// ---------- shell helpers ----------
function execWithTimeout(cmd, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = exec(cmd, { timeout: timeoutMs }, (err, stdout) => {
      if (err) resolve({ ok: false, stdout: '' });
      else     resolve({ ok: true,  stdout: (stdout || '').trim() });
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, stdout: '' });
    }, timeoutMs + 500);
    child.on('close', () => clearTimeout(timer));
  });
}

function dockerInstalled() {
  return new Promise((resolve) => exec('docker --version', (err) => resolve(!err)));
}
async function dockerRunning() {
  const { ok, stdout } = await execWithTimeout('docker info --format "{{.ServerVersion}}"', 5000);
  return ok && !!stdout;
}
async function imageAvailable(image) {
  const { ok } = await execWithTimeout(`docker image inspect ${image}`, 5000);
  return ok;
}

// ---------- review helpers ----------
async function listReviewerFiles(reviewDir, participantId) {
  let entries;
  try { entries = await fsp.readdir(reviewDir); } catch { return []; }
  const pattern = new RegExp(`^${participantId}_review_([A-Za-z0-9]+)_(\\d{8}T\\d{4})\\.tsv$`);
  return entries
    .map((f) => { const m = f.match(pattern); return m ? { filePath: path.join(reviewDir, f), initials: m[1], timestamp: m[2], filename: f } : null; })
    .filter(Boolean)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

async function parseTsv(filePath) {
  const lines = (await fsp.readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { header: [], rows: [] };
  const [h, ...rest] = lines;
  return { header: h.split('\t'), rows: rest.map((l) => l.split('\t')) };
}

async function buildPriorVotes(reviewerFiles) {
  const summary = new Map();
  for (const rf of reviewerFiles) {
    let parsed;
    try { parsed = await parseTsv(rf.filePath); } catch { continue; }
    const { header, rows } = parsed;
    const aC = header.indexOf('audio_file'), sC = header.indexOf('start');
    const dC = header.indexOf('drop'),       cC = header.indexOf('comment');
    if (aC === -1 || sC === -1) continue;
    for (const row of rows) {
      const key = `${row[aC]}::${row[sC]}`;
      if (!summary.has(key)) summary.set(key, { dropCount: 0, commentCount: 0, total: 0, raters: [] });
      const v = summary.get(key);
      v.total++; v.raters.push(rf.initials);
      if (dC !== -1 && row[dC] === 'TRUE') v.dropCount++;
      if (cC !== -1 && row[cC] === 'TRUE') v.commentCount++;
    }
  }
  return summary;
}

async function loadRawReviewData(participantId) {
  const reviewDir = path.join(PARTICIPANTS_D(), participantId, 'output', 'review_files');
  let tsvPath = null;
  const fixed = path.join(reviewDir, `${participantId}_cleaned_transcription.tsv`);
  if (fs.existsSync(fixed)) { tsvPath = fixed; }
  if (!tsvPath) {
    try {
      const match = (await fsp.readdir(reviewDir)).find(
        (f) => f.startsWith(participantId) && f.endsWith('.tsv') && !f.includes('_review_')
      );
      if (match) tsvPath = path.join(reviewDir, match);
    } catch {}
  }
  if (!tsvPath) return { rows: null, filePath: null, priorVotes: null, raters: [], error: 'No cleaned transcription file found. Run stage 3 first.' };

  const rows = (await fsp.readFile(tsvPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
  const reviewerFiles = await listReviewerFiles(reviewDir, participantId);
  const votesMap = await buildPriorVotes(reviewerFiles);
  const priorVotes = {};
  for (const [k, v] of votesMap.entries()) priorVotes[k] = v;
  return { rows, filePath: tsvPath, priorVotes, raters: [...new Set(reviewerFiles.map((r) => r.initials))], error: null };
}

// ---------- window ----------
let mainWin;
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1180, height: 820, minWidth: 980, minHeight: 680,
    backgroundColor: '#1a242f', title: 'Iowa Speech Sample',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Open data folder', click: () => shell.openPath(USER_DATA()) }, { type: 'separator' }, { role: process.platform === 'darwin' ? 'close' : 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { label: 'Help', submenu: [{ label: 'GitHub repository', click: () => shell.openExternal('https://github.com/melsadany/iss-pipeline') }, { label: 'Reference data on Zenodo', click: () => shell.openExternal('https://zenodo.org/records/18675411') }] },
  ]));

  mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await fsp.mkdir(PARTICIPANTS_D(), { recursive: true });
  await fsp.mkdir(REF_DATA_DIR(),   { recursive: true });
  await fsp.mkdir(CONFIG_DIR(),     { recursive: true });

  const bundledConfig = path.join(process.resourcesPath || path.join(__dirname, '..', '..', 'resources'), 'task_template.yaml');
  const userConfig = CONFIG_FILE();
  if (!fs.existsSync(userConfig) && fs.existsSync(bundledConfig)) await fsp.copyFile(bundledConfig, userConfig);

  createWindow();
  exec(`docker pull ${DOCKER_IMAGE}`, () => mainWin?.webContents.send('docker:pull-log', '[startup] Image freshness check complete.\n'));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- IPC: app/system ----------
ipcMain.handle('app:paths', () => ({ userData: USER_DATA(), participants: PARTICIPANTS_D(), referenceData: REF_DATA_DIR(), config: CONFIG_DIR(), configFile: CONFIG_FILE() }));
ipcMain.handle('app:open-path', (_e, p) => shell.openPath(p));

ipcMain.handle('system:check', async () => {
  const installed = await dockerInstalled();
  const running   = installed ? await dockerRunning()              : false;
  const hasImage  = running   ? await imageAvailable(DOCKER_IMAGE) : false;
  const refExists = fs.existsSync(REF_DATA_DIR()) && (await fsp.readdir(REF_DATA_DIR()).catch(() => [])).length > 0;
  return { platform: process.platform, arch: process.arch, dockerInstalled: installed, dockerRunning: running, imagePresent: hasImage, imageName: DOCKER_IMAGE, referenceDataPresent: refExists, referenceDataPath: REF_DATA_DIR() };
});

// ---------- IPC: config ----------
ipcMain.handle('config:read', async () => {
  try {
    const raw = await fsp.readFile(CONFIG_FILE(), 'utf8');
    return { ok: true, thresholds: readYamlThresholds(raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:write-confidence', async (_e, { strict, review, auto }) => {
  try {
    const raw = await fsp.readFile(CONFIG_FILE(), 'utf8');
    await fsp.writeFile(CONFIG_FILE(), writeYamlThresholds(raw, { strict: parseFloat(strict), review: parseFloat(review), auto: parseFloat(auto) }), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC: participants ----------
ipcMain.handle('participants:list', async () => (await loadDB()).participants);

ipcMain.handle('participants:create', async (_e, { id, label, notes, age, sex, educationYears, handedness }) => {
  if (!id || !/^[A-Za-z0-9_\-]+$/.test(id)) throw new Error('Participant ID must be alphanumeric (letters, digits, _ or -).');
  const db = await loadDB();
  if (db.participants.find((p) => p.id === id)) throw new Error(`Participant "${id}" already exists.`);
  const dir = path.join(PARTICIPANTS_D(), id);
  await fsp.mkdir(path.join(dir, 'input'),  { recursive: true });
  await fsp.mkdir(path.join(dir, 'output'), { recursive: true });
  const p = { id, label: label || id, notes: notes || '', age: age || null, sex: sex || null, educationYears: educationYears || null, handedness: handedness || null, createdAt: new Date().toISOString(), dir };
  db.participants.push(p);
  await saveDB(db);
  return p;
});

ipcMain.handle('participants:delete', async (_e, id) => {
  const db = await loadDB();
  db.participants = db.participants.filter((p) => p.id !== id);
  db.sessions     = db.sessions.filter((s) => s.participantId !== id);
  await saveDB(db);
  return true;
});

ipcMain.handle('sessions:list', async (_e, participantId) => {
  const db = await loadDB();
  const sessions = [...db.sessions];
  const AUDIO_EXTS = ['.wav', '.mp3', '.webm', '.ogg', '.flac', '.m4a'];
  const participantsDir = PARTICIPANTS_D();
  if (fs.existsSync(participantsDir)) {
    const pids = participantId ? [participantId] : await fsp.readdir(participantsDir).catch(() => []);
    for (const pid of pids) {
      const inputDir = path.join(participantsDir, pid, 'input');
      if (!fs.existsSync(inputDir)) continue;
      for (const file of (await fsp.readdir(inputDir).catch(() => [])).filter(f => AUDIO_EXTS.includes(path.extname(f).toLowerCase()))) {
        const audioPath = path.join(inputDir, file);
        if (!sessions.some(s => s.audioPath === audioPath)) {
          const stat = await fsp.stat(audioPath);
          sessions.push({ id: `imported_${pid}_${file}`, participantId: pid, audioPath, audioFilename: file, recordedAt: stat.mtime.toISOString(), pipelineStatus: 'pending', pipelineRunAt: null, outputDir: path.join(participantsDir, pid, 'output'), imported: true });
        }
      }
    }
  }
  return sessions.filter((s) => !participantId || s.participantId === participantId);
});

// ---------- IPC: recording ----------
ipcMain.handle('recording:save', async (_e, { participantId, buffer, extension }) => {
  if (!participantId) throw new Error('participantId is required');
  const dir = path.join(PARTICIPANTS_D(), participantId, 'input');
  await fsp.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${participantId}_${ts}.${extension || 'mp3'}`;
  const filepath = path.join(dir, filename);
  await fsp.writeFile(filepath, Buffer.from(buffer));
  const db = await loadDB();
  const session = { id: `${participantId}_${ts}`, participantId, audioPath: filepath, audioFilename: filename, recordedAt: new Date().toISOString(), pipelineStatus: 'pending', pipelineRunAt: null, outputDir: path.join(PARTICIPANTS_D(), participantId, 'output') };
  db.sessions.push(session);
  await saveDB(db);
  return session;
});

// ---------- IPC: reference data ----------
function streamProgress(res, total, onProgress) {
  let received = 0;
  res.on('data', (chunk) => { received += chunk.length; onProgress(total ? { received, total, pct: received / total } : { received, total: 0, pct: 0 }); });
}
function httpsGetFollow(url) {
  return new Promise((resolve, reject) => {
    const go = (u, depth = 0) => {
      if (depth > 5) return reject(new Error('Too many redirects'));
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return go(new URL(res.headers.location, u).toString(), depth + 1); }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        resolve(res);
      }).on('error', reject);
    };
    go(url);
  });
}

ipcMain.handle('reference:download', async (event, { url } = {}) => {
  const targetUrl = url || ZENODO_URL;
  const tmp = path.join(os.tmpdir(), `iss_reference_${Date.now()}.zip`);
  const send = (msg) => mainWin?.webContents.send('reference:progress', msg);
  send({ phase: 'connecting', message: `Connecting to ${targetUrl}` });
  const res = await httpsGetFollow(targetUrl);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  send({ phase: 'downloading', total });
  streamProgress(res, total, (p) => send({ phase: 'downloading', ...p }));
  await pipeline(res, fs.createWriteStream(tmp));
  send({ phase: 'extracting', message: `Extracting to ${REF_DATA_DIR()}` });
  await new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32'
      ? `powershell -Command "Expand-Archive -Force -Path '${tmp}' -DestinationPath '${REF_DATA_DIR()}'"`
      : `unzip -o "${tmp}" -d "${REF_DATA_DIR()}"`;
    exec(cmd, (err, _, stderr) => err ? reject(new Error(`Unzip failed: ${stderr || err.message}`)) : resolve());
  });
  await fsp.unlink(tmp).catch(() => {});
  send({ phase: 'done', message: 'Reference data ready.' });
  return { ok: true, path: REF_DATA_DIR() };
});

// ---------- IPC: docker ----------
ipcMain.handle('docker:pull', async () => {
  const send = (line) => mainWin?.webContents.send('docker:pull-log', line);
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['pull', DOCKER_IMAGE]);
    proc.stdout.on('data', (d) => send(d.toString()));
    proc.stderr.on('data', (d) => send(d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve({ ok: true }) : reject(new Error(`docker pull exited with code ${code}`)));
  });
});
ipcMain.handle('docker:force-pull', async () => {
  const send = (line) => mainWin?.webContents.send('docker:pull-log', line);
  return new Promise((resolve, reject) => {
    exec(`docker rmi ${DOCKER_IMAGE}`, () => {
      const proc = spawn('docker', ['pull', '--platform', 'linux/amd64', DOCKER_IMAGE]);
      proc.stdout.on('data', (d) => send(d.toString()));
      proc.stderr.on('data', (d) => send(d.toString()));
      proc.on('error', reject);
      proc.on('close', (code) => code === 0 ? resolve({ ok: true }) : reject(new Error(`docker pull exited with code ${code}`)));
    });
  });
});

// ---------- IPC: pipeline stages detection ----------
ipcMain.handle('pipeline:detect-stages', async (_e, { sessionId }) => {
  const db = await loadDB();
  let session = db.sessions.find((s) => s.id === sessionId);
  if (!session && sessionId.startsWith('imported_')) {
    const AUDIO_EXTS = ['.wav', '.mp3', '.webm', '.ogg', '.flac', '.m4a'];
    outer: for (const pid of await fsp.readdir(PARTICIPANTS_D()).catch(() => [])) {
      const inputDir = path.join(PARTICIPANTS_D(), pid, 'input');
      if (!fs.existsSync(inputDir)) continue;
      for (const file of await fsp.readdir(inputDir).catch(() => [])) {
        if (!AUDIO_EXTS.includes(path.extname(file).toLowerCase())) continue;
        if (`imported_${pid}_${file}` === sessionId) { session = { id: sessionId, participantId: pid, outputDir: path.join(PARTICIPANTS_D(), pid, 'output') }; break outer; }
      }
    }
  }
  if (!session) throw new Error('Session not found.');
  const outputDir = path.join(PARTICIPANTS_D(), session.participantId, 'output');
  const results = [];
  for (let i = 0; i < PIPELINE_STAGES.length; i++) {
    const s = PIPELINE_STAGES[i];
    results.push({ id: s.id, label: s.label, outputExists: await stageOutputExists(outputDir, s.outputCheck, session.participantId), canRun: i === 0 ? true : await stageOutputExists(outputDir, PIPELINE_STAGES[i - 1].outputCheck, session.participantId) });
  }
  return results;
});

// ---------- IPC: pipeline run ----------
let runningProc = null, runningContainerId = null;

function buildDockerBaseArgs(inputDir, outputDir, containerName) {
  const args = ['run', '--rm', '--name', containerName, '--memory=48g', '-e', 'R_MAX_SIZE=48GB', '-e', 'PWESUITE_PYTHON=/opt/conda/envs/pwesuite_env/bin/python', '-v', `${inputDir}:/input`, '-v', `${outputDir}:/app/output`];
  if (fs.existsSync(REF_DATA_DIR()) && fs.readdirSync(REF_DATA_DIR()).length) {
    const inner = path.join(REF_DATA_DIR(), 'reference_data');
    args.push('-v', `${fs.existsSync(inner) ? inner : REF_DATA_DIR()}:/app/reference_data`);
  }
  const cfg = CONFIG_FILE();
  if (fs.existsSync(cfg)) args.push('-v', `${cfg}:/app/config/task_template.yaml:ro`);
  return args;
}

function runStage(dockerArgs, onLog) {
  return new Promise((resolve, reject) => {
    runningProc = spawn('docker', dockerArgs);
    runningProc.stdout.on('data', (d) => onLog(d.toString()));
    runningProc.stderr.on('data', (d) => onLog(d.toString()));
    runningProc.on('error', (err) => { runningProc = null; runningContainerId = null; reject(err); });
    runningProc.on('close', (code) => { runningProc = null; runningContainerId = null; resolve(code); });
  });
}

ipcMain.handle('pipeline:run', async (_e, { sessionId, stages, whisperModel }) => {
  if (runningProc) throw new Error('A pipeline run is already in progress.');
  const db = await loadDB();
  let session = db.sessions.find((s) => s.id === sessionId);
  if (!session && sessionId.startsWith('imported_')) {
    const AUDIO_EXTS = ['.wav', '.mp3', '.webm', '.ogg', '.flac', '.m4a'];
    outer: for (const pid of await fsp.readdir(PARTICIPANTS_D()).catch(() => [])) {
      const inputDir = path.join(PARTICIPANTS_D(), pid, 'input');
      if (!fs.existsSync(inputDir)) continue;
      for (const file of await fsp.readdir(inputDir).catch(() => [])) {
        if (!AUDIO_EXTS.includes(path.extname(file).toLowerCase())) continue;
        if (`imported_${pid}_${file}` === sessionId) {
          const audioPath = path.join(inputDir, file);
          const stat = await fsp.stat(audioPath);
          session = { id: sessionId, participantId: pid, audioPath, audioFilename: file, recordedAt: stat.mtime.toISOString(), pipelineStatus: 'pending', pipelineRunAt: null, outputDir: path.join(PARTICIPANTS_D(), pid, 'output'), imported: true };
          break outer;
        }
      }
    }
  }
  if (!session) throw new Error('Session not found.');

  const stagesToRun = stages && stages.length > 0 ? PIPELINE_STAGES.filter((s) => stages.includes(s.id)) : PIPELINE_STAGES;
  if (stagesToRun.length === 0) throw new Error('No valid stages selected.');

  const { participantId } = session;
  const inputDir  = path.dirname(session.audioPath);
  const outputDir = path.join(PARTICIPANTS_D(), participantId, 'output');
  await fsp.mkdir(outputDir, { recursive: true });
  for (const sub of ['cropped_audio', 'transcriptions', 'review_files', 'features']) await fsp.mkdir(path.join(outputDir, sub), { recursive: true });

  const audioInContainer  = `/input/${path.basename(session.audioPath)}`;
  const configInContainer = '/app/config/task_template.yaml';
  const sendLog   = (line) => mainWin?.webContents.send('pipeline:log',          { sessionId, line });
  const sendStage = (id, status) => mainWin?.webContents.send('pipeline:stage-update', { sessionId, stageId: id, status });

  session.pipelineStatus = 'running'; session.pipelineRunAt = new Date().toISOString();
  await saveDB(db);

  let overallOk = true, lastExitCode = 0;

  for (const stage of stagesToRun) {
    const containerName = `iss_${participantId}_${stage.id}_${Date.now()}`;
    runningContainerId = containerName;
    sendStage(stage.id, 'running');
    sendLog(`\n--- Stage: ${stage.label} ---\n`);

    const baseArgs  = buildDockerBaseArgs(inputDir, outputDir, containerName);
    const imageArgs = [participantId, audioInContainer, configInContainer, '--stage', stage.stageArg];

    if (stage.id === 'stage2') {
      if (whisperModel && whisperModel !== 'small') imageArgs.push('--whisper-model', whisperModel);
      imageArgs.push('--full_audio_file', audioInContainer);
      sendLog('[info] Full-audio transcription enabled\n');
    }

    if (stage.id === 'stage3') {
      const reviewDirHost = path.join(outputDir, 'review_files');
      const reviewFiles = await listReviewerFiles(reviewDirHost, participantId);
      if (reviewFiles.length > 0) {
        const reviewDirInContainer = '/app/review_input';
        baseArgs.push('-v', `${reviewDirHost}:${reviewDirInContainer}:ro`);
        imageArgs.push('--review_dir', reviewDirInContainer);
        sendLog(`[info] ${reviewFiles.length} reviewer file(s) found — consensus mode\n`);
        for (const rf of reviewFiles) sendLog(`[info]   ${rf.initials} @ ${rf.timestamp}: ${rf.filename}\n`);
      } else {
        sendLog('[info] No reviewer files — automatic cleanup\n');
      }
    }

    const stageArgs = [...baseArgs, DOCKER_IMAGE, ...imageArgs];
    sendLog(`$ docker ${stageArgs.join(' ')}\n`);

    let exitCode;
    try { exitCode = await runStage(stageArgs, sendLog); }
    catch (err) { sendLog(`\n[error] ${err.message}\n`); sendStage(stage.id, 'error'); overallOk = false; lastExitCode = 1; break; }

    lastExitCode = exitCode;
    if (exitCode !== 0) {
      const cancelled = exitCode === 137 || exitCode === 130;
      sendLog(`\n[stage ${cancelled ? 'cancelled' : 'failed'}: exit ${exitCode}]\n`);
      sendStage(stage.id, cancelled ? 'cancelled' : 'error');
      overallOk = false; break;
    }
    sendStage(stage.id, 'completed');
  }

  runningContainerId = null;
  sendLog(`\n[pipeline ${overallOk ? 'completed' : 'failed'}: exit ${lastExitCode}]\n`);

  const db2 = await loadDB(); const s2 = db2.sessions.find((s) => s.id === sessionId);
  if (s2) { s2.pipelineStatus = overallOk ? 'completed' : 'error'; s2.pipelineExitCode = lastExitCode; await saveDB(db2); }
  return { ok: overallOk, exitCode: lastExitCode };
});

ipcMain.handle('pipeline:cancel', () => {
  if (runningContainerId) exec(`docker kill ${runningContainerId}`, () => {});
  if (runningProc) { runningProc.kill('SIGTERM'); return true; }
  return false;
});
ipcMain.handle('pipeline:stages', () => PIPELINE_STAGES);

// =============================================================================
// IPC: review
// =============================================================================
ipcMain.handle('review:load-raw',  async (_e, participantId) => loadRawReviewData(participantId));
ipcMain.handle('review:load',      async (_e, participantId) => loadRawReviewData(participantId));

ipcMain.handle('review:load-own', async (_e, { participantId, initials }) => {
  if (!participantId) throw new Error('participantId is required.');
  if (!initials)      throw new Error('initials are required.');
  const clean = initials.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const reviewDir = path.join(PARTICIPANTS_D(), participantId, 'output', 'review_files');
  const allFiles  = await listReviewerFiles(reviewDir, participantId);
  const ownFiles  = allFiles.filter((f) => f.initials.toUpperCase() === clean);
  if (ownFiles.length === 0) return { ...(await loadRawReviewData(participantId)), resumedFrom: null };
  const latest = ownFiles[ownFiles.length - 1];
  const rows = (await fsp.readFile(latest.filePath, 'utf8')).split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
  const votesMap = await buildPriorVotes(allFiles);
  const priorVotes = {}; for (const [k, v] of votesMap.entries()) priorVotes[k] = v;
  return { rows, filePath: latest.filePath, priorVotes, raters: [...new Set(allFiles.map((r) => r.initials))], resumedFrom: latest.filename, error: null };
});

ipcMain.handle('review:save', async (_e, { participantId, initials, rows, filePath }) => {
  if (filePath && !initials) { await fsp.writeFile(filePath, rows.map((r) => r.join('\t')).join('\n'), 'utf8'); return { ok: true, savedTo: filePath }; }
  if (!participantId) throw new Error('participantId is required.');
  if (!initials)      throw new Error('initials are required.');
  const clean = initials.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (!clean) throw new Error('Initials must contain at least one alphanumeric character.');
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  const reviewDir = path.join(PARTICIPANTS_D(), participantId, 'output', 'review_files');
  await fsp.mkdir(reviewDir, { recursive: true });
  const filename = `${participantId}_review_${clean}_${ts}.tsv`;
  const dest = path.join(reviewDir, filename);
  await fsp.writeFile(dest, rows.map((r) => r.join('\t')).join('\n'), 'utf8');
  return { ok: true, savedTo: dest, filename };
});

const _listReviewFiles = async (participantId) => {
  const reviewDir = path.join(PARTICIPANTS_D(), participantId, 'output', 'review_files');
  return (await listReviewerFiles(reviewDir, participantId)).map(({ filePath, initials, timestamp, filename }) => ({ filePath, initials, timestamp, filename }));
};
ipcMain.handle('review:list-files',  async (_e, participantId) => _listReviewFiles(participantId));
ipcMain.handle('review:list-raters', async (_e, participantId) => _listReviewFiles(participantId));

ipcMain.handle('review:get-audio-files', async (_e, participantId) => {
  const AUDIO_EXTS = ['.wav', '.mp3', '.flac', '.ogg', '.m4a'];
  const baseDir = path.join(PARTICIPANTS_D(), participantId, 'output', 'cropped_audio');
  const subDir  = path.join(baseDir, participantId);
  const searchDir = fs.existsSync(subDir) ? subDir : (fs.existsSync(baseDir) ? baseDir : null);
  if (!searchDir) return [];
  return (await fsp.readdir(searchDir).catch(() => []))
    .filter((f) => AUDIO_EXTS.includes(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => { const fullPath = path.join(searchDir, f); return { stem: path.basename(f, path.extname(f)), filePath: fullPath, fileUrl: `file://${fullPath.replace(/\\/g, '/')}` }; });
});

// ---------- IPC: results ----------
ipcMain.handle('results:list', async (_e, participantId) => {
  const dir = path.join(PARTICIPANTS_D(), participantId, 'output', 'features');
  if (!fs.existsSync(dir)) return [];
  const RESULT_EXTS = ['.csv', '.tsv', '.rds', '.json', '.txt'];
  const files = await Promise.all((await fsp.readdir(dir)).filter((f) => RESULT_EXTS.includes(path.extname(f).toLowerCase())).map(async (f) => { const full = path.join(dir, f); const stat = await fsp.stat(full); return { name: f, path: full, size: stat.size, mtime: stat.mtime, ext: path.extname(f).toLowerCase() }; }));
  return files.sort((a, b) => b.mtime - a.mtime);
});

ipcMain.handle('results:read-csv', async (_e, filepath) => {
  const raw = await fsp.readFile(filepath, 'utf8');
  const max = 2 * 1024 * 1024;
  const text = raw.length > max ? raw.slice(0, max) : raw;
  const sep = filepath.endsWith('.tsv') ? '\t' : ',';
  return { rows: text.split(/\r?\n/).filter(Boolean).map((l) => splitDelimited(l, sep)), truncated: raw.length > max };
});

function splitDelimited(line, sep = ',') {
  if (sep === '\t') return line.split('\t');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i+1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
}

ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));
