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
    origin: true, // Allow all origins for easier deployment
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

// Key sessions by socketId to allow multiple users with the same token
const activeSessions = new Map<string, ShareSession>()
const dashboardViewers = new Map<string, DashboardViewer>()

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`)

  // Worker joins to share screen
  socket.on('join-share', (data: { token: string; name?: string }) => {
    const { token, name } = data
    console.log(`[Share] Worker joining: ${token} (${name || 'unnamed'}) with socket ${socket.id}`)

    // Store session keyed by socketId (allows multiple users with same token)
    const session: ShareSession = {
      token,
      name: name || `Worker ${token.slice(0, 6)}`,
      socketId: socket.id,
      startedAt: new Date(),
    }
    activeSessions.set(socket.id, session)

    // Join room for this token
    socket.join(`share:${token}`)

    // Notify all dashboard viewers about new session (use socketId as unique identifier)
    io.to('dashboard').emit('session-joined', {
      sessionId: socket.id,
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

    // Send current active sessions (include sessionId as unique identifier)
    const sessions = Array.from(activeSessions.values()).map((s) => ({
      sessionId: s.socketId,
      token: s.token,
      name: s.name,
      startedAt: s.startedAt,
    }))
    socket.emit('active-sessions', sessions)
  })

  // Dashboard requests to view a specific share (by sessionId)
  socket.on('request-offer', (data: { sessionId: string }) => {
    const session = activeSessions.get(data.sessionId)
    if (session) {
      console.log(`[Signal] Dashboard requesting offer from session ${data.sessionId}`)
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
      sessionId: socket.id, // sessionId is the sharer's socket ID
      offer: data.offer,
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
  socket.on('share-stopped', () => {
    console.log(`[Share] Stopped: ${socket.id}`)
    activeSessions.delete(socket.id)
    io.to('dashboard').emit('session-left', { sessionId: socket.id })
  })

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`)

    // Check if this was a sharer (sessions are keyed by socketId)
    if (activeSessions.has(socket.id)) {
      activeSessions.delete(socket.id)
      io.to('dashboard').emit('session-left', { sessionId: socket.id })
    }

    // Remove from dashboard viewers
    dashboardViewers.delete(socket.id)
  })
})

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => {
  console.log(`[Server] Signaling server running on http://localhost:${PORT}`)
})
