const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, systemPreferences, clipboard, shell, Notification } = require('electron')
const path     = require('path')
const fs       = require('fs')
const os       = require('os')
const cp       = require('child_process')
const { spawn, execSync, exec } = cp
const Store    = require('electron-store')
const OpenAI   = require('openai').default

// Common locations where pip/brew installs Python binaries on macOS
const EXTRA_PATH = [
  '/Library/Frameworks/Python.framework/Versions/3.12/bin',
  '/Library/Frameworks/Python.framework/Versions/3.11/bin',
  '/Library/Frameworks/Python.framework/Versions/3.10/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  `${os.homedir()}/.local/bin`,
  `${os.homedir()}/.pyenv/shims`,
  '/usr/bin',
].join(':')

// Allow AudioContext to start without user gesture (needed for voice)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const aiClient = new OpenAI({
  baseURL: 'http://localhost:1234/v1',
  apiKey: 'lm-studio'
})

const store = new Store({
  defaults: {
    userName: null,
    interactionCount: 0,
    firstSeen: null,
    lastSeen: null,
    activeDisplayId: null,
    visionEnabled: false
  }
})

let mainWindow = null
let tray       = null

// ── Log streaming to renderer ─────────────────────────────────────────────────
function sendLog(level, ...args) {
  const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ')
  const logLine = `[${new Date().toISOString().slice(11, 23)}] [${level.toUpperCase()}] ${message}`
  if (level === 'error') process.stderr.write(logLine + '\n')
  else process.stdout.write(logLine + '\n')
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('log-event', { level, message: logLine }) } catch {}
  }
}
const log = {
  info:  (...a) => sendLog('info',  ...a),
  warn:  (...a) => sendLog('warn',  ...a),
  error: (...a) => sendLog('error', ...a),
  debug: (...a) => sendLog('debug', ...a),
}

// ── STT daemon (mlx-whisper) ─────────────────────────────────────────────────
let sttProc  = null   // the Python STT daemon process
let sttReady = false  // true once "READY" seen on stderr
let sttBuf   = ''
// sttQueue: resolve-fns for pending transcribe-audio IPC calls (one per chunk).
// The worker thread in the daemon serialises responses in the same order as requests,
// so a simple FIFO queue is correct.
const sttQueue = []

function findPython() {
  const candidates = [
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3',
    '/opt/homebrew/Cellar/python@3.12/3.12.9/Frameworks/Python.framework/Versions/3.12/bin/python3.12',
    '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12',
    '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ]

  // Prefer the first Python that can import mlx (needed for mlx-whisper STT).
  // Falls back to any accessible Python so the daemon can at least start.
  for (const p of candidates) {
    try {
      fs.accessSync(p)
      const probe = cp.spawnSync(p, ['-c', 'import mlx'], { timeout: 3000 })
      if (probe.status === 0) return p
    } catch {}
  }
  return candidates.find(p => { try { fs.accessSync(p); return true } catch { return false } })
}

function startSttDaemon() {
  const PYTHON = findPython()
  if (!PYTHON) { log.error('[stt] No Python found'); return }

  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'moshi_server.py')
    : path.join(app.getAppPath(), 'src/moshi_server.py')
  const env = { ...process.env, PATH: `${EXTRA_PATH}:${process.env.PATH || ''}` }

  log.info('[thamma] Starting STT daemon...')
  sttProc  = spawn(PYTHON, ['-u', script], { env })
  sttReady = false

  sttProc.stdout.on('data', (data) => {
    sttBuf += data.toString()
    const lines = sttBuf.split('\n')
    sttBuf  = lines.pop()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let msg
      try { msg = JSON.parse(trimmed) } catch {
        // Plain text — treat as a transcription result for the oldest pending call
        const resolve = sttQueue.shift()
        if (resolve) resolve({ text: trimmed })
        continue
      }

      if (msg.type === 'transcription') {
        // Always resolve — even empty text must unblock the waiting IPC call.
        // Bug that was here before: `&& msg.text` meant silent chunks left
        // their resolve fns in the queue forever, desynchronising it.
        const resolve = sttQueue.shift()
        if (resolve) resolve({ text: msg.text || '' })

      } else if (msg.type === 'status') {
        log.info('[stt] status:', msg.state)
      }
    }
  })

  sttProc.stderr.on('data', (data) => {
    const msg = data.toString().trim()
    if (msg.includes('READY')) { sttReady = true; log.info('[thamma] STT daemon ready') }
    else log.info('[thamma]', msg)
  })

  sttProc.on('exit', (code) => {
    log.info('[thamma] STT daemon exited:', code)
    sttProc  = null
    sttReady = false
    // Drain the queue so callers don't wait forever
    while (sttQueue.length) sttQueue.shift()({ text: '', error: 'daemon exited' })
    setTimeout(startSttDaemon, 3000)
  })
}

// ── TTS: macOS say (only) ─────────────────────────────────────────────────────
let sayProc = null

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenW } = primaryDisplay.bounds

  const winW = 500
  const winH = 600
  const winX = Math.round((screenW - winW) / 2)

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: winX,
    y: 0,
    resizable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    skipTaskbar: true,
    roundedCorners: false,
    type: 'panel',
    hiddenInMissionControl: true,
    focusable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.setBounds({ x: winX, y: 0, width: winW, height: winH })
  mainWindow.setPosition(winX, 0, false)

  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.setBounds({ x: winX, y: 0, width: winW, height: winH })
    mainWindow.setPosition(winX, 0, false)
  })

  mainWindow.setIgnoreMouseEvents(true, { forward: true })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.session.setPermissionRequestHandler(
    (_wc, permission, callback) =>
      callback(['media', 'microphone', 'speech'].includes(permission))
  )

  mainWindow.once('ready-to-show', () => {
    mainWindow.setOpacity(0)
    mainWindow.show()
    let opacity = 0
    const fadeIn = setInterval(() => {
      opacity += 0.05
      if (opacity >= 1) { opacity = 1; clearInterval(fadeIn) }
      mainWindow.setOpacity(opacity)
    }, 20)
  })
}

function rebuildTray() {
  if (!tray) return
  const displays  = screen.getAllDisplays()
  const primary   = screen.getPrimaryDisplay()
  const activeId  = store.get('activeDisplayId') || primary.id
  const visionOn  = store.get('visionEnabled')

  const displayItems = displays.map((d, i) => ({
    label: `Display ${i + 1} (${d.size.width}x${d.size.height})${d.id === primary.id ? ' — Primary' : ''}`,
    type: 'radio',
    checked: d.id === activeId,
    click: () => {
      store.set('activeDisplayId', d.id)
      rebuildTray()
      if (mainWindow) mainWindow.webContents.send('display-changed', d.id)
    }
  }))

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show / Hide Thamma',
      click: () => {
        if (mainWindow.isVisible()) mainWindow.hide()
        else mainWindow.show()
      }
    },
    { type: 'separator' },
    {
      label: `Screen Vision: ${visionOn ? 'ON' : 'OFF'}`,
      type: 'checkbox',
      checked: visionOn,
      click: () => {
        store.set('visionEnabled', !visionOn)
        rebuildTray()
        if (mainWindow) mainWindow.webContents.send('vision-toggled', !visionOn)
      }
    },
    {
      label: 'Active Display',
      submenu: displayItems,
      enabled: visionOn
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])

  tray.setContextMenu(contextMenu)
}

function createTray() {
  let icon
  try {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'tray-icon.png')
      : path.join(__dirname, '../../resources/tray-icon.png')

    if (!fs.existsSync(iconPath)) throw new Error(`Icon not found at ${iconPath}`)

    icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) throw new Error('Icon failed to load (empty)')
  } catch (err) {
    log.warn('[tray] Icon load failed:', err.message, '— using fallback')
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAABmJLR0QA/wD/AP+gvaeTAAAAX0lEQVQ4y2NgGAWjYBSQif3//58hLS2NgYGBgYGZmZmBnp6egYGBgYGenp6BgYGBgZ6enoGBgYGBnp6egYGBgYGenp6BgYGBgZ6enoGBgYGBnp6egYGBgYGenp5BAAAZBA8DVeKprAAAAABJRU5ErkJggg=='
    )
  }

  tray = new Tray(icon)
  tray.setToolTip('Thamma — Agent')
  rebuildTray()

  tray.on('click', () => {
    if (mainWindow.isVisible()) mainWindow.hide()
    else mainWindow.show()
  })
}

// ── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('get-memory', () => ({
  userName:         store.get('userName'),
  interactionCount: store.get('interactionCount'),
  firstSeen:        store.get('firstSeen'),
  lastSeen:         store.get('lastSeen')
}))

ipcMain.handle('set-memory', (_, data) => {
  for (const [key, value] of Object.entries(data)) store.set(key, value)
  return true
})

ipcMain.handle('ask-ai', async (_, messages) => {
  const res = await aiClient.chat.completions.create({
    model: 'local-model',
    messages,
    temperature: 0.7,
    max_tokens: 1500
  })
  return res.choices[0].message.content
})

// ── Agent execution engine ───────────────────────────────────────────────────

ipcMain.handle('agent-exec', async (_, { type, payload }) => {
  const MAX_OUTPUT = 4000
  const truncate = (s) => s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n...(truncated)' : s
  try {
    switch (type) {
      case 'shell': {
        const output = execSync(payload.command, {
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          cwd: payload.cwd || os.homedir(),
          env: { ...process.env, PATH: `${EXTRA_PATH}:${process.env.PATH || ''}` },
          shell: '/bin/zsh'
        }).toString()
        return { ok: true, output: truncate(output) || '(no output)' }
      }
      case 'applescript': {
        const scriptPath = path.join(os.tmpdir(), `thamma-script-${Date.now()}.scpt`)
        fs.writeFileSync(scriptPath, payload.script, 'utf-8')
        try {
          const output = execSync(`osascript "${scriptPath}"`, {
            timeout: 30000,
            maxBuffer: 1024 * 1024
          }).toString()
          return { ok: true, output: truncate(output) || '(done)' }
        } finally {
          try { fs.unlinkSync(scriptPath) } catch {}
        }
      }
      case 'clipboard_read':
        return { ok: true, output: clipboard.readText() || '(empty)' }
      case 'clipboard_write':
        clipboard.writeText(payload.text)
        return { ok: true, output: 'Copied to clipboard.' }
      case 'notify':
        new Notification({ title: payload.title || 'Thamma', body: payload.body || '' }).show()
        return { ok: true, output: 'Notification sent.' }
      case 'open_url':
        shell.openExternal(payload.url)
        return { ok: true, output: `Opened ${payload.url}` }
      case 'screenshot':
        return captureScreenImpl()
      default:
        return { ok: false, output: `Unknown execution type: ${type}` }
    }
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().slice(0, 1500) : (err.message || String(err))
    return { ok: false, output: msg }
  }
})

// ── Screen Vision ────────────────────────────────────────────────────────────

ipcMain.handle('get-displays', () => {
  const displays = screen.getAllDisplays()
  const primary  = screen.getPrimaryDisplay()
  return displays.map((d, i) => ({
    id:        d.id,
    label:     `Display ${i + 1}${d.id === primary.id ? ' (Primary)' : ''}`,
    width:     d.size.width,
    height:    d.size.height,
    x:         d.bounds.x,
    y:         d.bounds.y,
    isPrimary: d.id === primary.id,
    isActive:  d.id === (store.get('activeDisplayId') || primary.id),
  }))
})

ipcMain.handle('set-active-display', (_, displayId) => {
  store.set('activeDisplayId', displayId)
  rebuildTray()
  return true
})

ipcMain.handle('get-vision-enabled', () => store.get('visionEnabled'))
ipcMain.handle('set-vision-enabled', (_, enabled) => {
  store.set('visionEnabled', enabled)
  rebuildTray()
  return true
})

async function captureScreenImpl() {
  if (!store.get('visionEnabled')) return { ok: false, output: 'Vision is disabled. User must enable it from the tray menu.' }

  const screenAccess = systemPreferences.getMediaAccessStatus('screen')
  if (screenAccess !== 'granted') {
    try { exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"') } catch {}
    return {
      ok: false,
      output: `Screen Recording permission not granted (status: ${screenAccess}). macOS requires you to allow Thamma (Electron) in System Settings → Privacy & Security → Screen Recording.`
    }
  }

  const displays   = screen.getAllDisplays()
  const primary    = screen.getPrimaryDisplay()
  const activeId   = store.get('activeDisplayId') || primary.id
  const dispIndex  = displays.findIndex(d => d.id === activeId)
  const displayNum = dispIndex >= 0 ? dispIndex + 1 : 1

  const tmpRaw     = path.join(os.tmpdir(), `thamma-screen-raw-${Date.now()}.png`)
  const tmpResized = path.join(os.tmpdir(), `thamma-screen-${Date.now()}.jpg`)

  try {
    try {
      execSync(`screencapture -D ${displayNum} -x -t png "${tmpRaw}"`, { timeout: 10000 })
    } catch {
      execSync(`screencapture -x -t png "${tmpRaw}"`, { timeout: 10000 })
    }

    if (!fs.existsSync(tmpRaw) || fs.statSync(tmpRaw).size < 100) {
      return { ok: false, output: 'Screenshot captured an empty image.' }
    }

    const activeDisplay = displays[dispIndex] || primary
    const logicalW      = activeDisplay.size.width
    const logicalH      = activeDisplay.size.height
    const scaleFactor   = activeDisplay.scaleFactor || 1

    const rawInfo = execSync(`sips --getProperty pixelWidth --getProperty pixelHeight "${tmpRaw}"`, { encoding: 'utf8' })
    const physW = parseInt((rawInfo.match(/pixelWidth:\s*(\d+)/)||[])[1]  || '0', 10)
    const physH = parseInt((rawInfo.match(/pixelHeight:\s*(\d+)/)||[])[1] || '0', 10)

    log.info(`[screenshot] display=${displayNum} scaleFactor=${scaleFactor}`)
    log.info(`[screenshot]   Electron logical: ${logicalW}×${logicalH}`)
    log.info(`[screenshot]   Physical capture: ${physW}×${physH}`)

    execSync(
      `sips -z ${logicalH} ${logicalW} -s format jpeg -s formatOptions 70 "${tmpRaw}" --out "${tmpResized}" 2>/dev/null`,
      { timeout: 10000 }
    )

    const resizedInfo = execSync(`sips --getProperty pixelWidth --getProperty pixelHeight "${tmpResized}"`, { encoding: 'utf8' })
    const resW = parseInt((resizedInfo.match(/pixelWidth:\s*(\d+)/)||[])[1]  || '0', 10)
    const resH = parseInt((resizedInfo.match(/pixelHeight:\s*(\d+)/)||[])[1] || '0', 10)

    if (resW !== logicalW || resH !== logicalH) {
      log.warn(`[screenshot] MISMATCH: sips output ${resW}×${resH} but logical is ${logicalW}×${logicalH}`)
    } else {
      log.info(`[screenshot] Output: ${resW}×${resH} — exact 1:1 match`)
    }

    const imgBuffer = fs.readFileSync(tmpResized)
    const base64    = imgBuffer.toString('base64')

    return {
      ok: true,
      isImage: true,
      image: `data:image/jpeg;base64,${base64}`,
      width:  resW,
      height: resH,
      displayNum,
    }
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : err.message
    return { ok: false, output: msg }
  } finally {
    try { fs.unlinkSync(tmpRaw) } catch {}
    try { fs.unlinkSync(tmpResized) } catch {}
  }
}

ipcMain.handle('capture-screen', captureScreenImpl)

// ── Keyboard control ─────────────────────────────────────────────────────────

ipcMain.handle('keyboard-action', (_, { action, text, key, modifiers }) => {
  try {
    let script = ''
    switch (action) {
      case 'type':
        script = `tell application "System Events" to keystroke ${JSON.stringify(text)}`
        break
      case 'hotkey':
        if (modifiers && modifiers.length > 0) {
          const mods = modifiers.map(m => `${m} down`).join(', ')
          if (typeof key === 'number') {
            script = `tell application "System Events" to key code ${key} using {${mods}}`
          } else {
            script = `tell application "System Events" to keystroke "${key}" using {${mods}}`
          }
        } else {
          if (typeof key === 'number') {
            script = `tell application "System Events" to key code ${key}`
          } else {
            script = `tell application "System Events" to keystroke "${key}"`
          }
        }
        break
      case 'keycode':
        script = `tell application "System Events" to key code ${key}`
        break
      default:
        return { ok: false, output: `Unknown keyboard action: ${action}` }
    }
    execSync(`osascript -e ${JSON.stringify(script)}`, { timeout: 5000 })
    return { ok: true, output: `Keyboard ${action}: ${text || key}` }
  } catch (err) {
    return { ok: false, output: err.message }
  }
})

ipcMain.handle('get-system-context', () => {
  const displays = screen.getAllDisplays()
  const primary  = screen.getPrimaryDisplay()
  const activeId = store.get('activeDisplayId') || primary.id
  const activeDisp = displays.find(d => d.id === activeId) || primary
  return {
    username: os.userInfo().username,
    homedir: os.homedir(),
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    shell: process.env.SHELL || '/bin/zsh',
    visionEnabled: store.get('visionEnabled'),
    activeDisplay: {
      width:  activeDisp.size.width,
      height: activeDisp.size.height,
      id:     activeDisp.id,
    },
    displayCount: displays.length,
  }
})

ipcMain.handle('set-ignore-mouse', (_, ignore) => {
  if (mainWindow) mainWindow.setIgnoreMouseEvents(ignore, { forward: true })
})

ipcMain.handle('get-cursor-pos', () => screen.getCursorScreenPoint())

ipcMain.handle('request-mic-permission', () =>
  systemPreferences.askForMediaAccess('microphone')
)

// ── Renderer → main log bridge ───────────────────────────────────────────────
// Lets useVoice.js / renderer code post messages to the main LOG panel.
ipcMain.handle('log-renderer', (_, msg) => {
  log.debug('[renderer]', msg)
})

// ── Audio transcription via STT daemon ────────────────────────────────────────
ipcMain.handle('transcribe-audio', (_, audioData) => {
  // Diagnostic: log every incoming call so we can see the IPC is arriving.
  const byteLen = audioData ? (audioData.byteLength ?? audioData.length ?? 0) : 0
  if (!sttProc || !sttReady) {
    log.warn(`[stt] transcribe-audio called but daemon not ready (sttProc=${!!sttProc} sttReady=${sttReady}) — audio ${byteLen}B`)
    return { text: '', error: 'STT daemon not ready' }
  }
  log.debug(`[stt] transcribe-audio → ${byteLen}B queued (queue depth ${sttQueue.length + 1})`)

  // Convert incoming TypedArray/Buffer to base64.
  // audioData arrives as Uint8Array from the renderer via structured-clone IPC.
  let buf
  try {
    buf = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData)
  } catch (err) {
    log.error('[stt] Buffer.from failed:', err.message, 'type:', typeof audioData)
    return { text: '', error: 'bad audio data' }
  }
  const b64 = buf.toString('base64')

  return new Promise((resolve) => {
    // Safety timeout: if the daemon doesn't respond within 20 s, unblock the
    // wake loop with empty text so recording continues.
    const timer = setTimeout(() => {
      log.warn('[stt] transcribe-audio TIMEOUT after 20s')
      resolve({ text: '', error: 'timeout' })
    }, 20000)
    sttQueue.push((result) => {
      clearTimeout(timer)
      log.debug(`[stt] transcription result: "${result.text?.slice(0, 60) || ''}" ${result.error ? '(err: ' + result.error + ')' : ''}`)
      resolve(result)
    })
    sttProc.stdin.write(JSON.stringify({ type: 'transcribe', audio: b64 }) + '\n')
  })
})

// ── Speech synthesis — macOS say only ────────────────────────────────────────
ipcMain.handle('synthesize-speech', async (_, text) => {
  if (sayProc) { try { sayProc.kill() } catch {} sayProc = null }

  const cleanText = text.replace(/[\r\n]+/g, ' ').trim()
  if (!cleanText) return { done: true }

  return new Promise((resolve) => {
    sayProc = spawn('say', ['-r', '190', cleanText])
    sayProc.on('close', () => { sayProc = null; resolve({ done: true }) })
    sayProc.on('error', (err) => { sayProc = null; resolve({ done: false, error: err.message }) })
  })
})

ipcMain.handle('stop-speech', () => {
  if (sayProc) { try { sayProc.kill() } catch {} sayProc = null }
  return true
})

// ── Boot ─────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  startSttDaemon()
  createWindow()
  createTray()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  if (sttProc) { sttProc.removeAllListeners('exit'); sttProc.kill() }
  if (sayProc) { try { sayProc.kill() } catch {} }
})
