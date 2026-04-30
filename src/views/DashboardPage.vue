<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { getSocket, connectSocket, disconnectSocket } from '@/lib/socket'
import {
  createPeerConnection,
  createAnswer,
  setRemoteDescription,
  addIceCandidate,
  closePeerConnection,
} from '@/lib/webrtc'
import type { ActiveSession } from '@/lib/types'
import ScreenTile from '@/components/ScreenTile.vue'

// Simple password auth for MVP
const isAuthenticated = ref(false)
const password = ref('')
const authError = ref('')

// Sessions state (keyed by sessionId)
const sessions = ref<Map<string, ActiveSession>>(new Map())
const peerConnections = new Map<string, RTCPeerConnection>()
// Map sharer socket IDs to sessionIds for ICE candidate routing
const sharerIdToSession = new Map<string, string>()

// Focus mode
const focusedSessionId = ref<string | null>(null)
const focusedSession = computed(() =>
  focusedSessionId.value ? sessions.value.get(focusedSessionId.value) : null
)
const focusVideoElement = ref<HTMLVideoElement | null>(null)

// Update focus video when session changes
watch(
  () => focusedSession.value?.stream,
  async (stream) => {
    await nextTick()
    if (focusVideoElement.value && stream) {
      focusVideoElement.value.srcObject = stream
    }
  }
)

const socket = getSocket()

const sessionList = computed(() => Array.from(sessions.value.values()))

function authenticate() {
  // Simple password check - defaults to 'admin' if not set
  const validPassword = import.meta.env.VITE_DASHBOARD_PASSWORD || 'admin'
  if (password.value === validPassword) {
    isAuthenticated.value = true
    authError.value = ''
    initDashboard()
  } else {
    authError.value = 'Invalid password'
  }
}

function initDashboard() {
  connectSocket()
  socket.emit('join-dashboard')
}

// Handle receiving active sessions on join
socket.on('active-sessions', (data: Array<{ sessionId: string; token: string; name: string; startedAt: string }>) => {
  data.forEach((session) => {
    sessions.value.set(session.sessionId, {
      sessionId: session.sessionId,
      token: session.token,
      name: session.name,
      startedAt: new Date(session.startedAt),
    })
    // Request offer from each active session
    socket.emit('request-offer', { sessionId: session.sessionId })
  })
})

// Handle new session joining
socket.on('session-joined', (data: { sessionId: string; token: string; name: string; startedAt: string }) => {
  sessions.value.set(data.sessionId, {
    sessionId: data.sessionId,
    token: data.token,
    name: data.name,
    startedAt: new Date(data.startedAt),
  })
  // Request offer from new session
  socket.emit('request-offer', { sessionId: data.sessionId })
})

// Handle session leaving
socket.on('session-left', (data: { sessionId: string }) => {
  sessions.value.delete(data.sessionId)
  const pc = peerConnections.get(data.sessionId)
  if (pc) {
    closePeerConnection(pc)
    peerConnections.delete(data.sessionId)
  }
  // Clean up sharer ID mapping
  sharerIdToSession.delete(data.sessionId)
  if (focusedSessionId.value === data.sessionId) {
    focusedSessionId.value = null
  }
})

// Handle offer from sharer
socket.on(
  'offer',
  async (data: { sharerId: string; sessionId: string; offer: RTCSessionDescriptionInit }) => {
    // Store mapping for ICE candidate routing (sharerId is same as sessionId)
    sharerIdToSession.set(data.sharerId, data.sessionId)

    const pc = createPeerConnection({
      onIceCandidate: (candidate) => {
        socket.emit('ice-candidate', {
          targetId: data.sharerId,
          candidate: candidate.toJSON(),
        })
      },
      onTrack: (event) => {
        const session = sessions.value.get(data.sessionId)
        if (session) {
          session.stream = event.streams[0]
          sessions.value.set(data.sessionId, { ...session })
        }
      },
      onConnectionStateChange: (state) => {
        const session = sessions.value.get(data.sessionId)
        if (session) {
          session.connectionState = state
          sessions.value.set(data.sessionId, { ...session })
        }
      },
    })

    peerConnections.set(data.sessionId, pc)

    await setRemoteDescription(pc, data.offer)
    const answer = await createAnswer(pc)
    socket.emit('answer', {
      sharerId: data.sharerId,
      answer,
    })
  }
)

// Handle ICE candidate from sharer
socket.on('ice-candidate', async (data: { fromId: string; candidate: RTCIceCandidateInit }) => {
  // Find the correct peer connection using the sharer ID mapping
  const sessionId = sharerIdToSession.get(data.fromId)
  if (sessionId) {
    const pc = peerConnections.get(sessionId)
    if (pc) {
      try {
        await addIceCandidate(pc, data.candidate)
      } catch {
        // ICE candidate might arrive before remote description
      }
    }
  }
})

function focusSession(sessionId: string) {
  focusedSessionId.value = sessionId
}

function closeFocus() {
  focusedSessionId.value = null
}

onMounted(() => {
  // Check if already authenticated (could use session storage)
  const stored = sessionStorage.getItem('dashboard-auth')
  if (stored === 'true') {
    isAuthenticated.value = true
    initDashboard()
  }
})

onUnmounted(() => {
  peerConnections.forEach((pc) => closePeerConnection(pc))
  peerConnections.clear()
  sharerIdToSession.clear()
  disconnectSocket()
})

// Store auth state
function handleAuth() {
  authenticate()
  if (isAuthenticated.value) {
    sessionStorage.setItem('dashboard-auth', 'true')
  }
}
</script>

<template>
  <!-- Auth gate -->
  <div
    v-if="!isAuthenticated"
    class="min-h-screen bg-gray-900 flex items-center justify-center p-4"
  >
    <div class="bg-gray-800 rounded-xl p-8 w-full max-w-sm">
      <h1 class="text-2xl font-bold text-white mb-6 text-center">Dashboard Access</h1>
      <form @submit.prevent="handleAuth">
        <input
          v-model="password"
          type="password"
          placeholder="Enter password"
          class="w-full bg-gray-700 text-white px-4 py-3 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p v-if="authError" class="text-red-400 text-sm mb-4">{{ authError }}</p>
        <button
          type="submit"
          class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition"
        >
          Enter
        </button>
      </form>
    </div>
  </div>

  <!-- Dashboard -->
  <div v-else class="min-h-screen bg-gray-900">
    <!-- Header -->
    <header class="bg-gray-800 border-b border-gray-700 px-6 py-4">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-bold text-white">DeskShare Dashboard</h1>
        <div class="flex items-center gap-4">
          <span class="text-gray-400">
            <span class="text-white font-semibold">{{ sessionList.length }}</span>
            active {{ sessionList.length === 1 ? 'session' : 'sessions' }}
          </span>
        </div>
      </div>
    </header>

    <!-- Grid of screens -->
    <main class="p-6">
      <!-- Empty state -->
      <div
        v-if="sessionList.length === 0"
        class="flex flex-col items-center justify-center py-20 text-gray-500"
      >
        <svg class="w-20 h-20 mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <p class="text-lg">No active screen shares</p>
        <p class="text-sm mt-1">Waiting for workers to connect...</p>
      </div>

      <!-- Screen grid -->
      <div
        v-else
        class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
      >
        <ScreenTile
          v-for="session in sessionList"
          :key="session.sessionId"
          :session="session"
          @focus="focusSession"
        />
      </div>
    </main>

    <!-- Focus modal -->
    <div
      v-if="focusedSession"
      class="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
      @click.self="closeFocus"
    >
      <div class="relative w-full max-w-6xl">
        <button
          @click="closeFocus"
          class="absolute -top-12 right-0 text-white hover:text-gray-300 transition"
        >
          <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <div class="bg-gray-800 rounded-lg overflow-hidden">
          <div class="aspect-video bg-gray-900">
            <video
              v-if="focusedSession.stream"
              ref="focusVideoElement"
              autoplay
              playsinline
              muted
              class="w-full h-full object-contain"
            ></video>
          </div>
          <div class="p-4 flex items-center justify-between">
            <span class="text-white font-medium">{{ focusedSession.name }}</span>
            <span class="text-gray-400 text-sm">
              Started at {{ new Date(focusedSession.startedAt).toLocaleTimeString() }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
