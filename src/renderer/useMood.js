import { useState, useEffect, useRef, useCallback } from 'react'

const BORED_AFTER     = 5 * 60 * 1000   // 5 min idle  → bored
const TIRED_THRESHOLD = 7               // 7 user msgs in window → tired
const TIRED_WINDOW    = 10 * 60 * 1000  // sliding 10-min window
const RECOVERY_TIME   = 3 * 60 * 1000   // 3 min rest while tired → happy

const PILLS = {
  happy: ['HAPPY',  'READY'],
  bored: ['BORED',  'WAITING'],
  tired: ['TIRED',  'RESTING'],
}

export default function useMood() {
  const [mood, setMood] = useState('happy')

  // Refs so tick() never captures stale values
  const moodRef             = useRef('happy')
  const interactionTimes    = useRef([])           // timestamps of user messages
  const lastInteractionTime = useRef(Date.now())   // start as now → not bored on boot

  // Called every time the user sends a message
  const onUserInput = useCallback(() => {
    const now = Date.now()
    lastInteractionTime.current = now
    interactionTimes.current.push(now)
  }, [])

  useEffect(() => {
    function updateMood(next) {
      if (moodRef.current === next) return  // no-op if unchanged
      moodRef.current = next
      setMood(next)
    }

    function tick() {
      const now = Date.now()

      // Slide the window — drop interactions older than TIRED_WINDOW
      interactionTimes.current = interactionTimes.current.filter(
        t => now - t < TIRED_WINDOW
      )

      const recentCount = interactionTimes.current.length
      const idleMs      = now - lastInteractionTime.current
      const current     = moodRef.current

      // ── Tired recovery: rest long enough → happy fresh start ──
      if (current === 'tired' && idleMs >= RECOVERY_TIME) {
        interactionTimes.current = []   // clear slate after recovery
        updateMood('happy')
        return
      }

      // ── Become tired: too many messages, not already tired ──
      if (current !== 'tired' && recentCount >= TIRED_THRESHOLD) {
        updateMood('tired')
        return
      }

      // ── Sticky tired: still needs rest ──
      if (current === 'tired') return

      // ── Bored: idle too long ──
      if (idleMs >= BORED_AFTER) {
        updateMood('bored')
        return
      }

      // ── Default: happy ──
      updateMood('happy')
    }

    const timer = setInterval(tick, 15_000)
    tick()                               // run immediately on mount
    return () => clearInterval(timer)
  }, [])                                 // empty deps — all state via refs

  return { mood, pills: PILLS[mood] ?? PILLS.happy, onUserInput }
}
