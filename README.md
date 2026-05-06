# Iowa Speech Sample — Desktop App

A native Electron app that wraps the **Iowa Speech Sample (ISS) v1.10.B** pipeline with a point-and-click interface for recording, execution, transcript review, and result inspection.

---

## Requirements

- macOS 11+ or Linux (Ubuntu 20.04+ / Debian 11+); Apple Silicon and x64 supported on macOS
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- ~30 GB free disk space for the Docker image and reference data
- 8 GB RAM minimum; 16 GB recommended (WhisperX large-v3)

The app does **not** install Docker. The **Setup** tab checks Docker status and links to Docker Desktop if it is missing.

---

## Run from Source

```bash
git clone https://github.com/melsadany/iss-desktop-app.git
cd iss-desktop-app
npm install
npm start
```

## Build Installers

```bash
npm install
npm run dist:mac     # → dist/Iowa Speech Sample-1.0.0.dmg
npm run dist:linux   # → dist/Iowa Speech Sample-1.0.0.AppImage + .deb
```

macOS builds are unsigned by default. For distribution, add Apple Developer credentials and rebuild with `electron-builder --mac --publish=never`.

---

## Tabs

| Tab | What it does |
|---|---|
| **Setup** | Checks Docker, pulls the ISS image, and downloads reference data from Zenodo. |
| **Participants** | Create, list, and remove participants. Supports optional metadata (age, sex, education years, handedness). Each participant gets a folder under `userData/participants/<id>/`. |
| **Record** | Plays the bundled `task_video.mp4` fullscreen, records microphone audio, and saves the file into the participant’s `input/` folder. |
| **Run pipeline** | Runs `docker run` against `melsadany/iowa_speech_sample:latest`, mounts participant folders, streams live logs, and shows a per-stage progress panel (cropping → transcription → cleanup → feature extraction → consolidation). |
| **Review** | Loads the cleaned transcription TSV, plays participant audio in sync with the transcript, and lets you edit responses and flag rows for re-processing. |
| **Results** | Lists files in `output/features/`; renders `.csv`/`.tsv` in a table viewer; provides open-in-folder guidance for `.rds`, `.json`, and `.txt`. |

---

## Where Data Lives

| Path | Contents |
|---|---|
| `userData/participants/<id>/input/` | Recorded or imported audio files |
| `userData/participants/<id>/output/features/` | Pipeline outputs: CSV, TSV, RDS, JSON, TXT |
| `userData/reference_data/` | Zenodo reference data (embeddings, archetypes, norms, task metadata) |
| `userData/config/task_template.yaml` | Editable pipeline config, copied from `resources/` on first launch |
| `userData/iss_db.json` | Local index of participants and sessions |

`userData` resolves to:
- **macOS** — `~/Library/Application Support/Iowa Speech Sample/`
- **Linux** — `~/.config/Iowa Speech Sample/`

Use **File → Open data folder** or the sidebar shortcut to navigate there directly.

---

## Architecture

```text
src/
├── main/
│   ├── main.js        # IPC handlers, Docker, downloads, file I/O
│   └── preload.js     # contextBridge — exposes window.iss.* to the renderer
└── renderer/
    ├── index.html     # 6-tab UI shell
    ├── styles.css     # Design tokens, light/dark theme, component styles
    ├── renderer.js    # UI logic: navigation, recording, stage panel, review, results
    ├── vendor/
    │   └── lame.min.js
    └── assets/
        ├── task_video.mp4
        └── logo.png
resources/
└── task_template.yaml  # Default config copied to userData on first launch
```

The renderer has no direct Node access. Privileged work — `spawn`, file I/O, HTTPS downloads — runs in `main.js` and is exposed via the `window.iss` bridge in `preload.js`.

---

## Related

- Pipeline source: <https://github.com/melsadany/iss-pipeline>
- Docker image: <https://hub.docker.com/r/melsadany/iowa_speech_sample>
- Reference data: <https://zenodo.org/records/18675411>

---

## License

MIT.
