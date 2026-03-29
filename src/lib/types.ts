export type ShareStatus = 'idle' | 'requesting' | 'sharing' | 'stopped' | 'error'

export interface ActiveSession {
  sessionId?: string // Unique session ID (socket.id)
  token: string // Admin's share token
  name: string
  startedAt: Date
  stream?: MediaStream
  connectionState?: RTCPeerConnectionState
}
