/* Iowa Speech Sample — Electron main process
 *
 * Responsibilities:
 *   • Create the BrowserWindow
 *   • Persist participants/sessions in userData/iss_db.json
 *   • Save recorded audio blobs to disk
 *   • Pull/run the melsadany/iowa_speech_sample Docker image
 *   • Auto-download the Zenodo reference_data archive on first run
 *   • Stream Docker stdout/stderr live to the renderer
 */

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn, exec } = require('child_process');
const { pipeline } = require('stream/promises');
const https = require('https');

// ---------- paths ----------
const USER_DATA      = () => app.getPath('userData');
const DB_PATH        = () => path.join(USER_DATA(), 'iss_db.json');
const PARTICIPANTS_D = () => path.join(USER_DATA(), 'participants');
const REF_DATA_DIR   = () => path.join(USER_DATA(), 'reference_data');
const CONFIG_DIR     = () => path.join(USER_DATA(), 'config');

const DOCKER_IMAGE = 'melsadany/iowa_speech_sample:v1.1';
const ZENODO_URL   = 'https://zenodo.org/records/18675411/files/reference_data.zip?download=1';

// ---------- DB ----------
async function loadDB() {
  try {
    const raw = await fsp.readFile(DB_PATH(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { participants: [], sessions: [] };
  }
}

async function saveDB(db) {
  await fsp.mkdir(USER_DATA(), { recursive: true });
  await fsp.writeFile(DB_PATH(), JSON.stringify(db, null, 2), 'utf8');
}

// ---------- helpers ----------
function which(cmd) {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    exec(probe, (err, stdout) => resolve(err ? null : stdout.trim().split(/\r?\n/)[0]));
  });
}

function dockerInstalled() {
  return new Promise((resolve) => {
    exec('docker --version', (err) => resolve(!err));
  });
}

function dockerRunning() {
  return new Promise((resolve) => {
    exec('docker info --format "{{.ServerVersion}}"', (err, stdout) =>
      resolve(!err && !!stdout.trim())
    );
  });
}

function imageAvailable(image) {
  return new Promise((resolve) => {
    exec(`docker image inspect ${image}`, (err) => resolve(!err));
  });
}

// ---------- window ----------
let mainWin;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#1a242f',
    title: 'Iowa Speech Sample',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Custom menu (minimal)
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open data folder',
          click: () => shell.openPath(USER_DATA())
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'GitHub repository',
          click: () => shell.openExternal('https://github.com/melsadany/iss-pipeline')
        },
        {
          label: 'Reference data on Zenodo',
          click: () => shell.openExternal('https://zenodo.org/records/18675411')
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  // Ensure folders exist
  await fsp.mkdir(PARTICIPANTS_D(), { recursive: true });
  await fsp.mkdir(REF_DATA_DIR(),   { recursive: true });
  await fsp.mkdir(CONFIG_DIR(),     { recursive: true });

  // Copy bundled task_template.yaml + task_video.mp4 into userData if missing
  const bundledConfig = path.join(process.resourcesPath || path.join(__dirname, '..', '..', 'resources'), 'task_template.yaml');
  const userConfig    = path.join(CONFIG_DIR(), 'task_template.yaml');
  if (!fs.existsSync(userConfig) && fs.existsSync(bundledConfig)) {
    await fsp.copyFile(bundledConfig, userConfig);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC: app/system info ----------
ipcMain.handle('app:paths', () => ({
  userData: USER_DATA(),
  participants: PARTICIPANTS_D(),
  referenceData: REF_DATA_DIR(),
  config: CONFIG_DIR(),
  configFile: path.join(CONFIG_DIR(), 'task_template.yaml')
}));

ipcMain.handle('app:open-path', (_e, p) => shell.openPath(p));

ipcMain.handle('system:check', async () => {
  const installed = await dockerInstalled();
  const running   = installed ? await dockerRunning() : false;
  const hasImage  = running ? await imageAvailable(DOCKER_IMAGE) : false;
  const refExists = fs.existsSync(REF_DATA_DIR()) &&
    (await fsp.readdir(REF_DATA_DIR()).catch(() => [])).length > 0;
  return {
    platform: process.platform,
    arch: process.arch,
    dockerInstalled: installed,
    dockerRunning: running,
    imagePresent: hasImage,
    imageName: DOCKER_IMAGE,
    referenceDataPresent: refExists,
    referenceDataPath: REF_DATA_DIR()
  };
});

// ---------- IPC: participants ----------
ipcMain.handle('participants:list', async () => {
  const db = await loadDB();
  return db.participants;
});

ipcMain.handle('participants:create', async (_e, { id, label, notes }) => {
  if (!id || !/^[A-Za-z0-9_\-]+$/.test(id)) {
    throw new Error('Participant ID must be alphanumeric (letters, digits, _ or -).');
  }
  const db = await loadDB();
  if (db.participants.find((p) => p.id === id)) {
    throw new Error(`Participant "${id}" already exists.`);
  }
  const dir = path.join(PARTICIPANTS_D(), id);
  await fsp.mkdir(path.join(dir, 'input'),  { recursive: true });
  await fsp.mkdir(path.join(dir, 'output'), { recursive: true });
  const p = {
    id,
    label: label || id,
    notes: notes || '',
    createdAt: new Date().toISOString(),
    dir
  };
  db.participants.push(p);
  await saveDB(db);
  return p;
});

ipcMain.handle('participants:delete', async (_e, id) => {
  const db = await loadDB();
  db.participants = db.participants.filter((p) => p.id !== id);
  db.sessions     = db.sessions.filter((s) => s.participantId !== id);
  await saveDB(db);
  // We do NOT delete on-disk recordings automatically — only the index.
  return true;
});

ipcMain.handle('sessions:list', async (_e, participantId) => {
  const db = await loadDB();
  const sessions = [...db.sessions];

  // Scan filesystem for audio files not registered in iss_db.json
  const AUDIO_EXTS = ['.wav', '.mp3', '.webm', '.ogg', '.flac', '.m4a'];
  const participantsDir = PARTICIPANTS_D();

  if (fs.existsSync(participantsDir)) {
    const pids = participantId
      ? [participantId]
      : await fsp.readdir(participantsDir).catch(() => []);

    for (const pid of pids) {
      const inputDir = path.join(participantsDir, pid, 'input');
      if (!fs.existsSync(inputDir)) continue;

      const files = (await fsp.readdir(inputDir).catch(() => [])).filter(f =>
        AUDIO_EXTS.includes(path.extname(f).toLowerCase())
      );

      for (const file of files) {
        const audioPath = path.join(inputDir, file);
        const alreadyKnown = sessions.some(s => s.audioPath === audioPath);
        if (!alreadyKnown) {
          const stat = await fsp.stat(audioPath);
          sessions.push({
            id: `imported_${pid}_${file}`,
            participantId: pid,
            audioPath,
            audioFilename: file,
            recordedAt: stat.mtime.toISOString(),
            pipelineStatus: 'pending',
            pipelineRunAt: null,
            outputDir: path.join(participantsDir, pid, 'output'),
            imported: true
          });
        }
      }
    }
  }

  return sessions.filter((s) => !participantId || s.participantId === participantId);
});

// ---------- IPC: save recording ----------
ipcMain.handle('recording:save', async (_e, { participantId, buffer, extension }) => {
  if (!participantId) throw new Error('participantId is required');
  const dir = path.join(PARTICIPANTS_D(), participantId, 'input');
  await fsp.mkdir(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${participantId}_${ts}.${extension || 'mp3'}`;
  const filepath = path.join(dir, filename);
  await fsp.writeFile(filepath, Buffer.from(buffer));

  const db = await loadDB();
  const session = {
    id: `${participantId}_${ts}`,
    participantId,
    audioPath: filepath,
    audioFilename: filename,
    recordedAt: new Date().toISOString(),
    pipelineStatus: 'pending',
    pipelineRunAt: null,
    outputDir: path.join(PARTICIPANTS_D(), participantId, 'output')
  };
  db.sessions.push(session);
  await saveDB(db);
  return session;
});

// ---------- IPC: download reference data ----------
function streamProgress(res, total, onProgress) {
  let received = 0;
  res.on('data', (chunk) => {
    received += chunk.length;
    if (total) onProgress({ received, total, pct: received / total });
    else onProgress({ received, total: 0, pct: 0 });
  });
}

function httpsGetFollow(url) {
  return new Promise((resolve, reject) => {
    const go = (u, depth = 0) => {
      if (depth > 5) return reject(new Error('Too many redirects'));
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, u).toString(), depth + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
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

  // Cross-platform unzip — prefer system unzip; fall back to Node-based fallback
  await new Promise((resolve, reject) => {
    const unzipCmd = process.platform === 'win32'
      ? `powershell -Command "Expand-Archive -Force -Path '${tmp}' -DestinationPath '${REF_DATA_DIR()}'"`
      : `unzip -o "${tmp}" -d "${REF_DATA_DIR()}"`;
    exec(unzipCmd, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Unzip failed: ${stderr || err.message}`));
      resolve();
    });
  });

  await fsp.unlink(tmp).catch(() => {});
  send({ phase: 'done', message: 'Reference data ready.' });
  return { ok: true, path: REF_DATA_DIR() };
});

// ---------- IPC: docker image pull ----------
ipcMain.handle('docker:pull', async () => {
  const send = (line) => mainWin?.webContents.send('docker:pull-log', line);
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['pull', DOCKER_IMAGE]);
    proc.stdout.on('data', (d) => send(d.toString()));
    proc.stderr.on('data', (d) => send(d.toString()));
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`docker pull exited with code ${code}`));
    });
  });
});
ipcMain.handle('docker:force-pull', async () => {
  const send = (line) => mainWin?.webContents.send('docker:pull-log', line);
  return new Promise((resolve, reject) => {
    // Remove local image first to guarantee a fresh download
    exec(`docker rmi ${DOCKER_IMAGE}`, () => {
      // Ignore rmi errors (image may not exist) — always proceed to pull
      const proc = spawn('docker', ['pull', '--platform', 'linux/amd64', DOCKER_IMAGE]);
      proc.stdout.on('data', (d) => send(d.toString()));
      proc.stderr.on('data', (d) => send(d.toString()));
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0) resolve({ ok: true });
        else reject(new Error(`docker pull exited with code ${code}`));
      });
    });
  });
});

// ---------- IPC: pipeline run ----------
let runningProc = null;

ipcMain.handle('pipeline:run', async (_e, { sessionId }) => {
  if (runningProc) throw new Error('A pipeline run is already in progress.');
  const db = await loadDB();
  let session = db.sessions.find((s) => s.id === sessionId);
  
  // Fallback: check if it's an imported (filesystem-only) session
  if (!session && sessionId.startsWith('imported_')) {
    const AUDIO_EXTS = ['.wav', '.mp3', '.webm', '.ogg', '.flac', '.m4a'];
    const participantsDir = PARTICIPANTS_D();
    outer: for (const pid of await fsp.readdir(participantsDir).catch(() => [])) {
      const inputDir = path.join(participantsDir, pid, 'input');
      if (!fs.existsSync(inputDir)) continue;
      for (const file of await fsp.readdir(inputDir).catch(() => [])) {
        if (!AUDIO_EXTS.includes(path.extname(file).toLowerCase())) continue;
        if (`imported_${pid}_${file}` === sessionId) {
          const audioPath = path.join(inputDir, file);
          const stat = await fsp.stat(audioPath);
          session = {
            id: sessionId,
            participantId: pid,
            audioPath,
            audioFilename: file,
            recordedAt: stat.mtime.toISOString(),
            pipelineStatus: 'pending',
            pipelineRunAt: null,
            outputDir: path.join(participantsDir, pid, 'output'),
            imported: true
          };
          break outer;
        }
      }
    }
  }
  
  if (!session) throw new Error('Session not found.');

  const participantId = session.participantId;
  const inputDir  = path.dirname(session.audioPath);
  const outputDir = path.join(PARTICIPANTS_D(), participantId, 'output');
  await fsp.mkdir(outputDir, { recursive: true });
  for (const sub of ['cropped_audio', 'transcriptions', 'review_files', 'features']) {
    await fsp.mkdir(path.join(outputDir, sub), { recursive: true });
  }

  // The container expects /input/<file> and /app/output mounts
  const audioInContainer = `/input/${path.basename(session.audioPath)}`;

  const dockerArgs = [
    'run', '--rm',
    '-v', `${inputDir}:/input`,
    '-v', `${outputDir}:/app/output`
  ];

  if (fs.existsSync(REF_DATA_DIR()) && fs.readdirSync(REF_DATA_DIR()).length) {
    // Zenodo zip extracts a nested reference_data/ subfolder — detect and unwrap it
    const innerDir = path.join(REF_DATA_DIR(), 'reference_data');
    const mountSrc = fs.existsSync(innerDir) ? innerDir : REF_DATA_DIR();
    dockerArgs.push('-v', `${mountSrc}:/app/reference_data`);
  }
  const cfg = path.join(CONFIG_DIR(), 'task_template.yaml');
  if (fs.existsSync(cfg)) {
    dockerArgs.push('-v', `${cfg}:/app/config/task_template.yaml`);
  }

  dockerArgs.push(DOCKER_IMAGE, participantId, audioInContainer);

  const send = (line) => mainWin?.webContents.send('pipeline:log', { sessionId, line });

  send(`$ docker ${dockerArgs.join(' ')}\n`);
  session.pipelineStatus = 'running';
  session.pipelineRunAt  = new Date().toISOString();
  await saveDB(db);

  return new Promise((resolve) => {
    runningProc = spawn('docker', dockerArgs);
    runningProc.stdout.on('data', (d) => send(d.toString()));
    runningProc.stderr.on('data', (d) => send(d.toString()));
    runningProc.on('error', async (err) => {
      send(`\n[error] ${err.message}\n`);
      const db2 = await loadDB();
      const s2 = db2.sessions.find((s) => s.id === sessionId);
      if (s2) { s2.pipelineStatus = 'error'; await saveDB(db2); }
      runningProc = null;
      resolve({ ok: false, error: err.message });
    });
    runningProc.on('close', async (code) => {
      send(`\n[exit ${code}]\n`);
      const db2 = await loadDB();
      const s2 = db2.sessions.find((s) => s.id === sessionId);
      if (s2) {
        s2.pipelineStatus = code === 0 ? 'completed' : 'error';
        s2.pipelineExitCode = code;
        await saveDB(db2);
      }
      runningProc = null;
      resolve({ ok: code === 0, exitCode: code });
    });
  });
});

ipcMain.handle('pipeline:cancel', () => {
  if (runningProc) {
    runningProc.kill('SIGINT');
    return true;
  }
  return false;
});

// ---------- IPC: results ----------
ipcMain.handle('results:list', async (_e, participantId) => {
  const dir = path.join(PARTICIPANTS_D(), participantId, 'output', 'features');
  if (!fs.existsSync(dir)) return [];
  const entries = await fsp.readdir(dir);
  const files = await Promise.all(
    entries
      .filter((f) => f.endsWith('.csv'))
      .map(async (f) => {
        const full = path.join(dir, f);
        const stat = await fsp.stat(full);
        return { name: f, path: full, size: stat.size, mtime: stat.mtime };
      })
  );
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
});

ipcMain.handle('results:read-csv', async (_e, filepath) => {
  const raw = await fsp.readFile(filepath, 'utf8');
  // Parse first ~2 MB to keep UI snappy on huge tables
  const max = 2 * 1024 * 1024;
  const text = raw.length > max ? raw.slice(0, max) : raw;
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows  = lines.map((line) => splitCSV(line));
  return { rows, truncated: raw.length > max };
});

function splitCSV(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === ',' && !q) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));
