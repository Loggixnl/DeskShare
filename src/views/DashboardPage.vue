<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
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
import { currentAdmin, authToken, logout, getShareUrl, setWorkerDashboardEnabled, setMediaType } from '@/lib/auth'
import type { MediaType } from '@/lib/auth'

const router = useRouter()

// Sessions state - now keyed by sessionId instead of token
const sessions = ref<Map<string, ActiveSession>>(new Map())
const peerConnections = new Map<string, RTCPeerConnection>()
// Map sharer socket IDs to sessionIds for ICE candidate routing
const sharerIdToSessionId = new Map<string, string>()

// Voice call state - keyed by sessionId
const callStatus = ref<Map<string, 'idle' | 'calling' | 'connected'>>(new Map())
const voicePeerConnections = new Map<string, RTCPeerConnection>()
const remoteAudioElements = new Map<string, HTMLAudioElement>()
const localAudioStream = ref<MediaStream | null>(null)
const workerIdBySessionId = new Map<string, string>()

// Share link state
const shareLink = computed(() => currentAdmin.value ? getShareUrl(currentAdmin.value.shareToken) : '')
const linkCopied = ref(false)

// Worker dashboard toggle
const workerDashboardEnabled = ref(currentAdmin.value?.workerDashboardEnabled ?? false)
const workerDashboardLoading = ref(false)

async function toggleWorkerDashboard() {
  workerDashboardLoading.value = true
  const newValue = !workerDashboardEnabled.value
  const success = await setWorkerDashboardEnabled(newValue)
  if (success) {
    workerDashboardEnabled.value = newValue
  }
  workerDashboardLoading.value = false
}

// Media type toggle (screen vs webcam)
const currentMediaType = ref<MediaType>(currentAdmin.value?.mediaType ?? 'screen')
const mediaTypeLoading = ref(false)

async function toggleMediaType() {
  mediaTypeLoading.value = true
  const newType: MediaType = currentMediaType.value === 'screen' ? 'webcam' : 'screen'
  const success = await setMediaType(newType)
  if (success) {
    currentMediaType.value = newType
  }
  mediaTypeLoading.value = false
}

async function copyShareLink() {
  if (!shareLink.value) return
  try {
    await navigator.clipboard.writeText(shareLink.value)
    linkCopied.value = true
    setTimeout(() => { linkCopied.value = false }, 2000)
  } catch (err) {
    console.error('Failed to copy:', err)
  }
}

function handleLogout() {
  logout()
  router.push('/login')
}

// Incoming call from worker
const incomingWorkerCall = ref<{ sessionId: string; token: string; workerName: string; workerId: string } | null>(null)
let ringtoneInterval: number | null = null

function playRingtone() {
  stopRingtone()

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

  playBeep()
  ringtoneInterval = window.setInterval(playBeep, 1500)
}

function stopRingtone() {
  if (ringtoneInterval) {
    clearInterval(ringtoneInterval)
    ringtoneInterval = null
  }
}

function getCallStatus(sessionId: string): 'idle' | 'calling' | 'connected' {
  return callStatus.value.get(sessionId) || 'idle'
}

async function acceptWorkerCall() {
  if (!incomingWorkerCall.value) return

  stopRingtone()

  try {
    if (!localAudioStream.value) {
      localAudioStream.value = await navigator.mediaDevices.getUserMedia({ audio: true })
    }

    const { sessionId, token, workerId } = incomingWorkerCall.value

    socket.emit('admin-accept-call', { workerId, token })

    callStatus.value.set(sessionId, 'connected')
    callStatus.value = new Map(callStatus.value)

    await setupVoiceConnection(sessionId, token, workerId)

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

async function initiateCall(sessionId: string) {
  const session = sessions.value.get(sessionId)
  if (!session) return

  try {
    if (!localAudioStream.value) {
      localAudioStream.value = await navigator.mediaDevices.getUserMedia({ audio: true })
    }

    callStatus.value.set(sessionId, 'calling')
    callStatus.value = new Map(callStatus.value)

    // Use sessionId to request call
    socket.emit('call-request', { sessionId })
  } catch (err) {
    console.error('Failed to get microphone:', err)
    alert('Could not access microphone. Please allow microphone access.')
  }
}

async function setupVoiceConnection(sessionId: string, token: string, workerId: string) {
  if (!localAudioStream.value) return

  workerIdBySessionId.set(sessionId, workerId)

  const pc = createPeerConnection({
    onIceCandidate: (candidate) => {
      socket.emit('voice-ice-candidate', {
        targetId: workerId,
        candidate: candidate.toJSON(),
        token,
      })
    },
    onTrack: (event) => {
      console.log('[Voice] Received remote audio track')
      const audio = new Audio()
      audio.srcObject = event.streams[0]
      audio.play().catch(err => console.error('[Voice] Audio play failed:', err))
      // Store audio element for cleanup
      remoteAudioElements.set(sessionId, audio)
    },
  })

  localAudioStream.value.getTracks().forEach((track) => {
    pc.addTrack(track, localAudioStream.value!)
  })

  voicePeerConnections.set(sessionId, pc)

  const offer = await createOffer(pc)
  socket.emit('voice-offer', {
    targetId: workerId,
    offer,
    token,
  })
}

function endCall(sessionId: string) {
  const session = sessions.value.get(sessionId)
  const workerId = workerIdBySessionId.get(sessionId)
  if (workerId && session) {
    socket.emit('call-ended', { targetId: workerId, token: session.token })
  }

  // Stop remote audio
  const audio = remoteAudioElements.get(sessionId)
  if (audio) {
    audio.pause()
    audio.srcObject = null
    remoteAudioElements.delete(sessionId)
  }

  // Close peer connection
  const vpc = voicePeerConnections.get(sessionId)
  if (vpc) {
    closePeerConnection(vpc)
    voicePeerConnections.delete(sessionId)
  }

  // Stop local audio tracks for this call
  if (localAudioStream.value) {
    localAudioStream.value.getTracks().forEach(track => track.stop())
    localAudioStream.value = null
  }

  workerIdBySessionId.delete(sessionId)
  callStatus.value.set(sessionId, 'idle')
  callStatus.value = new Map(callStatus.value)
}

function cancelCall(sessionId: string) {
  const session = sessions.value.get(sessionId)
  if (session) {
    // Notify worker that call was cancelled
    socket.emit('call-cancelled', { sessionId, token: session.token })
  }

  // Reset call status
  callStatus.value.set(sessionId, 'idle')
  callStatus.value = new Map(callStatus.value)
}

// Focus mode - now uses sessionId
const focusedSessionId = ref<string | null>(null)
const focusedSession = computed(() =>
  focusedSessionId.value ? sessions.value.get(focusedSessionId.value) : null
)
const focusVideoElement = ref<HTMLVideoElement | null>(null)

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

function initDashboard() {
  connectSocket()
  // Send JWT token for authentication
  socket.emit('join-dashboard', { token: authToken.value })
}

// Handle dashboard auth error
socket.on('dashboard-error', (data: { error: string }) => {
  console.error('[Dashboard] Auth error:', data.error)
  logout()
  router.push('/login')
})

// Handle receiving active sessions on join - now includes sessionId
socket.on('active-sessions', (data: Array<{ sessionId: string; token: string; name: string; startedAt: string }>) => {
  data.forEach((session) => {
    sessions.value.set(session.sessionId, {
      sessionId: session.sessionId,
      token: session.token,
      name: session.name,
      startedAt: new Date(session.startedAt),
    })
    // Request offer using sessionId
    socket.emit('request-offer', { sessionId: session.sessionId })
  })
})

// Handle new session joining - now includes sessionId
socket.on('session-joined', (data: { sessionId: string; token: string; name: string; startedAt: string }) => {
  sessions.value.set(data.sessionId, {
    sessionId: data.sessionId,
    token: data.token,
    name: data.name,
    startedAt: new Date(data.startedAt),
  })
  socket.emit('request-offer', { sessionId: data.sessionId })
})

// Handle session leaving - now uses sessionId
socket.on('session-left', (data: { sessionId: string }) => {
  sessions.value.delete(data.sessionId)
  const pc = peerConnections.get(data.sessionId)
  if (pc) {
    closePeerConnection(pc)
    peerConnections.delete(data.sessionId)
  }
  // Clean up sharer ID mapping
  for (const [sharerId, sessionId] of sharerIdToSessionId) {
    if (sessionId === data.sessionId) {
      sharerIdToSessionId.delete(sharerId)
      break
    }
  }
  if (focusedSessionId.value === data.sessionId) {
    focusedSessionId.value = null
  }
})

// Handle offer from sharer - now includes sessionId
socket.on(
  'offer',
  async (data: { sharerId: string; offer: RTCSessionDescriptionInit; sessionId: string; token: string }) => {
    sharerIdToSessionId.set(data.sharerId, data.sessionId)

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
  const sessionId = sharerIdToSessionId.get(data.fromId)
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

// Voice call event handlers

// Worker calling admin - now includes sessionId
socket.on('worker-calling', (data: { sessionId: string; token: string; workerName: string; workerId: string }) => {
  console.log('[Call] Worker calling:', data.workerName)
  incomingWorkerCall.value = {
    sessionId: data.sessionId,
    token: data.token,
    workerName: data.workerName,
    workerId: data.workerId,
  }

  playRingtone()

  if ('Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(`${data.workerName} is calling`, {
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
  console.log('[Call] Worker accepted')
  // Find session by token (worker doesn't know sessionId)
  for (const [sessionId, session] of sessions.value) {
    if (session.token === data.token) {
      callStatus.value.set(sessionId, 'connected')
      callStatus.value = new Map(callStatus.value)
      await setupVoiceConnection(sessionId, data.token, data.workerId)
      break
    }
  }
})

socket.on('call-rejected', (data: { token: string }) => {
  console.log('[Call] Worker rejected')
  for (const [sessionId, session] of sessions.value) {
    if (session.token === data.token) {
      callStatus.value.set(sessionId, 'idle')
      callStatus.value = new Map(callStatus.value)
      break
    }
  }
})

socket.on('call-ended', (data: { token: string }) => {
  console.log('[Call] Worker ended call')
  for (const [sessionId, session] of sessions.value) {
    if (session.token === data.token) {
      const vpc = voicePeerConnections.get(sessionId)
      if (vpc) {
        closePeerConnection(vpc)
        voicePeerConnections.delete(sessionId)
      }
      workerIdBySessionId.delete(sessionId)
      callStatus.value.set(sessionId, 'idle')
      callStatus.value = new Map(callStatus.value)
      break
    }
  }
})

socket.on('voice-answer', async (data: { workerId: string; answer: RTCSessionDescriptionInit; token: string }) => {
  console.log('[Voice] Received voice answer from worker:', data.workerId)

  // Find sessionId by workerId
  let targetSessionId: string | null = null
  for (const [sessionId, workerId] of workerIdBySessionId) {
    if (workerId === data.workerId) {
      targetSessionId = sessionId
      break
    }
  }

  if (targetSessionId) {
    const pc = voicePeerConnections.get(targetSessionId)
    if (pc) {
      console.log('[Voice] Setting remote description for session:', targetSessionId)
      await setRemoteDescription(pc, data.answer)
    }
  } else {
    console.warn('[Voice] Could not find session for worker:', data.workerId)
  }
})

socket.on('voice-ice-candidate', async (data: { fromId: string; candidate: RTCIceCandidateInit; token: string }) => {
  // Find sessionId by workerId (fromId)
  let targetSessionId: string | null = null
  for (const [sessionId, workerId] of workerIdBySessionId) {
    if (workerId === data.fromId) {
      targetSessionId = sessionId
      break
    }
  }

  if (targetSessionId) {
    const pc = voicePeerConnections.get(targetSessionId)
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
  initDashboard()
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
  sharerIdToSessionId.clear()
  workerIdBySessionId.clear()
  disconnectSocket()
})
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

  <!-- Dashboard -->
  <div class="min-h-screen bg-gray-900">
    <!-- Header -->
    <header class="bg-gray-800 border-b border-gray-700 px-6 py-4">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-bold text-white">DeskShare Dashboard</h1>
        <div class="flex items-center gap-4">
          <span class="text-gray-400">
            <span class="text-white font-semibold">{{ sessionList.length }}</span>
            active {{ sessionList.length === 1 ? 'session' : 'sessions' }}
          </span>
          <span class="text-gray-500">|</span>
          <span class="text-gray-400 text-sm">{{ currentAdmin?.email }}</span>
          <button
            @click="handleLogout"
            class="text-gray-400 hover:text-white transition text-sm"
          >
            Logout
          </button>
        </div>
      </div>
    </header>

    <!-- Share Link Banner -->
    <div class="bg-gray-800 border-b border-gray-700 px-6 py-3">
      <div class="flex items-center gap-4">
        <span class="text-gray-400 text-sm">Your share link:</span>
        <code class="bg-gray-900 text-blue-400 px-3 py-1 rounded text-sm font-mono flex-1 truncate">
          {{ shareLink }}
        </code>
        <button
          @click="copyShareLink"
          class="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded transition flex items-center gap-2"
        >
          <svg v-if="!linkCopied" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
          </svg>
          <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          {{ linkCopied ? 'Copied!' : 'Copy' }}
        </button>
        <span class="text-gray-600">|</span>
        <!-- Media Type Toggle -->
        <div class="flex items-center gap-2">
          <span class="text-gray-400 text-sm">Workers share:</span>
          <button
            @click="toggleMediaType"
            :disabled="mediaTypeLoading"
            :class="[
              'px-3 py-1 rounded text-xs font-medium transition-colors',
              currentMediaType === 'screen'
                ? 'bg-blue-600 text-white'
                : 'bg-purple-600 text-white',
              mediaTypeLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
            ]"
          >
            {{ currentMediaType === 'screen' ? 'Screen' : 'Webcam' }}
          </button>
        </div>
        <span class="text-gray-600">|</span>
        <!-- Worker Dashboard Toggle -->
        <div class="flex items-center gap-2">
          <span class="text-gray-400 text-sm">Workers see each other:</span>
          <button
            @click="toggleWorkerDashboard"
            :disabled="workerDashboardLoading"
            :class="[
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              workerDashboardEnabled ? 'bg-blue-600' : 'bg-gray-600',
              workerDashboardLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
            ]"
          >
            <span
              :class="[
                'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                workerDashboardEnabled ? 'translate-x-6' : 'translate-x-1'
              ]"
            />
          </button>
        </div>
      </div>
    </div>

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
        <p class="text-sm mt-1">Share your link with workers to get started</p>
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
          :call-status="getCallStatus(session.sessionId || '')"
          @focus="focusSession(session.sessionId || '')"
          @call="initiateCall(session.sessionId || '')"
          @hangup="endCall(session.sessionId || '')"
          @cancel-call="cancelCall(session.sessionId || '')"
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
