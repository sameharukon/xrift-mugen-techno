/**
 * DEV ONLY (used by src/dev.tsx, not part of the world bundle):
 * instance state shared between browser tabs of the same origin via BroadcastChannel,
 * so multiplayer sync can be tested locally with two tabs.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { InstanceStateContextValue } from '@xrift/world-components'

export function useBroadcastInstanceState(channel = 'xrift-dev-instance-state'): InstanceStateContextValue {
  const [states, setStates] = useState<Map<string, unknown>>(() => new Map())
  const ref = useRef(states)
  ref.current = states
  const ch = useMemo(() => new BroadcastChannel(channel), [channel])
  useEffect(() => {
    ch.onmessage = (e: MessageEvent) => {
      const d = e.data
      if (d.type === 'set') setStates((m) => new Map(m).set(d.id, d.payload))
      else if (d.type === 'hello') ch.postMessage({ type: 'snapshot', entries: [...ref.current] })
      else if (d.type === 'snapshot') setStates((m) => (m.size ? m : new Map(d.entries)))
    }
    ch.postMessage({ type: 'hello' })
    return () => ch.close()
  }, [ch])
  return useMemo(
    () => ({
      states,
      sendState: (id: string, payload: unknown) => {
        setStates((m) => new Map(m).set(id, payload))
        ch.postMessage({ type: 'set', id, payload })
      },
    }),
    [states, ch],
  )
}
