import { useState, useRef, useCallback } from 'react'

export default function useTalk() {
  const [isTalking, setIsTalking] = useState(false)
  const [displayText, setDisplayText] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const intervalRef = useRef(null)
  const indexRef = useRef(0)

  const typeText = useCallback((text) => {
    return new Promise((resolve) => {
      if (intervalRef.current) clearInterval(intervalRef.current)

      setDisplayText('')
      setIsTalking(true)
      setIsTyping(true)
      indexRef.current = 0

      intervalRef.current = setInterval(() => {
        indexRef.current++
        if (indexRef.current <= text.length) {
          setDisplayText(text.slice(0, indexRef.current))
        } else {
          clearInterval(intervalRef.current)
          intervalRef.current = null
          setIsTalking(false)
          setIsTyping(false)
          resolve()
        }
      }, 45)
    })
  }, [])

  return { isTalking, isTyping, displayText, typeText }
}
