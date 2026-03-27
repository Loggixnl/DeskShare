export interface PeerConnectionCallbacks {
  onIceCandidate: (candidate: RTCIceCandidate) => void
  onTrack?: (event: RTCTrackEvent) => void
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void
}

export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = []

  // Add STUN server
  const stunUrl = import.meta.env.VITE_STUN_URL || 'stun:stun.l.google.com:19302'
  servers.push({ urls: stunUrl })

  return servers
}

export function createPeerConnection(callbacks: PeerConnectionCallbacks): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: getIceServers(),
  })

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      callbacks.onIceCandidate(event.candidate)
    }
  }

  if (callbacks.onTrack) {
    pc.ontrack = callbacks.onTrack
  }

  if (callbacks.onConnectionStateChange) {
    pc.onconnectionstatechange = () => {
      callbacks.onConnectionStateChange!(pc.connectionState)
    }
  }

  return pc
}

export async function createOffer(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  return offer
}

export async function createAnswer(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  return answer
}

export async function setRemoteDescription(
  pc: RTCPeerConnection,
  description: RTCSessionDescriptionInit
): Promise<void> {
  await pc.setRemoteDescription(new RTCSessionDescription(description))
}

export async function addIceCandidate(
  pc: RTCPeerConnection,
  candidate: RTCIceCandidateInit
): Promise<void> {
  await pc.addIceCandidate(new RTCIceCandidate(candidate))
}

export function closePeerConnection(pc: RTCPeerConnection): void {
  pc.onicecandidate = null
  pc.ontrack = null
  pc.onconnectionstatechange = null
  pc.close()
}

export async function getDisplayMedia(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      cursor: 'always',
    },
    audio: false,
  })
}

export function stopMediaStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => {
    track.stop()
  })
}
