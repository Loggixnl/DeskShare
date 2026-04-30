export type ShareStatus = 'idle' | 'requesting' | 'sharing' | 'stopped' | 'error'

export interface ActiveSession {
  sessionId: string
  token: string
  name: string
  startedAt: Date
  stream?: MediaStream
  connectionState?: RTCPeerConnectionState
}
