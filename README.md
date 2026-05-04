# Iowa Speech Sample — Desktop

A native desktop app (Electron) that wraps the **Iowa Speech Sample (ISS) v1.10.B** workflow:

1. **Record** the ISS task by playing the bundled task video fullscreen and capturing the participant's audio.
2. **Run** the analysis pipeline locally via the `melsadany/iowa_speech_sample:latest` Docker image.
3. **View** per-participant outputs, including tabular files in-app and non-tabular files via the data folder.

It reuses the official Docker image, so feature extraction matches the CLI pipeline while giving you a simple desktop workflow for setup, recording, execution, and review.

---

## Requirements

- macOS 11+ or Linux (Ubuntu 20.04+ / Debian 11+); Apple Silicon and x64 are supported on macOS.
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running.
- ~30 GB free disk for the Docker image and reference data.
- 8 GB RAM minimum, 16 GB recommended for WhisperX large-v3.

The app does **not** install Docker for you. The **Setup** tab checks Docker status, shows whether the analysis image is present, and links to Docker Desktop if needed.

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
npm run dist:mac     # -> dist/Iowa Speech Sample-1.0.0.dmg
npm run dist:linux   # -> dist/Iowa Speech Sample-1.0.0.AppImage and .deb
```

Build outputs land in `dist/`. macOS builds are unsigned by default; for distribution, add Apple Developer credentials and rebuild with `electron-builder --mac --publish=never`.

## What the app does

| Tab | What it does |
|---|---|
| **Setup** | Detects Docker, pulls the ISS image, performs a non-blocking startup freshness check, and downloads reference data from Zenodo. |
| **Participants** | Create, list, and remove participants. Each participant gets a folder under `userData/participants/<id>`. |
| **Record** | Plays the bundled `task_video.mp4` fullscreen, records microphone audio, and saves MP3, WAV, or browser-default audio into the participant's `input/` folder. |
| **Run pipeline** | Spawns `docker run` against `melsadany/iowa_speech_sample:latest`, mounts participant input/output folders, mounts the editable config, and streams logs live in the app. |
| **Results** | Lists supported files in `output/features/`; displays `.csv` and `.tsv` files in a table viewer, and provides open-in-folder handling for `.rds`, `.json`, and `.txt`. |

## Current behavior

- The app defaults to a **light theme** and includes a theme toggle with saved preference.
- On launch, it performs a background `docker pull` freshness check without blocking the UI.
- When reference data is downloaded from Zenodo, the app automatically handles the common nested extraction layout where files end up under `reference_data/reference_data/`.
- The Results panel supports both tabular preview and file-type-specific guidance for non-tabular outputs.

## Where data lives

| Location | Contents |
|---|---|
| `userData/participants/<id>/input/` | Recorded or discovered audio files such as `<id>_<timestamp>.mp3`, plus other supported audio formats. |
| `userData/participants/<id>/output/features/` | Pipeline outputs including CSV, TSV, RDS, JSON, and TXT files. |
| `userData/reference_data/` | Zenodo reference data, including embeddings, archetypes, norms, and task metadata. |
| `userData/config/task_template.yaml` | Editable copy of the pipeline config. |
| `userData/iss_db.json` | Local index of participants and recorded sessions. |

`userData` resolves to:
- macOS — `~/Library/Application Support/Iowa Speech Sample/`
- Linux — `~/.config/Iowa Speech Sample/`

Use **File -> Open data folder** or the sidebar shortcut to jump there.

## Architecture

```text
src/
├── main/
│   ├── main.js        # Electron main: IPC, Docker, downloads, file I/O
│   └── preload.js     # contextBridge exposing window.iss.*
└── renderer/
    ├── index.html     # 5-tab UI
    ├── styles.css
    ├── renderer.js    # UI logic, WebAudio/MediaRecorder, result preview
    ├── vendor/lame.min.js
    └── assets/
        ├── task_video.mp4
        └── logo.png
resources/
└── task_template.yaml # default config copied to userData on first launch
```

The renderer does not access Node APIs directly. Privileged work such as `spawn`, file I/O, and HTTPS downloads is handled in `main.js` through the `window.iss` bridge exposed by `preload.js`.

## Reference

- Pipeline source: <https://github.com/melsadany/iss-pipeline>
- Docker image: <https://hub.docker.com/r/melsadany/iowa_speech_sample>
- Reference data: <https://zenodo.org/records/18675411>

## License

MIT.
