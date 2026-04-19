const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('thammaAPI', {
  // Memory
  getMemory:            ()          => ipcRenderer.invoke('get-memory'),
  setMemory:            (data)      => ipcRenderer.invoke('set-memory', data),

  // AI
  askAI:                (messages)  => ipcRenderer.invoke('ask-ai', messages),

  // Window / mouse
  setIgnoreMouse:       (ignore)    => ipcRenderer.invoke('set-ignore-mouse', ignore),
  getCursorPos:         ()          => ipcRenderer.invoke('get-cursor-pos'),

  // Microphone & STT
  requestMicPermission: ()          => ipcRenderer.invoke('request-mic-permission'),
  transcribeAudio:      (audioData) => ipcRenderer.invoke('transcribe-audio', audioData),

  // TTS
  synthesizeSpeech:     (text)      => ipcRenderer.invoke('synthesize-speech', text),
  stopSpeech:           ()          => ipcRenderer.invoke('stop-speech'),

  // Agent execution
  agentExec:            (action)    => ipcRenderer.invoke('agent-exec', action),
  getSystemContext:     ()          => ipcRenderer.invoke('get-system-context'),

  // Screen vision
  getDisplays:          ()          => ipcRenderer.invoke('get-displays'),
  setActiveDisplay:     (id)        => ipcRenderer.invoke('set-active-display', id),
  captureScreen:        ()          => ipcRenderer.invoke('capture-screen'),
  getVisionEnabled:     ()          => ipcRenderer.invoke('get-vision-enabled'),
  setVisionEnabled:     (on)        => ipcRenderer.invoke('set-vision-enabled', on),

  // Keyboard control
  keyboardAction:       (params)    => ipcRenderer.invoke('keyboard-action', params),

  // Debug logging bridge (renderer → main LOG panel)
  logRenderer:          (msg)       => ipcRenderer.invoke('log-renderer', msg),

  // Events from main process
  onDisplayChanged:     (cb)        => ipcRenderer.on('display-changed', (_, id) => cb(id)),
  onVisionToggled:      (cb)        => ipcRenderer.on('vision-toggled', (_, on) => cb(on)),
  onLog:                (cb)        => ipcRenderer.on('log-event', (_, entry) => cb(entry)),
})
