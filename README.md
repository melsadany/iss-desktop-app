# Iowa Speech Sample — Desktop

A native Electron app that wraps the **Iowa Speech Sample (ISS) v1.10.B** workflow:

1. **Record** — play the bundled task video fullscreen and capture participant audio.
2. **Run** — execute the analysis pipeline locally via the `melsadany/iowa_speech_sample:latest` Docker image.
3. **View** — render tabular outputs in-app; open other file types from the data folder.

Feature extraction is identical to the CLI pipeline; the app adds a desktop interface for setup, recording, execution, and review.

---

## Requirements

- macOS 11+ or Linux (Ubuntu 20.04+ / Debian 11+); Apple Silicon and x64 supported on macOS.
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running.
- ~30 GB free disk space for the Docker image and reference data.
- 8 GB RAM minimum; 16 GB recommended (WhisperX large-v3 model).

The app does **not** install Docker. The **Setup** tab checks Docker status, shows whether the analysis image is present, and links to Docker Desktop if needed.

---

## Run from source

```bash
git clone https://github.com/melsadany/iss-desktop-app.git
cd iss-desktop-app
npm install
npm start
```

## Build installers

```bash
npm install
npm run dist:mac     # → dist/Iowa Speech Sample-1.0.0.dmg
npm run dist:linux   # → dist/Iowa Speech Sample-1.0.0.AppImage  +  .deb
```

Build outputs land in `dist/`. macOS builds are unsigned by default; for distribution, add Apple Developer credentials and rebuild with `electron-builder --mac --publish=never`.

---

## Tabs

| Tab | What it does |
|---|---|
| **Setup** | Checks Docker, pulls the ISS image, runs a non-blocking startup freshness check, and downloads reference data from Zenodo. |
| **Participants** | Create, list, and remove participants. Supports optional metadata (age, sex, education, handedness). Each participant gets a folder under `userData/participants/<id>/`. |
| **Record** | Plays the bundled `task_video.mp4` fullscreen, records microphone audio, and saves the file into the participant's `input/` folder. |
| **Run pipeline** | Spawns `docker run` against `melsadany/iowa_speech_sample:latest`, mounts participant input/output folders and the editable config, streams live logs, and shows a per-stage progress panel (cropping → transcription → diarization → R features → consolidation). |
| **Results** | Lists files in `output/features/`; renders `.csv` / `.tsv` in a table viewer; provides open-in-folder guidance for `.rds`, `.json`, and `.txt`. |

---

## Where data lives

| Path | Contents |
|---|---|
| `userData/participants/<id>/input/` | Recorded or imported audio files. |
| `userData/participants/<id>/output/features/` | Pipeline outputs: CSV, TSV, RDS, JSON, TXT. |
| `userData/reference_data/` | Zenodo reference data (embeddings, archetypes, norms, task metadata). |
| `userData/config/task_template.yaml` | Editable pipeline config, copied from `resources/` on first launch. |
| `userData/iss_db.json` | Local index of participants and recorded sessions. |

`userData` resolves to:
- **macOS** — `~/Library/Application Support/Iowa Speech Sample/`
- **Linux** — `~/.config/Iowa Speech Sample/`

Use **File → Open data folder** or the sidebar shortcut to navigate there directly.

---

## Architecture

```text
src/
├── main/
│   ├── main.js        # Electron main: IPC handlers, Docker, downloads, file I/O
│   └── preload.js     # contextBridge — exposes window.iss.* to the renderer
└── renderer/
    ├── index.html     # 5-tab UI shell
    ├── styles.css     # Design tokens, theme (light/dark), component styles
    ├── renderer.js    # UI logic: navigation, recording, stage panel, result preview
    ├── vendor/
    │   └── lame.min.js
    └── assets/
        ├── task_video.mp4
        └── logo.png
resources/
└── task_template.yaml  # Default config copied to userData on first launch
```

The renderer does not access Node APIs directly. Privileged work — `spawn`, file I/O, HTTPS downloads — runs in `main.js` and is exposed to the renderer via the `window.iss` bridge in `preload.js`.

---

## Related

- Pipeline source: <https://github.com/melsadany/iss-pipeline>
- Docker image: <https://hub.docker.com/r/melsadany/iowa_speech_sample>
- Reference data: <https://zenodo.org/records/18675411>

---

## License

MIT.
