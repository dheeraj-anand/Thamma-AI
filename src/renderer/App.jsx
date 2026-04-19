import React, { useState, useEffect, useRef, useCallback } from 'react'
import NotchBot from './NotchBot'
import useTalk from './useTalk'
import useMood from './useMood'
import useMemory from './useMemory'
import useVoice from './useVoice'

const AGENT_PROMPT = `You are Thamma — a warm, capable and respectful AI assistant living in Anna's MacBook notch.
You can SEE the screen, TYPE on the keyboard, RUN commands, and control apps using AppleScript.
You genuinely care about helping Anna and making her day easier. You are male.

## PERSONALITY
Friendly, warm, and encouraging. Always address the user as "Anna" — never use any other name.
You're subtly Matrix-themed but never let the theme override being genuinely useful.
Keep every response SHORT and PRECISE — one or two sentences max for simple answers, brief bullet points for lists.
Never use emojis. Ever. Plain text only.
Acknowledge what Anna says before acting. Never be dismissive. If you can't do something, explain clearly and suggest alternatives.

## CRITICAL RULE — ALWAYS ASK BEFORE ACTING
Before executing ANY action (shell command, AppleScript, keyboard input, screenshot, URL open, clipboard, notification),
you MUST first explain your plan to the user in plain language, then WAIT for their approval.

Format your plan like this:
<<<PLAN>>>
Here's what I'd like to do:
1. [Step 1 description]
2. [Step 2 description]
...
Shall I go ahead?
<<<END_PLAN>>>

Do NOT include any ACTION blocks in the same response as a PLAN.
Only after the user says "yes", "go ahead", "approved", "do it", or similar confirmation,
should you proceed with ACTION blocks in your next response.

If the user says "no", "don't", "cancel", or similar rejection, acknowledge it and ask what they'd like instead.

## YOUR CAPABILITIES — Action blocks (only use AFTER user approval)

### SHELL — Run any terminal command
<<<ACTION:shell>>>{"command": "ls -la ~/Desktop"}<<<END>>>

### APPLESCRIPT — Control any app, UI elements, system settings
<<<ACTION:applescript>>>{"script": "tell application \\"Safari\\" to activate"}<<<END>>>

### SCREENSHOT — See the screen (requires vision to be enabled by user)
<<<ACTION:screenshot>>>{}<<<END>>>
Returns an image of the active display resized to EXACTLY the logical screen dimensions.
Use this to see current app state, read content, and verify your actions worked.

### KEYBOARD — Type text, press shortcuts
<<<ACTION:keyboard>>>{}<<<END>>>
<<<ACTION:keyboard>>>{"action":"type","text":"Hello world"}<<<END>>>
<<<ACTION:keyboard>>>{"action":"hotkey","key":"c","modifiers":["command"]}<<<END>>>
<<<ACTION:keyboard>>>{"action":"hotkey","key":"v","modifiers":["command"]}<<<END>>>
<<<ACTION:keyboard>>>{"action":"hotkey","key":"s","modifiers":["command"]}<<<END>>>
<<<ACTION:keyboard>>>{"action":"hotkey","key":"a","modifiers":["command"]}<<<END>>>
<<<ACTION:keyboard>>>{"action":"keycode","key":36}<<<END>>>
Key codes: 36=Return, 53=Escape, 48=Tab, 51=Delete, 49=Space, 123=Left, 124=Right, 125=Down, 126=Up

### UTILITIES
<<<ACTION:clipboard_read>>>{}<<<END>>>
<<<ACTION:clipboard_write>>>{"text":"hello"}<<<END>>>
<<<ACTION:notify>>>{"title":"Thamma","body":"Task done!"}<<<END>>>
<<<ACTION:open_url>>>{"url":"https://..."}<<<END>>>

## HOW TO WORK WITH THE SCREEN
1. First, explain your plan and wait for approval
2. Take a screenshot to see the current state
3. Analyze what's on screen — identify text fields, windows, menus
4. Use keyboard shortcuts and AppleScript to interact — open apps, navigate, type
5. Take another screenshot to verify your actions worked
6. Continue until the task is complete

## RULES
- ALWAYS explain your plan first and wait for user approval before any actions.
- You can use MULTIPLE actions in one response. They execute in order.
- After actions run, you receive results and can take MORE actions.
- THINK step by step. Break complex tasks into small steps.
- Always acknowledge the user's request kindly before acting.
- If something fails, explain what happened and try a different approach.
- When DONE, give the user a clear, friendly summary of what was accomplished.
- For simple chat, respond warmly and naturally — no action blocks needed.

## TIPS
- Open app: open -a "AppName" or tell application "AppName" to activate
- Close app: tell application "AppName" to quit
- Click UI element: tell application "System Events" to tell process "AppName" to click button "X" of window 1
- Get frontmost app: tell application "System Events" to get name of first process whose frontmost is true
- Keystroke: tell application "System Events" to keystroke "v" using command down
- Volume: set volume output volume 50
- Dark mode: tell application "System Events" to tell appearance preferences to set dark mode to true
- Kill app: pkill -x "AppName"
- Find files: find ~/Documents -name "*.pdf" -maxdepth 3
- Processes: ps aux | grep -i name`

const GREETINGS = [
  "Hey Anna, what can I help you with?",
  "Hi Anna, ready when you are.",
  "Anna, what do you need?",
  "Good to see you, Anna. What's on your mind?",
  "Anna, I'm here. What would you like to do?",
  "Welcome back, Anna. What can I take off your plate?",
  "Anna, all yours. What do you need help with?",
  "Hi Anna, what would you like to tackle?"
]

const IDLE_QUIPS = [
  "Anna, still here whenever you need me.",
  "No rush, Anna — I'm here when you're ready.",
  "Anna, feel free to ask me anything.",
  "Just checking in, Anna. Everything going okay?",
  "Anna, ready to help whenever you are.",
  "Here if you need me, Anna."
]

const NOTCH_W = 400, CHAT_H = 480

export default function App() {
  const { isTalking, isTyping, displayText, typeText } = useTalk()
  const { mood, onUserInput } = useMood()
  const { memory, loaded, updateMemory } = useMemory()

  const speakRef            = useRef(() => {})
  const handleVoiceQueryRef = useRef(() => {})
  const sendMessageRef      = useRef(() => {})
  // Abort token for the currently-running speak() call — set to { aborted: true }
  // by handleInterrupt() so speak() skips its post-speech silence gap.
  const speakAbortRef       = useRef(null)

  const { isListening, voiceStatus, pauseVoice, resumeVoice, enterFollowUpMode } = useVoice({
    onQuery: (t) => handleVoiceQueryRef.current(t)
  })

  const [input, setInput]               = useState('')
  const [messages, setMessages]         = useState([])
  const [loading, setLoading]           = useState(false)
  const [isHappy, setIsHappy]           = useState(false)
  const [chatOpen, setChatOpen]         = useState(false)
  const [botVisible, setBotVisible]     = useState(false)
  const [notchHover, setNotchHover]     = useState(false)
  const [logsOpen, setLogsOpen]         = useState(false)
  const [logs, setLogs]                 = useState([])
  const [pendingPlan, setPendingPlan]   = useState(null)
  const logsEndRef = useRef(null)

  const abortRef        = useRef(false)
  const containerRef    = useRef(null)
  const inputRef        = useRef(null)
  const chatOpenRef     = useRef(chatOpen)
  const pendingPlanRef  = useRef(null)   // mirror of pendingPlan for the hover loop
  const happyTimerRef   = useRef(null)
  const idleTimerRef    = useRef(null)
  const botHideTimerRef = useRef(null)
  const lastActivityRef = useRef(Date.now())
  const startupDone     = useRef(false)

  useEffect(() => { chatOpenRef.current    = chatOpen    }, [chatOpen])
  useEffect(() => { pendingPlanRef.current = pendingPlan }, [pendingPlan])

  useEffect(() => {
    window.thammaAPI?.onLog?.((entry) => {
      setLogs(prev => {
        const next = [...prev, entry]
        return next.length > 200 ? next.slice(-200) : next
      })
    })
  }, [])

  useEffect(() => {
    if (logsOpen) logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, logsOpen])

  useEffect(() => {
    if (chatOpen) { const t = setTimeout(() => inputRef.current?.focus(), 400); return () => clearTimeout(t) }
  }, [chatOpen])

  const displayMood = isHappy ? 'happy' : mood

  const triggerHappy = useCallback(() => {
    if (happyTimerRef.current) clearTimeout(happyTimerRef.current)
    setIsHappy(true)
    happyTimerRef.current = setTimeout(() => setIsHappy(false), 4000)
  }, [])

  // ── TTS — macOS say via main process ─────────────────────────────────────
  // speak() is intentionally fire-and-forget in action loops so the agent
  // can continue executing while Thamma speaks.  The abort token lets
  // handleInterrupt() cut the post-speech silence gap short.
  const speak = useCallback(async (text) => {
    const ctl = { aborted: false }
    speakAbortRef.current = ctl
    try {
      pauseVoice()
      await window.thammaAPI.synthesizeSpeech(text)
      // Brief silence after speech so the mic doesn't immediately pick up
      // speaker echo.  Skipped when the user interrupts (ctl.aborted = true).
      if (!ctl.aborted) await new Promise(r => setTimeout(r, 350))
    } catch (err) {
      console.error('[tts]', err)
    } finally {
      resumeVoice()
      enterFollowUpMode()
    }
  }, [pauseVoice, resumeVoice, enterFollowUpMode])
  speakRef.current = speak

  // ── Interrupt — stops speech + agent, resumes mic immediately ────────────
  const handleInterrupt = useCallback(() => {
    // Mark the current speak() call as aborted so it skips its silence gap
    if (speakAbortRef.current) speakAbortRef.current.aborted = true
    // Abort the agent loop
    abortRef.current = true
    // Kill say
    window.thammaAPI.stopSpeech?.()
    // Mic will resume via speak()'s finally → resumeVoice → enterFollowUpMode.
    // Nothing more needed here.
  }, [])

  // ── Notch hover detection ─────────────────────────────────────────────────
  useEffect(() => {
    let lastOver = false
    const poll = setInterval(async () => {
      try {
        const c       = await window.thammaAPI.getCursorPos()
        const centerX = window.screenX + Math.round(window.innerWidth / 2)
        const topY    = window.screenY

        const botVisibleNow  = chatOpenRef.current || lastOver
        const chatOpenNow    = chatOpenRef.current
        const hasPendingPlan = !!pendingPlanRef.current && !chatOpenNow
        // Approval bar: top 50px, ~40px tall → bottom at ~90px.
        // Expand zone so clicks on Yes/No buttons aren't forwarded to the desktop.
        const halfLeft  = chatOpenNow ? 260 : (botVisibleNow ? 260 : 110)
        const halfRight = chatOpenNow ? 260 : (hasPendingPlan ? 180 : 110)
        const zoneH     = chatOpenNow ? 700 : (hasPendingPlan ? 150 : 64)

        const over =
          c.x >= centerX - halfLeft &&
          c.x <= centerX + halfRight &&
          c.y >= topY &&
          c.y <= topY + zoneH

        if (over !== lastOver) {
          lastOver = over
          window.thammaAPI.setIgnoreMouse(!over)
          setNotchHover(over)
        }
      } catch {}
    }, 30)
    return () => clearInterval(poll)
  }, [])

  // ── Show / hide bot face ───────────────────────────────────────────────────
  useEffect(() => {
    if (notchHover || isListening || isTalking || loading) {
      if (botHideTimerRef.current) { clearTimeout(botHideTimerRef.current); botHideTimerRef.current = null }
      setBotVisible(true)
    } else if (!chatOpen) {
      botHideTimerRef.current = setTimeout(() => {
        if (!chatOpenRef.current) setBotVisible(false)
      }, 700)
    }
  }, [notchHover, chatOpen, isListening, isTalking, loading])

  // ── Notch click ───────────────────────────────────────────────────────────
  // • While talking or loading → INTERRUPT (highest priority)
  // • Otherwise → toggle chat panel
  const handleNotchClick = useCallback(() => {
    if (isTalking || loading) {
      handleInterrupt()
      return
    }
    setChatOpen(o => !o)
  }, [isTalking, loading, handleInterrupt])

  // ── AI Agent Loop ─────────────────────────────────────────────────────────
  const sysContextRef = useRef(null)
  const [visionEnabled, setVisionEnabled] = useState(false)

  useEffect(() => {
    window.thammaAPI.getSystemContext().then(ctx => { sysContextRef.current = ctx; setVisionEnabled(ctx.visionEnabled) })
    window.thammaAPI.onVisionToggled?.((on) => setVisionEnabled(on))
  }, [])

  const buildMessages = useCallback((history) => {
    const sys = sysContextRef.current || {}
    const disp = sys.activeDisplay || {}
    const ctx = [
      `User: ${memory.userName || 'unknown'}`,
      `macOS user: ${sys.username || '?'}, home: ${sys.homedir || '?'}, host: ${sys.hostname || '?'}`,
      `Screen vision: ${sys.visionEnabled ? 'ENABLED' : 'DISABLED (user must enable via tray icon)'}`,
      `Active display: ${disp.width || '?'}x${disp.height || '?'} (${sys.displayCount || 1} display${(sys.displayCount || 1) > 1 ? 's' : ''})`,
      `Mood: ${mood}, interactions: ${memory.interactionCount}`,
    ].join('. ')
    return [{ role: 'system', content: `${AGENT_PROMPT}\n\n## CONTEXT\n${ctx}` }, ...history.slice(-20)]
  }, [mood, memory])

  const parseActions = useCallback((text) => {
    const regex = /<<<ACTION(?::(\w+))?>>>(.*?)<<<END>>>/gs
    const actions = []
    let cleanText = text
    let match
    while ((match = regex.exec(text)) !== null) {
      cleanText = cleanText.replace(match[0], '').trim()
      try {
        const type = match[1] || 'shell'
        const payload = JSON.parse(match[2])
        actions.push({ type, payload })
      } catch (err) {
        actions.push({ type: 'error', payload: {}, error: err.message })
      }
    }
    return { cleanText, actions }
  }, [])

  const parsePlan = useCallback((text) => {
    const planRegex = /<<<PLAN>>>([\s\S]*?)<<<END_PLAN>>>/g
    const match = planRegex.exec(text)
    if (match) {
      const planText = match[1].trim()
      const cleanText = text.replace(match[0], '').trim()
      return { planText, cleanText, hasPlan: true }
    }
    return { planText: null, cleanText: text, hasPlan: false }
  }, [])

  const execAction = useCallback(async (action) => {
    if (action.type === 'error') return { ok: false, output: `Parse error: ${action.error}` }
    switch (action.type) {
      case 'screenshot':
        return window.thammaAPI.captureScreen()
      case 'keyboard':
        return window.thammaAPI.keyboardAction(action.payload)
      default:
        return window.thammaAPI.agentExec({ type: action.type, payload: action.payload })
    }
  }, [])

  const MAX_AGENT_STEPS = 12

  const stopAgent = useCallback(() => {
    abortRef.current = true
    window.thammaAPI.stopSpeech()
    setPendingPlan(null)
  }, [])

  const approvePlan = useCallback(() => {
    if (!pendingPlan) return
    const { resolve } = pendingPlan
    setPendingPlan(null)
    resolve(true)
  }, [pendingPlan])

  const denyPlan = useCallback(() => {
    if (!pendingPlan) return
    const { resolve } = pendingPlan
    setPendingPlan(null)
    resolve(false)
  }, [pendingPlan])

  const sendMessage = useCallback(async (userText, history) => {
    const updated = [...history, { role: 'user', content: userText }]
    setMessages(updated)
    setLoading(true)
    abortRef.current = false

    try { sysContextRef.current = await window.thammaAPI.getSystemContext() } catch {}

    let conversation = [...updated]
    let finalText = ''
    let step = 0

    try {
      while (step < MAX_AGENT_STEPS) {
        if (abortRef.current) { finalText = 'Stopped.'; break }

        step++
        const reply = await window.thammaAPI.askAI(buildMessages(conversation))

        if (abortRef.current) { finalText = 'Stopped.'; break }

        const { planText, cleanText: textAfterPlan, hasPlan } = parsePlan(reply)

        if (hasPlan && planText) {
          const planDisplay = textAfterPlan ? `${textAfterPlan}\n\n${planText}` : planText
          speakRef.current(planDisplay)
          await typeText(planDisplay)
          // Keep bot face visible — floating approval bar handles the rest,
          // no need to open the chat panel.
          setBotVisible(true)

          const approved = await new Promise((resolve) => {
            setPendingPlan({ planText, resolve })
          })

          if (!approved) {
            conversation = [
              ...conversation,
              { role: 'assistant', content: reply },
              { role: 'user', content: 'No, please don\'t do that. Let me know what else you can help with.' }
            ]
            continue
          }

          conversation = [
            ...conversation,
            { role: 'assistant', content: reply },
            { role: 'user', content: 'Yes, go ahead.' }
          ]
          continue
        }

        const { cleanText, actions } = parseActions(reply)

        if (actions.length === 0) {
          finalText = cleanText || reply
          break
        }

        if (cleanText) {
          speakRef.current(cleanText)
          await typeText(cleanText)
        }

        const textResults = []
        let screenshotImage = null

        for (const action of actions) {
          if (abortRef.current) break

          const result = await execAction(action)

          if (result.isImage && result.ok) {
            screenshotImage = result.image
            textResults.push(
              `[screenshot] OK: Captured display ${result.displayNum}.\n` +
              `IMAGE SIZE: ${result.width}×${result.height} pixels.\n` +
              `COORDINATE RULE: pixel (x, y) in this image = exact mouse coordinate (x, y). No scaling. Click exactly what you see.`
            )
          } else {
            textResults.push(`[${action.type}] ${result.ok ? 'OK' : 'FAIL'}: ${result.output}`)
          }
        }

        if (abortRef.current) { finalText = 'Stopped.'; break }

        const resultBlock = textResults.join('\n')

        if (screenshotImage) {
          conversation = [
            ...conversation,
            { role: 'assistant', content: reply },
            { role: 'user', content: [
              { type: 'text', text: `[ACTION RESULTS — step ${step}/${MAX_AGENT_STEPS}]\n${resultBlock}\n\nAnalyze the screenshot carefully. To click a UI element, use coordinates from the image directly — pixel position = mouse coordinate. No math required.` },
              { type: 'image_url', image_url: { url: screenshotImage } }
            ]}
          ]
        } else {
          conversation = [
            ...conversation,
            { role: 'assistant', content: reply },
            { role: 'user', content: `[ACTION RESULTS — step ${step}/${MAX_AGENT_STEPS}]\n${resultBlock}\n\nContinue with more actions if needed, or give the user a final status. Do NOT repeat completed actions.` }
          ]
        }
      }

      if (!finalText && step >= MAX_AGENT_STEPS) {
        finalText = "Hit my step limit. Tell me to keep going if there's more to do."
      }

      setMessages([...updated, { role: 'assistant', content: finalText }])
      if (!abortRef.current) speakRef.current(finalText)
      await typeText(finalText)
      triggerHappy()
      await updateMemory({ interactionCount: (memory.interactionCount || 0) + 1, lastSeen: new Date().toISOString() })
    } catch (err) {
      if (abortRef.current) {
        await typeText('Stopped.')
      } else {
        console.error('[agent]', err)
        const msg = "Connection lost... is LM Studio running on port 1234?"
        await typeText(msg)
        speakRef.current(msg)
      }
    }
    abortRef.current = false
    setLoading(false)
  }, [buildMessages, typeText, updateMemory, memory, triggerHappy, parseActions, parsePlan, execAction])

  sendMessageRef.current = sendMessage

  // ── Voice query handler ────────────────────────────────────────────────────
  // Voice queries NEVER auto-open the chat panel — response is voice-only.
  // The bot face appears and talks, chat stays closed unless user opens it.
  handleVoiceQueryRef.current = (transcript) => {
    // Handle plan approval via voice ("yes" / "no")
    if (pendingPlan) {
      const lower = transcript.toLowerCase()
      if (lower.includes('yes') || lower.includes('go ahead') || lower.includes('do it') || lower.includes('approved') || lower.includes('approve')) {
        approvePlan()
        return
      }
      if (lower.includes('no') || lower.includes('don\'t') || lower.includes('cancel') || lower.includes('deny') || lower.includes('stop')) {
        denyPlan()
        return
      }
    }

    onUserInput()
    lastActivityRef.current = Date.now()
    // Show the bot face — do NOT open chat for voice-only interaction
    setBotVisible(true)
    sendMessageRef.current(transcript, messages)
  }

  const handleSend = useCallback(() => {
    if (!input.trim() || loading) return
    const text = input.trim()
    setInput('')
    onUserInput()
    lastActivityRef.current = Date.now()
    // Text input always opens chat so user can see the reply
    if (!chatOpenRef.current) setChatOpen(true)
    sendMessage(text, messages)
  }, [input, loading, messages, sendMessage, onUserInput])

  // ── Startup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!loaded || startupDone.current) return
    startupDone.current = true
    // Always ensure the name is set to Anna
    if (!memory.userName || memory.userName !== 'Anna') {
      updateMemory({ userName: 'Anna', firstSeen: memory.firstSeen || new Date().toISOString(), lastSeen: new Date().toISOString() })
    }
    const g = GREETINGS[Math.floor(Math.random() * GREETINGS.length)]
    typeText(g).then(() => setMessages([{ role: 'assistant', content: g }]))
    speakRef.current(g)
  }, [loaded, memory, typeText, updateMemory])

  // ── Idle quips ────────────────────────────────────────────────────────────
  useEffect(() => {
    idleTimerRef.current = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= 8 * 60_000 && !loading && !isTyping) {
        const q = IDLE_QUIPS[Math.floor(Math.random() * IDLE_QUIPS.length)]
        typeText(q).then(() => setMessages(prev => [...prev, { role: 'assistant', content: q }]))
        lastActivityRef.current = Date.now()
      }
    }, 60_000)
    return () => clearInterval(idleTimerRef.current)
  }, [loading, isTyping, typeText])

  return (
    <div className="desktop-overlay">

      {/* ── Notch area — click to toggle chat, or click to interrupt when talking ── */}
      <div
        ref={containerRef}
        className={`notch-container ${chatOpen ? 'chat-mode' : ''}`}
        onClick={handleNotchClick}
      >
        <NotchBot
          visible={botVisible}
          isTalking={isTalking}
          isListening={isListening}
          mood={displayMood}
        />
      </div>

      {/* ── Interrupt hint — shown below the bot face while talking/loading ── */}
      {(isTalking || loading) && !chatOpen && (
        <div className="interrupt-hint">■ tap to interrupt</div>
      )}

      {/* ── Floating approval bar — shown in voice mode when plan needs approval ─ */}
      {pendingPlan && !chatOpen && (
        <div className="voice-approval-bar">
          <span className="voice-approval-label">Approve plan?</span>
          <button className="approve-btn" onClick={approvePlan}>Yes ✓</button>
          <button className="deny-btn" onClick={denyPlan}>No ✗</button>
        </div>
      )}

      {/* ── Chat panel — drops down when opened manually ── */}
      {chatOpen && (
        <div className="notch-chat" onClick={e => e.stopPropagation()}>
          <div className="chat-header">
            <div className="chat-bot-mini">
              <svg width="22" height="16" viewBox="0 0 96 64" xmlns="http://www.w3.org/2000/svg">
                <rect x="4" y="8" width="88" height="52" rx="18" fill="#040c06" stroke="rgba(0,232,122,0.35)" strokeWidth="1.5"/>
                <ellipse cx="32" cy="30" rx="9" ry="8" fill="#00e87a" opacity="0.9"/>
                <ellipse cx="64" cy="30" rx="9" ry="8" fill="#00e87a" opacity="0.9"/>
                <ellipse cx="33" cy="31" rx="4" ry="4" fill="#010d03"/>
                <ellipse cx="65" cy="31" rx="4" ry="4" fill="#010d03"/>
                <path d="M 34 45 Q 40 50 46 45" stroke="#00e87a" strokeWidth="2" strokeLinecap="round" fill="none"/>
              </svg>
            </div>
            <span className="chat-title">THAMMA · AGENT</span>
            {visionEnabled && <span className="vision-badge">EYE</span>}
            <span className="voice-status-badge">{voiceStatus}</span>
            <button
              className="log-toggle-btn"
              title="Toggle debug logs"
              onClick={() => setLogsOpen(o => !o)}
            >LOG</button>
            <button className="chat-close" onClick={() => { setChatOpen(false); setTimeout(() => setBotVisible(false), 300) }}>✕</button>
          </div>

          <div className="speech-bubble">
            {displayText}
            {isTyping && <span className="typewriter-cursor" />}
          </div>

          {/* Approval bar inside chat panel — shown when chat is open */}
          {pendingPlan && (
            <div className="approval-bar">
              <span className="approval-label">Approve this plan?</span>
              <button className="approve-btn" onClick={approvePlan}>Yes, go ahead</button>
              <button className="deny-btn" onClick={denyPlan}>No</button>
            </div>
          )}

          {/* Stop button when agent is running — shown in top-right area */}
          {(loading || isTalking) && !pendingPlan && (
            <div className="agent-running-bar">
              <span className="agent-running-label">{isTalking ? 'speaking…' : 'thinking…'}</span>
              <button className="stop-btn" onClick={stopAgent} title="Stop agent">■ stop</button>
            </div>
          )}

          <div className="input-area">
            <input
              ref={inputRef}
              type="text"
              placeholder={pendingPlan ? 'Say "yes" or "no"...' : 'Type or say "hey thamma"…'}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              disabled={loading || isTyping}
            />
            {loading
              ? <button className="stop-btn" onClick={stopAgent} title="Stop agent">■</button>
              : <button className="send-btn" onClick={handleSend} disabled={isTyping || !input.trim()}>▸</button>
            }
          </div>
          <div className="footer">thamma v3.1 · notch mode · local AI</div>
        </div>
      )}

      {/* ── Debug Log Panel ───────────────────────────────────── */}
      {logsOpen && (
        <div className="log-panel" onClick={e => e.stopPropagation()}>
          <div className="log-panel-header">
            <span>Debug Logs</span>
            <div className="log-panel-actions">
              <button className="log-clear-btn" onClick={() => setLogs([])}>Clear</button>
              <button className="log-close-btn" onClick={() => setLogsOpen(false)}>✕</button>
            </div>
          </div>
          <div className="log-entries">
            {logs.length === 0 && <div className="log-empty">No logs yet. Interact with the agent to see activity.</div>}
            {logs.map((entry, i) => (
              <div key={i} className={`log-entry log-${entry.level}`}>
                {entry.message}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}
    </div>
  )
}
