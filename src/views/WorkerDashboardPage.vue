<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { getSocket, connectSocket, disconnectSocket } from '@/lib/socket'
import {
  createPeerConnection,
  createAnswer,
  createOffer,
  setRemoteDescription,
  addIceCandidate,
  closePeerConnection,
  getDisplayMedia,
  getUserMediaVideo,
  replaceVideoTrack,
  stopMediaStream,
} from '@/lib/webrtc'
import type { ActiveSession } from '@/lib/types'
import ScreenTile from '@/components/ScreenTile.vue'
import {
  workerStream,
  workerSessionId,
  workerToken,
  workerName,
  workerMediaType,
  workerPeerConnections,
  clearWorkerSession,
  isWorkerActive,
} from '@/lib/workerState'

const router = useRouter()
const route = useRoute()
const token = computed(() => route.params.token as string)

// Sessions state - other workers
const sessions = ref<Map<string, ActiveSession>>(new Map())
const peerConnections = new Map<string, RTCPeerConnection>()
const sharerIdToSessionId = new Map<string, string>()

// Voice call state
const callStatus = ref<Map<string, 'idle' | 'calling' | 'connected'>>(new Map())
const voicePeerConnections = new Map<string, RTCPeerConnection>()
const remoteAudioElements = new Map<string, HTMLAudioElement>()
const localAudioStream = ref<MediaStream | null>(null)
const workerIdBySessionId = new Map<string, string>()

// Incoming call from admin
const incomingCall = ref<{ callerId: string } | null>(null)
const currentCallerId = ref<string | null>(null)
const remoteAudio = ref<HTMLAudioElement | null>(null)
const voicePeerConnection = ref<RTCPeerConnection | null>(null)

// Focus mode
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

// Own session for display in the grid
const ownSession = computed<ActiveSession | null>(() => {
  if (!workerStream.value || !workerSessionId.value) return null
  return {
    sessionId: workerSessionId.value,
    token: workerToken.value || '',
    name: workerName.value || 'Me',
    startedAt: new Date(),
    stream: workerStream.value,
    connectionState: 'connected',
  }
})

// Video element for own tile
const ownVideoElement = ref<HTMLVideoElement | null>(null)

// Watch own stream to update video element
watch(workerStream, async (stream) => {
  await nextTick()
  if (ownVideoElement.value) {
    ownVideoElement.value.srcObject = stream
  }
}, { immediate: true })

// Ringtone
function playRingtone() {
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
    setTimeout(() => { gainNode.gain.value = 0 }, 200)
    setTimeout(() => { gainNode.gain.value = 0.3 }, 400)
    setTimeout(() => { gainNode.gain.value = 0 }, 600)
    setTimeout(() => { gainNode.gain.value = 0.3 }, 800)
    setTimeout(() => {
      oscillator.stop()
      audioContext.close()
    }, 1000)
  } catch (err) {
    console.log('[Ringtone] Could not play:', err)
  }
}

function getCallStatus(sessionId: string): 'idle' | 'calling' | 'connected' {
  return callStatus.value.get(sessionId) || 'idle'
}

// Stop sharing and go back to share page
function stopSharing() {
  // Stop the stream
  if (workerStream.value) {
    stopMediaStream(workerStream.value)
  }

  // Close peer connections for viewers
  workerPeerConnections.forEach(pc => closePeerConnection(pc))
  workerPeerConnections.clear()

  // Notify server
  socket.emit('share-stopped', { token: token.value })

  // Clear worker session
  clearWorkerSession()

  // Go back to share page
  router.push({ name: 'share', params: { token: token.value } })
}

// Initialize dashboard
function initDashboard() {
  // Clear the transitioning flag
  sessionStorage.removeItem('workerTransitioning')

  connectSocket()

  // Join as worker viewer
  socket.emit('join-dashboard', {
    token: token.value,
    asWorker: true,
    workerSessionId: workerSessionId.value,
  })
}

// Handle dashboard auth error
socket.on('dashboard-error', (data: { error: string }) => {
  console.error('[Worker Dashboard] Error:', data.error)
  router.push({ name: 'share', params: { token: token.value } })
})

// Handle receiving active sessions
socket.on('active-sessions', (data: Array<{ sessionId: string; token: string; name: string; startedAt: string }>) => {
  console.log('[Worker Dashboard] Active sessions:', data.length)
  data.forEach((session) => {
    // Don't add ourselves
    if (session.sessionId === workerSessionId.value) return

    sessions.value.set(session.sessionId, {
      sessionId: session.sessionId,
      token: session.token,
      name: session.name,
      startedAt: new Date(session.startedAt),
    })
    socket.emit('request-offer', { sessionId: session.sessionId })
  })
})

// Handle new session joining
socket.on('session-joined', (data: { sessionId: string; token: string; name: string; startedAt: string }) => {
  // Don't add ourselves
  if (data.sessionId === workerSessionId.value) return

  sessions.value.set(data.sessionId, {
    sessionId: data.sessionId,
    token: data.token,
    name: data.name,
    startedAt: new Date(data.startedAt),
  })
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

// Handle offer from another worker
socket.on('offer', async (data: { sharerId: string; offer: RTCSessionDescriptionInit; sessionId: string; token: string }) => {
  // Don't process our own offers
  if (data.sessionId === workerSessionId.value) return

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
})

// Handle ICE candidate
socket.on('ice-candidate', async (data: { fromId: string; candidate: RTCIceCandidateInit }) => {
  // Check if this is from a worker we're viewing
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
    return
  }

  // Check if this is from a viewer watching us
  const viewerPc = workerPeerConnections.get(data.fromId)
  if (viewerPc) {
    try {
      await addIceCandidate(viewerPc, data.candidate)
    } catch {
      // ICE candidate might arrive before remote description
    }
  }
})

// Handle viewer joining (dashboard wants to watch us)
socket.on('viewer-joined', async (data: { viewerId: string }) => {
  if (!workerStream.value) return

  console.log('[Worker Dashboard] Viewer joined:', data.viewerId)

  const pc = createPeerConnection({
    onIceCandidate: (candidate) => {
      socket.emit('ice-candidate', {
        targetId: data.viewerId,
        candidate: candidate.toJSON(),
      })
    },
  })

  workerStream.value.getTracks().forEach((track) => {
    pc.addTrack(track, workerStream.value!)
  })

  workerPeerConnections.set(data.viewerId, pc)

  const offer = await createOffer(pc)
  socket.emit('offer', {
    viewerId: data.viewerId,
    offer,
  })
})

// Handle answer from viewer
socket.on('answer', async (data: { viewerId: string; answer: RTCSessionDescriptionInit }) => {
  const pc = workerPeerConnections.get(data.viewerId)
  if (pc) {
    await setRemoteDescription(pc, data.answer)
  }
})

// Handle incoming call from admin
socket.on('call-incoming', (data: { callerId: string }) => {
  console.log('[Call] Incoming call from admin:', data.callerId)
  incomingCall.value = { callerId: data.callerId }
  playRingtone()
})

socket.on('call-cancelled', () => {
  console.log('[Call] Call cancelled by admin')
  incomingCall.value = null
})

async function acceptCall() {
  if (!incomingCall.value) return

  try {
    localAudioStream.value = await navigator.mediaDevices.getUserMedia({ audio: true })
    currentCallerId.value = incomingCall.value.callerId

    socket.emit('call-accepted', {
      callerId: incomingCall.value.callerId,
      token: token.value,
    })

    incomingCall.value = null
  } catch (err) {
    console.error('Failed to get microphone:', err)
    rejectCall()
  }
}

function rejectCall() {
  if (!incomingCall.value) return

  socket.emit('call-rejected', {
    callerId: incomingCall.value.callerId,
    token: token.value,
  })

  incomingCall.value = null
}

function endCallFromWorker() {
  if (currentCallerId.value) {
    socket.emit('call-ended', {
      targetId: currentCallerId.value,
      token: token.value,
    })
  }
  cleanupVoiceCall()
}

function cleanupVoiceCall() {
  if (remoteAudio.value) {
    remoteAudio.value.pause()
    remoteAudio.value.srcObject = null
    remoteAudio.value = null
  }

  if (voicePeerConnection.value) {
    closePeerConnection(voicePeerConnection.value)
    voicePeerConnection.value = null
  }

  if (localAudioStream.value) {
    localAudioStream.value.getTracks().forEach(track => track.stop())
    localAudioStream.value = null
  }

  currentCallerId.value = null
}

// Handle voice offer from admin
socket.on('voice-offer', async (data: { callerId: string; offer: RTCSessionDescriptionInit; token: string }) => {
  console.log('[Voice] Received voice offer from admin:', data.callerId)

  if (!localAudioStream.value) {
    console.error('[Voice] No local audio stream')
    return
  }

  const pc = createPeerConnection({
    onIceCandidate: (candidate) => {
      socket.emit('voice-ice-candidate', {
        targetId: data.callerId,
        candidate: candidate.toJSON(),
        token: token.value,
      })
    },
    onTrack: (event) => {
      console.log('[Voice] Received remote audio track')
      const audio = new Audio()
      audio.srcObject = event.streams[0]
      audio.play().catch(err => console.error('[Voice] Audio play failed:', err))
      remoteAudio.value = audio
    },
  })

  voicePeerConnection.value = pc

  localAudioStream.value.getTracks().forEach((track) => {
    pc.addTrack(track, localAudioStream.value!)
  })

  await setRemoteDescription(pc, data.offer)
  const answer = await createAnswer(pc)

  socket.emit('voice-answer', {
    callerId: data.callerId,
    answer,
    token: token.value,
  })
})

socket.on('voice-ice-candidate', async (data: { fromId: string; candidate: RTCIceCandidateInit; token: string }) => {
  if (voicePeerConnection.value) {
    try {
      await addIceCandidate(voicePeerConnection.value, data.candidate)
    } catch {
      // ICE candidate might arrive before remote description
    }
  }
})

socket.on('call-ended', () => {
  console.log('[Call] Admin ended call')
  cleanupVoiceCall()
})

// Handle media type change from admin (legacy - admin can no longer control this)
socket.on('media-type-changed', async (data: { mediaType: 'screen' | 'webcam' }) => {
  console.log('[Media] Received media type change request:', data.mediaType)
  // We no longer automatically switch - worker controls their own media
})

// Handle toggle from own tile
async function handleOwnMediaToggle(_sessionId: string, newType: 'screen' | 'webcam') {
  if (newType !== workerMediaType.value) {
    await switchMedia(newType)
  }
}

async function switchMedia(type: 'screen' | 'webcam') {
  if (!workerStream.value) return

  const oldStream = workerStream.value
  const oldMediaType = workerMediaType.value

  if (type === oldMediaType) {
    console.log(`[Media] Already on ${type}, nothing to do`)
    return
  }

  try {
    console.log(`[Media] Switching from ${oldMediaType} to ${type}`)

    // Get new stream based on type
    let newStream: MediaStream
    try {
      newStream = type === 'screen'
        ? await getDisplayMedia()
        : await getUserMediaVideo()
    } catch (err) {
      console.error('[Media] Failed to get new stream:', err)
      if (err instanceof Error && err.name === 'NotAllowedError') {
        console.log('[Media] User cancelled media picker, keeping current media')
      }
      return // Don't stop old stream if we couldn't get new one
    }

    // Successfully got new stream - NOW stop old stream tracks
    console.log('[Media] Stopping old stream tracks')
    oldStream.getTracks().forEach(track => {
      track.stop()
      console.log(`[Media] Stopped track: ${track.kind} (${track.label})`)
    })

    // Update worker state
    workerStream.value = newStream
    workerMediaType.value = type

    // Handle browser-native stop for screen share
    if (type === 'screen') {
      newStream.getVideoTracks()[0].onended = () => {
        stopSharing()
      }
    }

    // Replace track in all peer connections
    const newTrack = newStream.getVideoTracks()[0]
    console.log(`[Media] Replacing track in ${workerPeerConnections.size} peer connections`)
    for (const [id, pc] of workerPeerConnections.entries()) {
      try {
        const senders = pc.getSenders()
        const videoSender = senders.find(s => s.track?.kind === 'video')
        if (videoSender) {
          await videoSender.replaceTrack(newTrack)
          console.log(`[Media] Replaced track for peer ${id}`)
        } else {
          console.warn(`[Media] No video sender found for peer ${id}`)
        }
      } catch (e) {
        console.error(`[Media] Failed to replace track for peer ${id}:`, e)
      }
    }

    console.log(`[Media] Successfully switched to ${type}`)
  } catch (err) {
    console.error('[Media] Unexpected error during switch:', err)
  }
}

function focusSession(sessionId: string) {
  focusedSessionId.value = sessionId
}

function closeFocus() {
  focusedSessionId.value = null
}

onMounted(() => {
  // Check if we have an active worker session
  if (!isWorkerActive()) {
    // No active session, redirect back to share page
    router.push({ name: 'share', params: { token: token.value } })
    return
  }

  initDashboard()
})

onUnmounted(() => {
  peerConnections.forEach(pc => closePeerConnection(pc))
  peerConnections.clear()
  voicePeerConnections.forEach(pc => closePeerConnection(pc))
  voicePeerConnections.clear()
  if (localAudioStream.value) {
    localAudioStream.value.getTracks().forEach(track => track.stop())
  }
  sharerIdToSessionId.clear()
  workerIdBySessionId.clear()
  cleanupVoiceCall()
  // Note: Don't clear workerSession here - let stopSharing handle that
})
</script>

<template>
  <!-- Incoming call modal -->
  <div
    v-if="incomingCall"
    class="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
  >
    <div class="bg-gray-800 rounded-xl shadow-2xl p-8 max-w-sm w-full text-center animate-pulse">
      <div class="w-20 h-20 bg-green-900 rounded-full flex items-center justify-center mx-auto mb-4">
        <svg class="w-10 h-10 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
        </svg>
      </div>
      <h3 class="text-xl font-bold text-white mb-2">Incoming Call</h3>
      <p class="text-gray-300 mb-6">Admin wants to talk to you</p>
      <div class="flex gap-4 justify-center">
        <button
          @click="rejectCall"
          class="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg transition"
        >
          Decline
        </button>
        <button
          @click="acceptCall"
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
            <span class="text-white font-semibold">{{ sessionList.length + 1 }}</span>
            {{ sessionList.length + 1 === 1 ? 'worker' : 'workers' }} sharing
          </span>
          <span class="text-gray-500">|</span>
          <span class="text-gray-400 text-sm">You: <span class="text-white">{{ workerName }}</span></span>
          <!-- Voice call indicator -->
          <div
            v-if="currentCallerId"
            class="flex items-center gap-2 px-3 py-1 bg-green-600 rounded-lg animate-pulse"
          >
            <div class="w-2 h-2 bg-white rounded-full"></div>
            <span class="text-white text-sm font-medium">In call</span>
            <button
              @click="endCallFromWorker"
              class="ml-2 p-1 bg-red-600 hover:bg-red-700 rounded"
              title="End call"
            >
              <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <button
            @click="stopSharing"
            class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg transition"
          >
            Stop Sharing
          </button>
        </div>
      </div>
    </header>

    <!-- Grid of screens -->
    <main class="p-6">
      <!-- Screen grid (always show - own tile is always present) -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        <!-- Own tile (first, with special styling) -->
        <div v-if="ownSession" class="bg-gray-800 rounded-lg overflow-hidden ring-2 ring-blue-500">
          <!-- Video container -->
          <div class="aspect-video bg-gray-900 relative">
            <video
              ref="ownVideoElement"
              autoplay
              playsinline
              muted
              class="w-full h-full object-contain"
            ></video>
            <!-- "You" badge -->
            <div class="absolute top-2 left-2 bg-blue-600 text-white text-xs px-2 py-0.5 rounded font-medium">
              You
            </div>
          </div>
          <!-- Info bar -->
          <div class="p-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-green-500"></span>
                <span class="text-white font-medium text-sm truncate max-w-[120px]">
                  {{ workerName }} (You)
                </span>
              </div>
            </div>
            <!-- Media type toggle (only on own tile) -->
            <div class="mt-2 flex items-center justify-between">
              <span class="text-gray-400 text-xs">Share:</span>
              <div class="flex gap-1">
                <button
                  @click="handleOwnMediaToggle(workerSessionId || '', 'screen')"
                  :class="[
                    'px-2 py-0.5 rounded text-xs font-medium transition',
                    workerMediaType === 'screen'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  ]"
                >
                  Screen
                </button>
                <button
                  @click="handleOwnMediaToggle(workerSessionId || '', 'webcam')"
                  :class="[
                    'px-2 py-0.5 rounded text-xs font-medium transition',
                    workerMediaType === 'webcam'
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  ]"
                >
                  Webcam
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Other workers' tiles -->
        <ScreenTile
          v-for="session in sessionList"
          :key="session.sessionId"
          :session="session"
          :call-status="getCallStatus(session.sessionId || '')"
          :hide-call-button="true"
          :hide-media-toggle="true"
          @focus="focusSession(session.sessionId || '')"
        />
      </div>

      <!-- Empty state for other workers -->
      <div
        v-if="sessionList.length === 0"
        class="mt-8 text-center text-gray-500"
      >
        <p class="text-sm">No other workers sharing yet</p>
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
