import React, { useEffect, useRef, useState } from 'react'

export default function NotchBot({ visible, isTalking, isListening, mood = 'online' }) {
  const leftPupilRef  = useRef(null)
  const rightPupilRef = useRef(null)
  const mouthRef      = useRef(null)
  const talkTimer     = useRef(null)
  const eyeIdleTimer  = useRef(null)
  const blinkTimer    = useRef(null)
  const [blinking, setBlinking] = useState(false)

  // Mouth paths per mood — compact 32×32 viewBox
  const MOUTH = {
    happy:   'M 11.5 20 Q 16 23.5 20.5 20',
    online:  'M 12   20.5 Q 16 22.5 20   20.5',
    focused: 'M 12   21   Q 16 21   20   21',
    bored:   'M 12   21   Q 16 19.5 20   21',
    tired:   'M 12   21   Q 16 19   20   21',
  }

  // Tiny pupil drift — subtle tween via CSS
  useEffect(() => {
    if (!visible) return
    const drift = () => {
      const dx = (Math.random() - 0.5) * 1.0
      const dy = (Math.random() - 0.5) * 0.6
      leftPupilRef.current?.setAttribute('cx',  String(11 + dx))
      leftPupilRef.current?.setAttribute('cy',  String(14 + dy))
      rightPupilRef.current?.setAttribute('cx', String(21 + dx))
      rightPupilRef.current?.setAttribute('cy', String(14 + dy))
    }
    drift()
    eyeIdleTimer.current = setInterval(drift, 2400 + Math.random() * 1200)
    return () => { clearInterval(eyeIdleTimer.current); eyeIdleTimer.current = null }
  }, [visible])

  // Natural blinking
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const schedule = () => {
      if (cancelled) return
      const delay = 2800 + Math.random() * 3800
      blinkTimer.current = setTimeout(() => {
        setBlinking(true)
        setTimeout(() => {
          setBlinking(false)
          schedule()
        }, 140)
      }, delay)
    }
    schedule()
    return () => { cancelled = true; clearTimeout(blinkTimer.current) }
  }, [visible])

  // Mouth mood update
  useEffect(() => {
    if (!mouthRef.current) return
    mouthRef.current.setAttribute('d', MOUTH[mood] || MOUTH.online)
  }, [mood])

  // Talking animation — cycle through three clearly-different mouth shapes
  // so the lip motion reads on a tiny 32×32 face.
  const TALK_FRAMES = [
    'M 13 20.5 Q 16 21.5 19 20.5',   // nearly closed
    'M 11 19   Q 16 25   21 19',     // wide open smile
    'M 12.5 20 Q 16 22.5 19.5 20',   // half open
    'M 11 18.5 Q 16 26   21 18.5',   // wide open (bigger)
  ]

  useEffect(() => {
    if (talkTimer.current) { clearInterval(talkTimer.current); talkTimer.current = null }

    if (!isTalking) {
      if (mouthRef.current) mouthRef.current.setAttribute('d', MOUTH[mood] || MOUTH.online)
      return
    }

    let frame = 0
    talkTimer.current = setInterval(() => {
      if (!mouthRef.current) return
      mouthRef.current.setAttribute('d', TALK_FRAMES[frame % TALK_FRAMES.length])
      frame++
    }, 130)

    return () => { if (talkTimer.current) clearInterval(talkTimer.current) }
  }, [isTalking, mood])

  const stateClass = [
    'notch-bot',
    visible     ? 'visible'   : '',
    isListening ? 'listening' : '',
    isTalking   ? 'talking'   : '',
    blinking    ? 'blinking'  : '',
    `mood-${mood}`,
  ].filter(Boolean).join(' ')

  return (
    <div className={stateClass}>
      {/* Tiny round face — pure-black orb that blends with the notch */}
      <svg
        className="notch-face"
        width="32"
        height="32"
        viewBox="0 0 32 32"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="0.8" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Pure-black orb */}
        <circle cx="16" cy="16" r="16" fill="#000" />

        {/* Eyes */}
        <g className="eye-group eye-left">
          <circle
            className="eye-white"
            cx="11" cy="14" r="1.9"
            fill="#00e87a"
            filter="url(#soft-glow)"
          />
          <circle
            ref={leftPupilRef}
            className="eye-pupil"
            cx="11" cy="14" r="0.8"
            fill="#000"
          />
        </g>

        <g className="eye-group eye-right">
          <circle
            className="eye-white"
            cx="21" cy="14" r="1.9"
            fill="#00e87a"
            filter="url(#soft-glow)"
          />
          <circle
            ref={rightPupilRef}
            className="eye-pupil"
            cx="21" cy="14" r="0.8"
            fill="#000"
          />
        </g>

        {/* Mouth */}
        <path
          ref={mouthRef}
          d="M 12 20.5 Q 16 22.5 20 20.5"
          stroke="#00e87a"
          strokeWidth="1.2"
          strokeLinecap="round"
          fill="none"
          filter="url(#soft-glow)"
          className="notch-mouth"
        />
      </svg>
    </div>
  )
}
