export interface PeerConnectionCallbacks {
  onIceCandidate: (candidate: RTCIceCandidate) => void
  onTrack?: (event: RTCTrackEvent) => void
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void
}

export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = []

  // Add STUN servers (multiple for redundancy)
  const stunUrl = import.meta.env.VITE_STUN_URL || 'stun:stun.l.google.com:19302'
  servers.push({ urls: stunUrl })
  servers.push({ urls: 'stun:stun1.l.google.com:19302' })
  servers.push({ urls: 'stun:stun2.l.google.com:19302' })

  // Add TURN server if configured via environment
  const turnUrl = import.meta.env.VITE_TURN_URL
  const turnUsername = import.meta.env.VITE_TURN_USERNAME
  const turnPassword = import.meta.env.VITE_TURN_PASSWORD

  if (turnUrl && turnUsername && turnPassword) {
    servers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnPassword,
    })
  } else {
    // Use free OpenRelay TURN servers from Metered as fallback
    // These are free public TURN servers for NAT traversal
    servers.push({
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    })
    servers.push({
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    })
    servers.push({
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    })
  }

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
