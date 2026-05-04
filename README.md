# Iowa Speech Sample — Desktop

A native desktop app (Electron) that wraps the **Iowa Speech Sample (ISS) v1.10.B** workflow:

1. **Record** the ISS task (plays the task video fullscreen, captures the participant's audio).
2. **Run** the analysis pipeline locally via the `melsadany/iowa_speech_sample:v1.0` Docker image.
3. **View** per-participant CSV outputs and open the data folder.

It reuses the official Docker image so feature extraction is bit-for-bit identical to the CLI pipeline.

---

## Requirements

- macOS 11+ or Linux (Ubuntu 20.04+ / Debian 11+) — Apple Silicon and x64 supported on macOS.
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running.
- ~30 GB free disk for the Docker image + reference data.
- 8 GB RAM minimum (16 GB recommended for WhisperX large-v3).

The app does **not** download Docker for you — the **Setup** screen shows a status check and links you to the installer if it's missing.

---

## Run from source

```bash
git clone <this repo>
cd iss-desktop
npm install
npm start
```

## Build installers

```bash
npm install
npm run dist:mac     # → dist/Iowa Speech Sample-1.0.0.dmg
npm run dist:linux   # → dist/Iowa Speech Sample-1.0.0.AppImage  +  .deb
```

Outputs land in `dist/`. macOS builds are unsigned by default — for distribution
add Apple Developer credentials and re-run with `electron-builder --mac --publish=never`.

## What the app does

| Tab            | What it does                                                                 |
|----------------|------------------------------------------------------------------------------|
| **Setup**      | Detects Docker, pulls the ISS image, downloads reference data from Zenodo.   |
| **Participants** | Create / list / remove participants. Each gets a folder under `userData/participants/<id>`. |
| **Record**     | Plays the bundled `task_video.mp4` fullscreen, records mic audio, saves MP3/WAV/WebM into the participant's `input/`. |
| **Run pipeline** | Spawns `docker run melsadany/iowa_speech_sample:v1.0 <id> /input/<file>` and streams logs live. |
| **Results**    | Lists CSV files in `output/features/` and renders the selected one in a table viewer. |

### Where data lives

| Location                                      | Contents                                                |
|-----------------------------------------------|---------------------------------------------------------|
| `userData/participants/<id>/input/`           | Recorded audio files (`<id>_<timestamp>.mp3`).          |
| `userData/participants/<id>/output/features/` | Pipeline outputs (per-prompt, per-task, per-participant CSVs). |
| `userData/reference_data/`                    | Zenodo reference data (embeddings, archetypes, norms).  |
| `userData/config/task_template.yaml`          | Editable copy of the pipeline config.                   |
| `userData/iss_db.json`                        | Index of participants + sessions.                       |

`userData` resolves to:
- macOS — `~/Library/Application Support/Iowa Speech Sample/`
- Linux — `~/.config/Iowa Speech Sample/`

Use **File → Open data folder** (or the sidebar shortcut) to jump there.

## Architecture

```
src/
├── main/
│   ├── main.js        # Electron main: IPC, Docker, downloads, file I/O
│   └── preload.js     # contextBridge — exposes `window.iss.*`
└── renderer/
    ├── index.html     # 5-tab UI
    ├── styles.css
    ├── renderer.js    # All UI logic + WebAudio/MediaRecorder + lamejs encoder
    ├── vendor/lame.min.js
    └── assets/task_video.mp4
resources/
└── task_template.yaml # default config copied to userData on first launch
```

The renderer never touches Node — all privileged work (spawn, fs, https) is done in `main.js`
behind the `iss` IPC bridge defined in `preload.js`.

## Reference

- Pipeline source: <https://github.com/melsadany/iss-pipeline>
- Docker image: <https://hub.docker.com/r/melsadany/iowa_speech_sample>
- Reference data: <https://zenodo.org/records/18675411>

## License

MIT.
# iss-desktop-app
