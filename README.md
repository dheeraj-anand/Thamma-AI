<p align="center">
  <img src="resources/icon.iconset/icon_128x128.png" width="96" alt="Thamma" />
</p>

<h1 align="center">Thamma</h1>

<p align="center">
  <strong>A fully local AI agent that lives in your MacBook notch</strong><br/>
  Voice-activated. Always listening. Never leaves your Mac.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%28Apple%20Silicon%29-000?style=flat-square&logo=apple" />
  <img src="https://img.shields.io/badge/runtime-Electron%2035-47848F?style=flat-square&logo=electron" />
  <img src="https://img.shields.io/badge/STT-mlx--whisper-ff6600?style=flat-square" />
  <img src="https://img.shields.io/badge/LLM-LM%20Studio-00cc38?style=flat-square" />
  <img src="https://img.shields.io/badge/100%25-local-blue?style=flat-square" />
</p>

---

## What is Thamma?

Thamma is a voice-first AI assistant built into your MacBook's notch. Say *"Hey Thamma"* and he listens, thinks, speaks back, and can control your Mac — all without sending a single byte to the cloud.

### Highlights

- **Lives in the notch** — transparent, frameless, always-on-top; zero taskbar clutter
- **Wake word detection** — fully offline via [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) (Apple Silicon MLX)
- **Voice replies** — spoken aloud via macOS `say` (no cloud TTS)
- **Local LLM** — powered by any model running in [LM Studio](https://lmstudio.ai)
- **Mac agent** — runs shell commands, AppleScript, keyboard shortcuts, clipboard ops
- **Plan before acting** — always proposes a plan and waits for your approval
- **Interrupt anytime** — tap the face while he's talking to cut him off
- **Screen vision** — optional: let Thamma take a screenshot to see what you're doing
- **100% private** — everything runs on your Mac, offline

---

## Requirements

| | Minimum |
|---|---|
| **Mac** | Apple Silicon (M1 / M2 / M3 / M4) |
| **macOS** | Ventura 13.0+ |
| **Node.js** | v18+ |
| **Python** | 3.10 / 3.11 / 3.12 with `mlx-whisper` |
| **LM Studio** | Any version, any instruction-tuned model |

> **Intel Macs are not supported.** `mlx-whisper` requires the Apple Neural Engine / MLX framework. For Intel, you could swap it for `whisper.cpp` with minor changes to `src/moshi_server.py`.

---

## Installation

### Step 1 — Clone

```bash
git clone https://github.com/yourusername/thamma.git
cd thamma
```

### Step 2 — Install Node dependencies

```bash
npm install
```

### Step 3 — Install Python speech-to-text

```bash
pip install mlx-whisper
```

On first launch, mlx-whisper will download the `whisper-tiny.en` model (~40 MB) from HuggingFace and cache it. Every launch after that is instant.

> **Tip:** If `pip` maps to Python 2, use `pip3` or `python3 -m pip`.

### Step 4 — Set up LM Studio

1. Download [LM Studio](https://lmstudio.ai) and open it
2. Search for and download any instruction-tuned model — good starting points:
   - `Llama 3.2 3B Instruct` (fast, small)
   - `Mistral 7B Instruct` (balanced)
   - `Phi-3 Mini` (very fast on Apple Silicon)
3. Go to the **Local Server** tab → click **Start Server**
4. Confirm it's listening on `http://localhost:1234` (the default)

### Step 5 — Run

```bash
# Development mode (hot-reload, DevTools available)
npm run dev

# Production build (outputs to out/)
npm run build

# Build + package as .dmg
npm run package
```

---

## First Launch

1. A small green bot face appears in the notch area at the top of your screen
2. macOS will ask for **microphone permission** — click Allow
3. Wait ~3 seconds for the STT daemon to load
4. Say **"Hey Thamma"** — he'll respond through your speakers

---

## Usage

### Voice

| Say | What happens |
|---|---|
| **"Hey Thamma"** | Activates — he listens for your question |
| **"Hey Thamma, open Spotify"** | Wake word + inline command in one |
| **"yes" / "go ahead"** | Approve a pending plan |
| **"no" / "cancel"** | Deny a pending plan |

### Mouse

| Action | How |
|---|---|
| Open chat panel | Click the bot face |
| Interrupt speech | Click the bot face while he's talking |
| Close chat | Click ✕, or click the bot face again |
| Stop agent mid-task | Click **■ stop** inside the chat |
| View debug logs | Chat → **LOG** button |

### Tray icon (menu bar)

Right-click the Thamma icon to:
- Toggle **Screen Vision** on/off
- Choose which display to capture
- Quit

---

## How It Works

```
You speak
  └─▶ MediaRecorder  (3-second WebM/Opus chunks, mic always open)
        └─▶ mlx-whisper  (Python daemon, local, offline)
              └─▶ Wake word matched → "Hey Thamma"
                    └─▶ Follow-up recording  (up to 8 s)
                          └─▶ LM Studio  (local LLM, OpenAI-compatible API)
                                └─▶ macOS `say`  (TTS, no cloud)
                                      └─▶ Back to wake detection
```

Everything stays on your Mac.

---

## Project Structure

```
thamma/
├── src/
│   ├── main.js              # Electron main — IPC, STT daemon, TTS, agent
│   ├── preload.js           # Context bridge (renderer ↔ main)
│   ├── moshi_server.py      # Python STT daemon (mlx-whisper)
│   └── renderer/
│       ├── App.jsx          # Main React component — UI + agent loop
│       ├── NotchBot.jsx     # Animated bot face
│       ├── useVoice.js      # Wake word detection + query recording
│       ├── useTalk.js       # Typewriter animation
│       ├── useMood.js       # Bot mood state machine
│       ├── useMemory.js     # Persistent memory (electron-store)
│       ├── styles.css       # All UI styles
│       └── main.jsx         # React entry point
├── resources/
│   ├── icon.icns            # macOS app icon
│   ├── icon.iconset/        # Icon source PNGs (all sizes)
│   ├── tray-icon.png        # Menu bar icon
│   └── tray-icon@2x.png    # Retina menu bar icon
├── index.html               # Renderer HTML shell
├── electron.vite.config.js  # Build config
└── package.json
```

---

## Permissions

| Permission | Required for |
|---|---|
| **Microphone** | Wake word + voice queries |
| **Accessibility** | Keyboard control via AppleScript (only if you use keyboard actions) |
| **Screen Recording** | Screenshot capture for screen vision (optional, off by default) |

macOS prompts for microphone on first launch. Accessibility and Screen Recording must be granted manually in **System Settings → Privacy & Security** if needed.

---

## Customisation

### Change the LLM endpoint

Edit `src/main.js`:
```js
const aiClient = new OpenAI({
  baseURL: 'http://localhost:1234/v1',  // any OpenAI-compatible server
  apiKey:  'lm-studio'
})
```

### Change the Whisper model

Edit `src/moshi_server.py`:
```python
WHISPER_REPO = 'mlx-community/whisper-tiny.en-mlx'   # fastest (recommended)
# WHISPER_REPO = 'mlx-community/whisper-base.en-mlx'  # more accurate
# WHISPER_REPO = 'mlx-community/whisper-small.en-mlx' # even better, slower
```

### Change the wake word

Edit `WAKE_VARIANTS` and `FUZZY_WAKE` in `src/renderer/useVoice.js`.

### Change the TTS voice / speed

Edit the `synthesize-speech` handler in `src/main.js`:
```js
sayProc = spawn('say', ['-r', '190', '-v', 'Daniel', cleanText])
// -r  words per minute (default 190)
// -v  voice name — run `say -v '?'` in Terminal to list all voices
```

### Change the AI persona

Edit `AGENT_PROMPT` at the top of `src/renderer/App.jsx`.

---

## Troubleshooting

### "Hey Thamma" does nothing

Open the chat (click the bot face) and check the **voice status badge**:

| Status | Meaning |
|---|---|
| `starting…` | STT daemon is loading — wait ~3 s |
| `ready — say "hey thamma"` | Listening correctly |
| `mic denied` | Grant mic permission in System Settings → Privacy → Microphone |
| `mic error: …` | MediaRecorder failed — check the LOG panel |

Click **LOG** in the chat header for a live stream of transcription output.

### Thamma hears me but doesn't respond

- Make sure LM Studio is running with a model loaded on port 1234
- Check **System Settings → Privacy → Microphone** to confirm Thamma has access

### App is blocked by Gatekeeper

Right-click `Thamma.app` → **Open** → **Open**. Only needed once.

### Python / mlx-whisper not found

```bash
# Verify your Python has mlx-whisper
python3 -c "import mlx_whisper; print('ok')"
```

If it fails, install it: `pip install mlx-whisper`. If Thamma can't find your Python, add its path to the `candidates` list in `findPython()` inside `src/main.js`.

### Voice responses are too fast / slow

Change the `-r` flag in `synthesize-speech` in `src/main.js` (default is `190` wpm).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 35 |
| UI | React 18 + Vite |
| STT | mlx-whisper (Apple Silicon MLX) |
| LLM | LM Studio (OpenAI-compatible local API) |
| TTS | macOS `say` |
| Persistence | electron-store |
| Build | electron-vite + electron-builder |

---

## Contributing

Pull requests are welcome. For large changes, open an issue first.

```bash
npm run dev   # hot-reload dev mode
```

The renderer is React + Vite. The main process is plain Node.js. The STT daemon is a single Python file with no build step — edit and restart the app.

---

## License

MIT
