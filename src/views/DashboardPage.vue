<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { getSocket, connectSocket, disconnectSocket } from '@/lib/socket'
import {
  createPeerConnection,
  createAnswer,
  createOffer,
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

// Sessions state
const sessions = ref<Map<string, ActiveSession>>(new Map())
const peerConnections = new Map<string, RTCPeerConnection>()
// Map sharer socket IDs to tokens for ICE candidate routing
const sharerIdToToken = new Map<string, string>()

// Voice call state
const callStatus = ref<Map<string, 'idle' | 'calling' | 'connected'>>(new Map())
const voicePeerConnections = new Map<string, RTCPeerConnection>()
const localAudioStream = ref<MediaStream | null>(null)
const workerIdByToken = new Map<string, string>()

// Incoming call from worker
const incomingWorkerCall = ref<{ token: string; workerName: string; workerId: string } | null>(null)
let ringtoneInterval: number | null = null

function playRingtone() {
  // Stop any existing ringtone
  stopRingtone()

  // Play repeating ring sound
  const playBeep = () => {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()
      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)
      oscillator.frequency.value = 440
      oscillator.type = 'sine'
      gainNode.gain.value = 0.3
      oscillator.start()

      // Ring pattern: beep-beep
      setTimeout(() => { gainNode.gain.value = 0 }, 150)
      setTimeout(() => { gainNode.gain.value = 0.3 }, 250)
      setTimeout(() => { gainNode.gain.value = 0 }, 400)
      setTimeout(() => {
        oscillator.stop()
        audioContext.close()
      }, 500)
    } catch (e) {
      console.log('[Ringtone] Could not play')
    }
  }

  // Play immediately and then repeat
  playBeep()
  ringtoneInterval = window.setInterval(playBeep, 1500)
}

function stopRingtone() {
  if (ringtoneInterval) {
    clearInterval(ringtoneInterval)
    ringtoneInterval = null
  }
}

function getCallStatus(token: string): 'idle' | 'calling' | 'connected' {
  return callStatus.value.get(token) || 'idle'
}

async function acceptWorkerCall() {
  if (!incomingWorkerCall.value) return

  stopRingtone()

  try {
    // Get microphone access
    if (!localAudioStream.value) {
      localAudioStream.value = await navigator.mediaDevices.getUserMedia({ audio: true })
    }

    const { token, workerId } = incomingWorkerCall.value

    // Notify worker that we accepted
    socket.emit('admin-accept-call', { workerId, token })

    // Set up voice connection
    callStatus.value.set(token, 'connected')
    callStatus.value = new Map(callStatus.value)

    await setupVoiceConnection(token, workerId)

    incomingWorkerCall.value = null
  } catch (err) {
    console.error('Failed to get microphone:', err)
    alert('Could not access microphone. Please allow microphone access.')
    rejectWorkerCall()
  }
}

function rejectWorkerCall() {
  if (!incomingWorkerCall.value) return

  stopRingtone()

  socket.emit('admin-reject-call', {
    workerId: incomingWorkerCall.value.workerId,
    token: incomingWorkerCall.value.token
  })

  incomingWorkerCall.value = null
}

async function initiateCall(token: string) {
  try {
    // Get microphone access
    if (!localAudioStream.value) {
      localAudioStream.value = await navigator.mediaDevices.getUserMedia({ audio: true })
    }

    callStatus.value.set(token, 'calling')
    callStatus.value = new Map(callStatus.value) // Trigger reactivity

    // Send call request to worker
    socket.emit('call-request', { token })
  } catch (err) {
    console.error('Failed to get microphone:', err)
    alert('Could not access microphone. Please allow microphone access.')
  }
}

async function setupVoiceConnection(token: string, workerId: string) {
  if (!localAudioStream.value) return

  workerIdByToken.set(token, workerId)

  const pc = createPeerConnection({
    onIceCandidate: (candidate) => {
      socket.emit('voice-ice-candidate', {
        targetId: workerId,
        candidate: candidate.toJSON(),
        token,
      })
    },
    onTrack: (event) => {
      // Play incoming audio from worker
      const audio = new Audio()
      audio.srcObject = event.streams[0]
      audio.play()
    },
  })

  // Add local audio track
  localAudioStream.value.getTracks().forEach((track) => {
    pc.addTrack(track, localAudioStream.value!)
  })

  voicePeerConnections.set(token, pc)

  // Create and send offer
  const offer = await createOffer(pc)
  socket.emit('voice-offer', {
    targetId: workerId,
    offer,
    token,
  })
}

function endCall(token: string) {
  const workerId = workerIdByToken.get(token)
  if (workerId) {
    socket.emit('call-ended', { targetId: workerId, token })
  }

  // Clean up voice peer connection
  const vpc = voicePeerConnections.get(token)
  if (vpc) {
    closePeerConnection(vpc)
    voicePeerConnections.delete(token)
  }

  workerIdByToken.delete(token)
  callStatus.value.set(token, 'idle')
  callStatus.value = new Map(callStatus.value)
}

// Focus mode
const focusedToken = ref<string | null>(null)
const focusedSession = computed(() =>
  focusedToken.value ? sessions.value.get(focusedToken.value) : null
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
  // For MVP, just check against a simple password
  // In production, this should validate against env var on server
  const validPassword = 'admin' // Change in production
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
socket.on('active-sessions', (data: Array<{ token: string; name: string; startedAt: string }>) => {
  data.forEach((session) => {
    sessions.value.set(session.token, {
      token: session.token,
      name: session.name,
      startedAt: new Date(session.startedAt),
    })
    // Request offer from each active session
    socket.emit('request-offer', { token: session.token })
  })
})

// Handle new session joining
socket.on('session-joined', (data: { token: string; name: string; startedAt: string }) => {
  sessions.value.set(data.token, {
    token: data.token,
    name: data.name,
    startedAt: new Date(data.startedAt),
  })
  // Request offer from new session
  socket.emit('request-offer', { token: data.token })
})

// Handle session leaving
socket.on('session-left', (data: { token: string }) => {
  sessions.value.delete(data.token)
  const pc = peerConnections.get(data.token)
  if (pc) {
    closePeerConnection(pc)
    peerConnections.delete(data.token)
  }
  // Clean up sharer ID mapping
  for (const [sharerId, token] of sharerIdToToken) {
    if (token === data.token) {
      sharerIdToToken.delete(sharerId)
      break
    }
  }
  if (focusedToken.value === data.token) {
    focusedToken.value = null
  }
})

// Handle offer from sharer
socket.on(
  'offer',
  async (data: { sharerId: string; offer: RTCSessionDescriptionInit; token: string }) => {
    // Store mapping for ICE candidate routing
    sharerIdToToken.set(data.sharerId, data.token)

    const pc = createPeerConnection({
      onIceCandidate: (candidate) => {
        socket.emit('ice-candidate', {
          targetId: data.sharerId,
          candidate: candidate.toJSON(),
        })
      },
      onTrack: (event) => {
        const session = sessions.value.get(data.token)
        if (session) {
          session.stream = event.streams[0]
          sessions.value.set(data.token, { ...session })
        }
      },
      onConnectionStateChange: (state) => {
        const session = sessions.value.get(data.token)
        if (session) {
          session.connectionState = state
          sessions.value.set(data.token, { ...session })
        }
      },
    })

    peerConnections.set(data.token, pc)

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
  const token = sharerIdToToken.get(data.fromId)
  if (token) {
    const pc = peerConnections.get(token)
    if (pc) {
      try {
        await addIceCandidate(pc, data.candidate)
      } catch {
        // ICE candidate might arrive before remote description
      }
    }
  }
})

// Voice call event handlers

// Worker calling admin
socket.on('worker-calling', (data: { token: string; workerName: string; workerId: string }) => {
  console.log('[Call] Worker calling:', data.workerName)
  incomingWorkerCall.value = {
    token: data.token,
    workerName: data.workerName,
    workerId: data.workerId,
  }

  // Play repeating ringtone
  playRingtone()

  // Show browser notification
  if ('Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(`📞 ${data.workerName} is calling`, {
      body: 'Click to answer',
      requireInteraction: true,
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
  }
})

socket.on('call-accepted', async (data: { token: string; workerId: string }) => {
  console.log('[Call] Worker accepted:', data.token)
  callStatus.value.set(data.token, 'connected')
  callStatus.value = new Map(callStatus.value)
  await setupVoiceConnection(data.token, data.workerId)
})

socket.on('call-rejected', (data: { token: string }) => {
  console.log('[Call] Worker rejected:', data.token)
  callStatus.value.set(data.token, 'idle')
  callStatus.value = new Map(callStatus.value)
})

socket.on('call-ended', (data: { token: string }) => {
  console.log('[Call] Worker ended call:', data.token)
  const vpc = voicePeerConnections.get(data.token)
  if (vpc) {
    closePeerConnection(vpc)
    voicePeerConnections.delete(data.token)
  }
  workerIdByToken.delete(data.token)
  callStatus.value.set(data.token, 'idle')
  callStatus.value = new Map(callStatus.value)
})

socket.on('voice-answer', async (data: { workerId: string; answer: RTCSessionDescriptionInit; token: string }) => {
  const pc = voicePeerConnections.get(data.token)
  if (pc) {
    await setRemoteDescription(pc, data.answer)
  }
})

socket.on('voice-ice-candidate', async (data: { fromId: string; candidate: RTCIceCandidateInit; token: string }) => {
  const pc = voicePeerConnections.get(data.token)
  if (pc) {
    try {
      await addIceCandidate(pc, data.candidate)
    } catch {
      // ICE candidate might arrive before remote description
    }
  }
})

function focusSession(token: string) {
  focusedToken.value = token
}

function closeFocus() {
  focusedToken.value = null
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
  stopRingtone()
  peerConnections.forEach((pc) => closePeerConnection(pc))
  peerConnections.clear()
  voicePeerConnections.forEach((pc) => closePeerConnection(pc))
  voicePeerConnections.clear()
  if (localAudioStream.value) {
    localAudioStream.value.getTracks().forEach((track) => track.stop())
  }
  sharerIdToToken.clear()
  workerIdByToken.clear()
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
  <!-- Incoming call from worker modal -->
  <div
    v-if="incomingWorkerCall"
    class="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
  >
    <div class="bg-gray-800 rounded-xl shadow-2xl p-8 max-w-sm w-full text-center">
      <div class="w-20 h-20 bg-green-900 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
        <svg class="w-10 h-10 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
        </svg>
      </div>
      <h3 class="text-xl font-bold text-white mb-2">Incoming Call</h3>
      <p class="text-gray-300 mb-6">{{ incomingWorkerCall.workerName }} is calling you</p>
      <div class="flex gap-4 justify-center">
        <button
          @click="rejectWorkerCall"
          class="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg transition"
        >
          Decline
        </button>
        <button
          @click="acceptWorkerCall"
          class="px-6 py-3 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg transition"
        >
          Accept
        </button>
      </div>
    </div>
  </div>

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
          :key="session.token"
          :session="session"
          :call-status="getCallStatus(session.token)"
          @focus="focusSession"
          @call="initiateCall"
          @hangup="endCall"
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
