import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import { createAdmin, verifyAdmin, isValidShareToken, getAdminById } from './db.js'
import { generateToken, requireAuth, verifySocketToken } from './middleware/auth.js'

const app = express()

// CORS configuration for Express - allow all origins for debugging
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}))

// Handle preflight requests explicitly
app.options('*', cors())

app.use(express.json())

// Reusable allowed origins for Socket.IO
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://127.0.0.1:3000']

// Health check endpoint
app.get('/health', async (_, res) => {
  res.json({ status: 'ok', database: 'turso' })
})

// Auth API endpoints
app.post('/api/auth/register', async (req, res) => {
  console.log('[Auth] Register request received:', { body: req.body })
  try {
    const { email, password } = req.body

    if (!email || !password) {
      console.log('[Auth] Missing email or password')
      return res.status(400).json({ error: 'Email and password are required' })
    }

    if (password.length < 6) {
      console.log('[Auth] Password too short')
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }

    console.log('[Auth] Creating admin for:', email)
    const admin = await createAdmin(email, password)
    console.log('[Auth] Admin created:', admin.id)

    const token = generateToken(admin)
    console.log('[Auth] Token generated')

    res.json({
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        shareToken: admin.share_token,
      },
    })
  } catch (error) {
    console.error('[Auth] Register error:', error)
    console.error('[Auth] Error type:', typeof error)
    console.error('[Auth] Error constructor:', error?.constructor?.name)

    if (error instanceof Error && error.message === 'Email already registered') {
      return res.status(409).json({ error: error.message })
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    res.status(500).json({ error: `Registration failed: ${errorMessage}` })
  }
})

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const admin = await verifyAdmin(email, password)
    if (!admin) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const token = generateToken(admin)

    res.json({
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        shareToken: admin.share_token,
      },
    })
  } catch (error) {
    console.error('[Auth] Login error:', error)
    res.status(500).json({ error: 'Login failed' })
  }
})

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    admin: {
      id: req.admin!.id,
      email: req.admin!.email,
      shareToken: req.admin!.share_token,
    },
  })
})

// Validate share token endpoint (for workers to check if link is valid)
app.get('/api/share/:token/validate', async (req, res) => {
  const { token } = req.params
  const valid = await isValidShareToken(token)
  res.json({ valid })
})

const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
})

// Session now keyed by socket.id to allow multiple workers per share token
interface ShareSession {
  shareToken: string // The admin's share token (for filtering)
  sessionId: string // Unique session ID (socket.id)
  name: string
  socketId: string
  startedAt: Date
}

interface DashboardViewer {
  socketId: string
  shareToken: string // The admin's share token (to filter which sessions they see)
}

// Key: socket.id, Value: session data
const activeSessions = new Map<string, ShareSession>()
// Key: socket.id, Value: viewer data
const dashboardViewers = new Map<string, DashboardViewer>()

// Get all sessions for a specific admin's share token
function getSessionsForToken(shareToken: string): ShareSession[] {
  const sessions: ShareSession[] = []
  for (const session of activeSessions.values()) {
    if (session.shareToken === shareToken) {
      sessions.push(session)
    }
  }
  return sessions
}

// Get session by socket ID
function getSessionBySocketId(socketId: string): ShareSession | undefined {
  return activeSessions.get(socketId)
}

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`)

  // Worker joins to share screen
  socket.on('join-share', async (data: { token: string; name?: string }) => {
    const { token, name } = data
    console.log(`[Share] Worker joining: ${token} (${name || 'unnamed'})`)

    // Validate token against database
    const validToken = await isValidShareToken(token)
    if (!validToken) {
      console.log(`[Share] Invalid token: ${token}`)
      socket.emit('share-error', { error: 'Invalid share link' })
      return
    }

    // Generate unique session ID (using socket.id)
    const sessionId = socket.id

    // Store session - keyed by socket.id to allow multiple workers per token
    const session: ShareSession = {
      shareToken: token,
      sessionId,
      name: name || `Worker ${sessionId.slice(0, 6)}`,
      socketId: socket.id,
      startedAt: new Date(),
    }
    activeSessions.set(socket.id, session)

    // Join room for this share token (for signaling)
    socket.join(`share:${token}`)

    // Notify dashboard viewers who are watching this admin's share token
    for (const [viewerSocketId, viewer] of dashboardViewers) {
      if (viewer.shareToken === token) {
        io.to(viewerSocketId).emit('session-joined', {
          sessionId,
          token,
          name: session.name,
          startedAt: session.startedAt,
        })
      }
    }

    socket.emit('share-ready', { token, sessionId })
  })

  // Dashboard viewer joins - now requires JWT auth
  socket.on('join-dashboard', async (data: { token: string }) => {
    const { token: jwtToken } = data

    // Verify JWT
    const admin = await verifySocketToken(jwtToken)
    if (!admin) {
      console.log(`[Dashboard] Invalid auth token for ${socket.id}`)
      socket.emit('dashboard-error', { error: 'Authentication required' })
      return
    }

    console.log(`[Dashboard] Viewer joined: ${socket.id} (admin: ${admin.email})`)
    socket.join('dashboard')
    dashboardViewers.set(socket.id, {
      socketId: socket.id,
      shareToken: admin.share_token,
    })

    // Send only sessions for this admin's share token
    const sessions = getSessionsForToken(admin.share_token).map((s) => ({
      sessionId: s.sessionId,
      token: s.shareToken,
      name: s.name,
      startedAt: s.startedAt,
    }))
    socket.emit('active-sessions', sessions)
  })

  // Dashboard requests to view a specific share (now uses sessionId)
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
    const session = getSessionBySocketId(socket.id)
    console.log(`[Signal] Offer from ${socket.id} to ${data.viewerId}`)
    io.to(data.viewerId).emit('offer', {
      sharerId: socket.id,
      offer: data.offer,
      sessionId: session?.sessionId,
      token: session?.shareToken,
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
    const session = getSessionBySocketId(socket.id)
    if (session) {
      console.log(`[Share] Stopped: session ${session.sessionId}`)
      activeSessions.delete(socket.id)

      // Notify relevant dashboard viewers
      for (const [viewerSocketId, viewer] of dashboardViewers) {
        if (viewer.shareToken === session.shareToken) {
          io.to(viewerSocketId).emit('session-left', { sessionId: session.sessionId })
        }
      }
    }
  })

  // Voice call signaling - Dashboard calling worker (now uses sessionId)
  socket.on('call-request', (data: { sessionId: string }) => {
    const session = activeSessions.get(data.sessionId)
    if (session) {
      console.log(`[Call] Dashboard requesting call with session ${data.sessionId}`)
      io.to(session.socketId).emit('call-incoming', {
        callerId: socket.id,
      })
    }
  })

  // Voice call signaling - Dashboard cancels pending call
  socket.on('call-cancelled', (data: { sessionId: string; token: string }) => {
    const session = activeSessions.get(data.sessionId)
    if (session) {
      console.log(`[Call] Dashboard cancelled call to session ${data.sessionId}`)
      io.to(session.socketId).emit('call-cancelled', {
        token: data.token,
      })
    }
  })

  // Voice call signaling - Worker calling dashboard
  socket.on('worker-call-admin', (data: { token: string; workerName: string }) => {
    const session = getSessionBySocketId(socket.id)
    console.log(`[Call] Worker ${data.token} (${data.workerName}) calling dashboard`)

    // Notify only dashboard viewers watching this admin's share token
    for (const [viewerSocketId, viewer] of dashboardViewers) {
      if (viewer.shareToken === data.token) {
        io.to(viewerSocketId).emit('worker-calling', {
          sessionId: session?.sessionId,
          token: data.token,
          workerName: data.workerName,
          workerId: socket.id,
        })
      }
    }
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
    const session = getSessionBySocketId(socket.id)
    if (session) {
      activeSessions.delete(socket.id)

      // Notify relevant dashboard viewers
      for (const [viewerSocketId, viewer] of dashboardViewers) {
        if (viewer.shareToken === session.shareToken) {
          io.to(viewerSocketId).emit('session-left', { sessionId: session.sessionId })
        }
      }
    }

    // Remove from dashboard viewers
    dashboardViewers.delete(socket.id)
  })
})

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => {
  console.log(`[Server] Signaling server running on http://localhost:${PORT}`)
})
