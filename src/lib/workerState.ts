import { ref } from 'vue'
import type { MediaType } from './auth'

// Shared state for worker session - persists across route changes
export const workerStream = ref<MediaStream | null>(null)
export const workerSessionId = ref<string | null>(null)
export const workerToken = ref<string | null>(null)
export const workerName = ref<string>('')
export const workerMediaType = ref<MediaType>('screen')

// Peer connections for dashboard viewers watching this worker
export const workerPeerConnections = new Map<string, RTCPeerConnection>()

export function setWorkerSession(
  stream: MediaStream,
  sessionId: string,
  token: string,
  name: string,
  mediaType: MediaType
) {
  workerStream.value = stream
  workerSessionId.value = sessionId
  workerToken.value = token
  workerName.value = name
  workerMediaType.value = mediaType
}

export function clearWorkerSession() {
  if (workerStream.value) {
    workerStream.value.getTracks().forEach(track => track.stop())
  }
  workerStream.value = null
  workerSessionId.value = null
  workerToken.value = null
  workerName.value = ''
  workerMediaType.value = 'screen'
  workerPeerConnections.forEach(pc => pc.close())
  workerPeerConnections.clear()
}

export function isWorkerActive(): boolean {
  return workerStream.value !== null && workerSessionId.value !== null
}
