import { io, Socket } from 'socket.io-client'

let socket: Socket | null = null

const SIGNALING_SERVER = import.meta.env.VITE_SIGNALING_URL || ''

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SIGNALING_SERVER, {
      autoConnect: false,
    })
  }
  return socket
}

export function connectSocket(): void {
  const s = getSocket()
  if (!s.connected) {
    s.connect()
  }
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect()
  }
}
