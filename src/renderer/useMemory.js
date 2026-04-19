import { useState, useEffect, useCallback } from 'react'

export default function useMemory() {
  const [memory, setMemory] = useState({
    userName: null,
    interactionCount: 0,
    firstSeen: null,
    lastSeen: null
  })
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const data = await window.thammaAPI.getMemory()
        setMemory(data)
      } catch (e) {
        console.warn('Failed to load memory:', e)
      }
      setLoaded(true)
    }
    load()
  }, [])

  const updateMemory = useCallback(async (updates) => {
    setMemory(prev => ({ ...prev, ...updates }))
    try {
      await window.thammaAPI.setMemory(updates)
    } catch (e) {
      console.warn('Failed to save memory:', e)
    }
  }, [])

  return { memory, loaded, updateMemory }
}
