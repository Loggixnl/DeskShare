export type ShareStatus = 'idle' | 'requesting' | 'sharing' | 'stopped' | 'error'

export interface ActiveSession {
  token: string
  name: string
  startedAt: Date
  stream?: MediaStream
  connectionState?: RTCPeerConnectionState
}
