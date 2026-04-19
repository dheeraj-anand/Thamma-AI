import { useRef, useState, useEffect, useCallback } from 'react'

// Variants we've seen from speech engines for "Hey Thamma"
const WAKE_VARIANTS = [
  'hey thamma', 'hey tamma', 'hey thama', 'hey thammah', 'hey tammah',
  'hey, thamma', 'hey, tamma', 'hey thmma', 'hey thomma', 'hey toma',
  'hey thoma', 'hey thumma', 'hey tumma', 'hey sama', 'hey samma',
  'hey tama', 'hey tummy', 'hey thommy', 'hey dhamma', 'hey damma',
  'hi thamma', 'hi tamma', 'hi thama', 'ey thamma', 'a thamma',
  'thamma', 'tamma', 'thama',
]

const FUZZY_WAKE = /\b(?:hey|hi|hay|ey)[,\s]+([tds]h?[aeiou][a-z]{1,5})\b/
const hasWake = (t) => WAKE_VARIANTS.some(w => t.includes(w)) || FUZZY_WAKE.test(t)

function extractAfterWake(text) {
  const sorted = [...WAKE_VARIANTS].sort((a, b) => b.length - a.length)
  for (const w of sorted) {
    const i = text.indexOf(w)
    if (i !== -1) return text.slice(i + w.length).replace(/^[,.\s]+/, '').trim()
  }
  const m = text.match(FUZZY_WAKE)
  if (m) return text.slice(m.index + m[0].length).replace(/^[,.\s]+/, '').trim()
  return ''
}

// ── Why MediaRecorder + mlx-whisper instead of webkitSpeechRecognition ────────
// webkitSpeechRecognition in a packaged Electron app silently fails because:
//   (a) Apple's SFSpeechRecognizer needs NSSpeechRecognitionUsageDescription in
//       Info.plist — absent here — so TCC never prompts.
//   (b) The Google cloud fallback needs a proprietary API key not bundled in
//       open-source Chromium builds.
//
// MediaRecorder approach:
//   • Uses only the microphone permission (already granted via getUserMedia).
//   • The continuous timeslice recorder fires ondataavailable every 3 s while
//     KEEPING THE MIC OPEN between chunks — no audio is ever lost.
//   • Each chunk is sent to the Python daemon's mlx-whisper STT in the background
//     (concurrent with the next chunk recording) so wake detection is truly
//     continuous with near-zero dead time.
// ─────────────────────────────────────────────────────────────────────────────

export default function useVoice({ onQuery }) {
  const [isListening, setIsListening] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState('starting…')

  const onQueryRef    = useRef(onQuery)
  const pausedRef     = useRef(false)
  const destroyedRef  = useRef(false)
  const streamRef     = useRef(null)
  const recorderRef   = useRef(null)     // active MediaRecorder
  const modeRef       = useRef('wake')   // 'wake' | 'query' | 'paused'

  // Loop functions stored in refs so external callbacks (pause/resume/followUp)
  // can call them without stale closures.
  const startWakeRef  = useRef(null)
  const startQueryRef = useRef(null)

  onQueryRef.current = onQuery

  // Send a log entry to the main process so it shows up in the LOG panel.
  function rlog(msg) {
    try { window.thammaAPI?.logRenderer?.(msg) } catch {}
  }

  function bestMime() {
    for (const m of [
      'audio/webm;codecs=opus', 'audio/webm',
      'audio/ogg;codecs=opus',  'audio/ogg',
    ]) {
      try { if (MediaRecorder.isTypeSupported(m)) return m } catch {}
    }
    return ''
  }

  async function transcribe(blob) {
    if (!blob || blob.size < 300) {
      rlog(`[voice] transcribe skipped — blob too small (${blob?.size ?? 0}B)`)
      return ''
    }
    try {
      const ab  = await blob.arrayBuffer()
      rlog(`[voice] sending ${ab.byteLength}B to daemon`)
      const res = await window.thammaAPI.transcribeAudio(new Uint8Array(ab))
      const txt = (res?.text || '').toLowerCase().trim()
      rlog(`[voice] transcription: "${txt || '(empty)'}" ${res?.error ? '⚠ ' + res.error : ''}`)
      return txt
    } catch (err) {
      rlog(`[voice] transcribeAudio threw: ${err.message}`)
      return ''  // daemon not ready yet — keep looping silently
    }
  }

  useEffect(() => {
    const mime = bestMime()

    // ── Wake-word detection ───────────────────────────────────────────────────
    // Uses a TIMESLICE recorder: MediaRecorder stays running and fires
    // ondataavailable every WAKE_SLICE_MS.  Each chunk is transcribed
    // asynchronously — the next chunk is already recording while whisper runs,
    // so the mic is ALWAYS on and no speech is ever dropped.
    //
    // IMPORTANT — WebM timeslice fragmentation:
    // Chromium's MediaRecorder writes the WebM initialization segment (stream
    // headers) ONLY into the FIRST ondataavailable chunk.  All subsequent
    // chunks are header-less media segments that ffmpeg/mlx-whisper cannot
    // decode on their own.  We solve this by keeping the first chunk as an
    // "init segment" and prepending it to every subsequent chunk so every
    // blob handed to the daemon is a self-contained, decodable WebM file.
    const WAKE_SLICE_MS = 3000

    function startWakeDetection(stream) {
      if (destroyedRef.current || pausedRef.current || !stream) return
      modeRef.current = 'wake'
      setVoiceStatus('ready — say "hey thamma"')

      let rec
      try {
        rec = mime ? new MediaRecorder(stream, { mimeType: mime })
                   : new MediaRecorder(stream)
      } catch (err) {
        setVoiceStatus(`mic error: ${err.message}`)
        return
      }
      recorderRef.current = rec

      // initChunk holds the first ondataavailable blob (contains WebM headers).
      // Every subsequent chunk is prepended with it before transcription.
      let initChunk = null
      let chunkIdx  = 0

      // ── Timeslice handler — runs every WAKE_SLICE_MS while recording ──────
      rec.ondataavailable = async (e) => {
        if (e.data.size < 200) {
          rlog(`[voice] chunk too small (${e.data.size}B) — skipped`)
          return           // too small — silence or glitch
        }
        if (modeRef.current !== 'wake') return   // mode changed, discard chunk

        chunkIdx++
        if (chunkIdx === 1) {
          // First chunk: save as init segment AND use it directly (already complete).
          initChunk = e.data
          rlog(`[voice] chunk #1 (init+data, ${e.data.size}B)`)
        } else {
          rlog(`[voice] chunk #${chunkIdx} (fragment ${e.data.size}B + init ${initChunk?.size ?? 0}B)`)
        }

        // Build a complete WebM blob: prepend the init segment to fragments.
        const parts = (initChunk && chunkIdx > 1)
          ? [initChunk, e.data]
          : [e.data]
        const chunk = new Blob(parts, { type: mime || 'audio/webm' })
        const text  = await transcribe(chunk)

        // JS is single-threaded: this read-check-write is atomic with respect to
        // any other synchronous code (callbacks only run between awaits).
        if (modeRef.current !== 'wake' || pausedRef.current || destroyedRef.current) return

        if (text) setVoiceStatus(`heard: "${text.slice(0, 28)}…"`)

        if (text && hasWake(text)) {
          const rest = extractAfterWake(text)
          modeRef.current = 'query'        // grab mode atomically
          try { rec.stop() } catch {}      // stop the timeslice loop

          if (rest.length > 2) {
            // Full inline query: "Hey Thamma, set a 5-minute timer"
            setVoiceStatus(`heard: "${rest.slice(0, 30)}"`)
            onQueryRef.current(rest)
            setTimeout(() => {
              if (!pausedRef.current && !destroyedRef.current && streamRef.current)
                startWakeRef.current?.(streamRef.current)
            }, 600)
          } else {
            // Just the wake word — record the follow-up query
            setIsListening(true)
            setVoiceStatus('listening…')
            startQueryRef.current?.(stream)
          }
        } else {
          // Not a wake word — reset status
          setVoiceStatus('ready — say "hey thamma"')
        }
      }

      // onstop is called when:
      //   (a) pauseVoice() → modeRef = 'paused', do nothing
      //   (b) enterFollowUpMode() → modeRef = 'query', call startQueryRef
      //   (c) wake word detected (above) → startQueryRef already called inline
      rec.onstop = () => {
        if (destroyedRef.current || pausedRef.current) return
        if (modeRef.current === 'query' && recorderRef.current === rec) {
          // Stopped externally (enterFollowUpMode) without inline startQueryRef call
          startQueryRef.current?.(stream)
        }
      }

      rec.onerror = () => {
        if (!destroyedRef.current && !pausedRef.current)
          setTimeout(() => startWakeRef.current?.(stream), 1000)
      }

      try {
        rec.start(WAKE_SLICE_MS)
      } catch (err) {
        setVoiceStatus(`start error: ${err.message}`)
      }
    }
    startWakeRef.current = startWakeDetection

    // ── Query recording ───────────────────────────────────────────────────────
    // Records a single utterance (up to 8 s) after the wake word is heard.
    async function startQueryRecording(stream) {
      if (destroyedRef.current || pausedRef.current || !stream) return
      modeRef.current = 'query'
      setIsListening(true)
      setVoiceStatus('listening…')

      const chunks = []
      let rec
      try {
        rec = mime ? new MediaRecorder(stream, { mimeType: mime })
                   : new MediaRecorder(stream)
      } catch {
        setIsListening(false)
        startWakeRef.current?.(stream)
        return
      }
      recorderRef.current = rec
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }

      const blob = await new Promise((resolve) => {
        rec.onstop = () => resolve(new Blob(chunks, { type: mime || 'audio/webm' }))
        rec.start()
        setTimeout(() => {
          try { if (rec.state === 'recording') rec.stop() } catch {}
        }, 8000)
      })

      setIsListening(false)
      if (destroyedRef.current) return
      if (pausedRef.current) { modeRef.current = 'wake'; return }

      setVoiceStatus('processing…')
      const text = await transcribe(blob)

      if (!destroyedRef.current) {
        if (text.length > 1) {
          onQueryRef.current(text)
        } else {
          setVoiceStatus('didn\'t catch that — say "hey thamma" again')
        }
      }

      if (!destroyedRef.current && !pausedRef.current && streamRef.current) {
        startWakeRef.current?.(streamRef.current)
      }
    }
    startQueryRef.current = startQueryRecording

    // ── Init ──────────────────────────────────────────────────────────────────
    rlog(`[voice] useVoice init — mime: ${mime || '(browser default)'}`)
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(stream => {
        if (destroyedRef.current) { stream.getTracks().forEach(t => t.stop()); return }
        rlog('[voice] mic opened ✓ — starting wake detection')
        streamRef.current = stream
        startWakeRef.current?.(stream)
      })
      .catch((err) => {
        rlog(`[voice] mic denied: ${err?.message}`)
        setVoiceStatus('mic denied — allow microphone in System Settings')
      })

    return () => {
      destroyedRef.current = true
      try { recorderRef.current?.stop() } catch {}
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  }, []) // runs once on mount

  // ── Public API ────────────────────────────────────────────────────────────

  // Stop listening while Thamma is speaking (avoids hearing her own voice)
  const pauseVoice = useCallback(() => {
    pausedRef.current = true
    modeRef.current   = 'paused'
    setIsListening(false)
    try { recorderRef.current?.stop() } catch {}
  }, [])

  // Resume wake-word detection after Thamma finishes speaking
  const resumeVoice = useCallback(() => {
    if (destroyedRef.current || !streamRef.current) return
    pausedRef.current = false
    // Small delay so the stopped recorder has fully torn down before we create a new one
    setTimeout(() => {
      if (!pausedRef.current && !destroyedRef.current && streamRef.current) {
        startWakeRef.current?.(streamRef.current)
      }
    }, 200)
  }, [])

  // After Thamma finishes speaking, immediately enter query mode (hands-free follow-up)
  const enterFollowUpMode = useCallback(() => {
    if (pausedRef.current || destroyedRef.current || !streamRef.current) return
    setTimeout(() => {
      if (pausedRef.current || destroyedRef.current || !streamRef.current) return

      // Stop the timeslice wake recorder; its onstop handler will call startQueryRef
      // (if modeRef is 'query').  If the recorder isn't running, call directly.
      const wasRecording = recorderRef.current?.state === 'recording'
      modeRef.current = 'query'
      setIsListening(true)
      setVoiceStatus('listening…')

      try { recorderRef.current?.stop() } catch {}

      // Fallback: if recorder wasn't running, start query recording directly
      if (!wasRecording) {
        startQueryRef.current?.(streamRef.current)
      }
    }, 300)
  }, [])

  return { isListening, voiceStatus, pauseVoice, resumeVoice, enterFollowUpMode }
}
