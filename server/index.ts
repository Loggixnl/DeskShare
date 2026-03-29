import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'

const app = express()
app.use(cors())

// Health check endpoint
app.get('/health', (_, res) => {
  res.json({ status: 'ok' })
})

const httpServer = createServer(app)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://127.0.0.1:3000']

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
})

interface ShareSession {
  token: string
  name: string
  socketId: string
  startedAt: Date
}

interface DashboardViewer {
  socketId: string
}

const activeSessions = new Map<string, ShareSession>()
const dashboardViewers = new Map<string, DashboardViewer>()

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`)

  // Worker joins to share screen
  socket.on('join-share', (data: { token: string; name?: string }) => {
    const { token, name } = data
    console.log(`[Share] Worker joining: ${token} (${name || 'unnamed'})`)

    // Store session
    const session: ShareSession = {
      token,
      name: name || `Worker ${token.slice(0, 6)}`,
      socketId: socket.id,
      startedAt: new Date(),
    }
    activeSessions.set(token, session)

    // Join room for this token
    socket.join(`share:${token}`)

    // Notify all dashboard viewers about new session
    io.to('dashboard').emit('session-joined', {
      token,
      name: session.name,
      startedAt: session.startedAt,
    })

    socket.emit('share-ready', { token })
  })

  // Dashboard viewer joins
  socket.on('join-dashboard', () => {
    console.log(`[Dashboard] Viewer joined: ${socket.id}`)
    socket.join('dashboard')
    dashboardViewers.set(socket.id, { socketId: socket.id })

    // Send current active sessions
    const sessions = Array.from(activeSessions.values()).map((s) => ({
      token: s.token,
      name: s.name,
      startedAt: s.startedAt,
    }))
    socket.emit('active-sessions', sessions)
  })

  // Dashboard requests to view a specific share
  socket.on('request-offer', (data: { token: string }) => {
    const session = activeSessions.get(data.token)
    if (session) {
      console.log(`[Signal] Dashboard requesting offer from ${data.token}`)
      io.to(session.socketId).emit('viewer-joined', {
        viewerId: socket.id,
      })
    }
  })

  // WebRTC signaling: offer from sharer to viewer
  socket.on('offer', (data: { viewerId: string; offer: RTCSessionDescriptionInit }) => {
    console.log(`[Signal] Offer from ${socket.id} to ${data.viewerId}`)
    io.to(data.viewerId).emit('offer', {
      sharerId: socket.id,
      offer: data.offer,
      token: getTokenBySocketId(socket.id),
    })
  })

  // WebRTC signaling: answer from viewer to sharer
  socket.on('answer', (data: { sharerId: string; answer: RTCSessionDescriptionInit }) => {
    console.log(`[Signal] Answer from ${socket.id} to ${data.sharerId}`)
    io.to(data.sharerId).emit('answer', {
      viewerId: socket.id,
      answer: data.answer,
    })
  })

  // WebRTC signaling: ICE candidate exchange
  socket.on('ice-candidate', (data: { targetId: string; candidate: RTCIceCandidateInit }) => {
    io.to(data.targetId).emit('ice-candidate', {
      fromId: socket.id,
      candidate: data.candidate,
    })
  })

  // Worker stops sharing
  socket.on('share-stopped', (data: { token: string }) => {
    console.log(`[Share] Stopped: ${data.token}`)
    activeSessions.delete(data.token)
    io.to('dashboard').emit('session-left', { token: data.token })
  })

  // Voice call signaling - Dashboard calling worker
  socket.on('call-request', (data: { token: string }) => {
    const session = activeSessions.get(data.token)
    if (session) {
      console.log(`[Call] Dashboard requesting call with ${data.token}`)
      io.to(session.socketId).emit('call-incoming', {
        callerId: socket.id,
      })
    }
  })

  // Voice call signaling - Worker calling dashboard
  socket.on('worker-call-admin', (data: { token: string; workerName: string }) => {
    console.log(`[Call] Worker ${data.token} (${data.workerName}) calling dashboard`)
    // Notify all dashboard viewers
    io.to('dashboard').emit('worker-calling', {
      token: data.token,
      workerName: data.workerName,
      workerId: socket.id,
    })
  })

  socket.on('admin-accept-call', (data: { workerId: string; token: string }) => {
    console.log(`[Call] Admin accepted call from worker ${data.token}`)
    io.to(data.workerId).emit('admin-accepted', {
      adminId: socket.id,
      token: data.token,
    })
  })

  socket.on('admin-reject-call', (data: { workerId: string; token: string }) => {
    console.log(`[Call] Admin rejected call from worker ${data.token}`)
    io.to(data.workerId).emit('admin-rejected', { token: data.token })
  })

  socket.on('call-accepted', (data: { callerId: string; token: string }) => {
    console.log(`[Call] Worker accepted call from ${data.callerId}`)
    io.to(data.callerId).emit('call-accepted', {
      token: data.token,
      workerId: socket.id,
    })
  })

  socket.on('call-rejected', (data: { callerId: string; token: string }) => {
    console.log(`[Call] Worker rejected call from ${data.callerId}`)
    io.to(data.callerId).emit('call-rejected', { token: data.token })
  })

  socket.on('call-ended', (data: { targetId: string; token: string }) => {
    console.log(`[Call] Call ended for ${data.token}`)
    io.to(data.targetId).emit('call-ended', { token: data.token })
  })

  // Voice WebRTC signaling
  socket.on('voice-offer', (data: { targetId: string; offer: RTCSessionDescriptionInit; token: string }) => {
    console.log(`[Voice] Offer from ${socket.id} to ${data.targetId}`)
    io.to(data.targetId).emit('voice-offer', {
      callerId: socket.id,
      offer: data.offer,
      token: data.token,
    })
  })

  socket.on('voice-answer', (data: { callerId: string; answer: RTCSessionDescriptionInit; token: string }) => {
    console.log(`[Voice] Answer from ${socket.id} to ${data.callerId}`)
    io.to(data.callerId).emit('voice-answer', {
      workerId: socket.id,
      answer: data.answer,
      token: data.token,
    })
  })

  socket.on('voice-ice-candidate', (data: { targetId: string; candidate: RTCIceCandidateInit; token: string }) => {
    io.to(data.targetId).emit('voice-ice-candidate', {
      fromId: socket.id,
      candidate: data.candidate,
      token: data.token,
    })
  })

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`)

    // Check if this was a sharer
    const token = getTokenBySocketId(socket.id)
    if (token) {
      activeSessions.delete(token)
      io.to('dashboard').emit('session-left', { token })
    }

    // Remove from dashboard viewers
    dashboardViewers.delete(socket.id)
  })
})

function getTokenBySocketId(socketId: string): string | undefined {
  for (const [token, session] of activeSessions) {
    if (session.socketId === socketId) {
      return token
    }
  }
  return undefined
}

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => {
  console.log(`[Server] Signaling server running on http://localhost:${PORT}`)
})
