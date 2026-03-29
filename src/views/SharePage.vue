<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { getSocket, connectSocket, disconnectSocket } from '@/lib/socket'
import {
  createPeerConnection,
  createOffer,
  createAnswer,
  setRemoteDescription,
  addIceCandidate,
  closePeerConnection,
  getDisplayMedia,
  stopMediaStream,
} from '@/lib/webrtc'
import type { ShareStatus } from '@/lib/types'

const route = useRoute()
const token = computed(() => route.params.token as string)

// Worker name - required before sharing
const workerName = ref((route.query.name as string) || '')
const nameError = ref('')

const status = ref<ShareStatus>('idle')
const errorMessage = ref('')
const localStream = ref<MediaStream | null>(null)
const videoElement = ref<HTMLVideoElement | null>(null)

// Track peer connections to dashboard viewers
const peerConnections = new Map<string, RTCPeerConnection>()

// Voice call state
const incomingCall = ref<{ callerId: string } | null>(null)
const callStatus = ref<'idle' | 'ringing' | 'connected'>('idle')
const voicePeerConnection = ref<RTCPeerConnection | null>(null)
const localAudioStream = ref<MediaStream | null>(null)
const currentCallerId = ref<string | null>(null)

// Browser notifications
const notificationPermission = ref<NotificationPermission | 'unsupported'>('default')

async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    notificationPermission.value = 'unsupported'
    console.log('[Notification] Not supported in this browser')
    return
  }

  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission()
    notificationPermission.value = result
    console.log('[Notification] Permission:', result)
  } else {
    notificationPermission.value = Notification.permission
    console.log('[Notification] Already:', Notification.permission)
  }
}

function showCallNotification() {
  console.log('[Notification] Attempting to show notification, permission:', Notification.permission)

  // Play a sound as fallback
  playRingtone()

  if (!('Notification' in window)) {
    console.log('[Notification] Not supported')
    return
  }

  if (Notification.permission !== 'granted') {
    console.log('[Notification] Permission not granted:', Notification.permission)
    return
  }

  try {
    const notification = new Notification('📞 Incoming Call - DeskShare', {
      body: 'Admin wants to talk to you. Click to answer.',
      icon: '/favicon.ico',
      tag: 'incoming-call',
      requireInteraction: true,
      silent: false,
    })

    notification.onclick = () => {
      window.focus()
      notification.close()
    }

    // Close notification when call is answered or rejected
    const checkCallStatus = setInterval(() => {
      if (callStatus.value !== 'ringing') {
        notification.close()
        clearInterval(checkCallStatus)
      }
    }, 500)

    console.log('[Notification] Shown successfully')
  } catch (err) {
    console.error('[Notification] Failed to show:', err)
  }
}

// Ringtone audio
let ringtoneAudio: HTMLAudioElement | null = null

function playRingtone() {
  // Create a simple beep using Web Audio API as fallback
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

    // Beep pattern: on-off-on-off
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

const socket = getSocket()

const statusText = computed(() => {
  switch (status.value) {
    case 'idle':
      return 'Ready to share'
    case 'requesting':
      return 'Requesting permission...'
    case 'sharing':
      return 'Sharing your screen'
    case 'stopped':
      return 'Sharing stopped'
    case 'error':
      return errorMessage.value || 'An error occurred'
  }
})

const statusColor = computed(() => {
  switch (status.value) {
    case 'sharing':
      return 'text-green-400'
    case 'error':
      return 'text-red-400'
    default:
      return 'text-gray-400'
  }
})

async function startSharing() {
  // Validate name
  if (!workerName.value.trim()) {
    nameError.value = 'Please enter your name'
    return
  }
  nameError.value = ''

  try {
    status.value = 'requesting'
    errorMessage.value = ''

    // Get screen share stream
    const stream = await getDisplayMedia()
    localStream.value = stream

    // Show local preview
    if (videoElement.value) {
      videoElement.value.srcObject = stream
    }

    // Handle browser-native stop (user clicks browser stop button)
    stream.getVideoTracks()[0].onended = () => {
      stopSharing()
    }

    status.value = 'sharing'

    // Request notification permission for incoming calls
    requestNotificationPermission()

    // Connect to signaling server
    connectSocket()
    socket.emit('join-share', { token: token.value, name: workerName.value.trim() })
  } catch (err: unknown) {
    status.value = 'error'
    if (err instanceof Error) {
      if (err.name === 'NotAllowedError') {
        errorMessage.value = 'Permission denied. Please allow screen sharing.'
      } else {
        errorMessage.value = err.message
      }
    }
  }
}

function stopSharing() {
  // Stop all tracks
  if (localStream.value) {
    stopMediaStream(localStream.value)
    localStream.value = null
  }

  // Close all peer connections
  peerConnections.forEach((pc) => closePeerConnection(pc))
  peerConnections.clear()

  // Notify server
  socket.emit('share-stopped', { token: token.value })

  // Clear video
  if (videoElement.value) {
    videoElement.value.srcObject = null
  }

  status.value = 'stopped'
}

// Handle viewer joining - create offer for them
socket.on('viewer-joined', async (data: { viewerId: string }) => {
  if (!localStream.value) return

  const pc = createPeerConnection({
    onIceCandidate: (candidate) => {
      socket.emit('ice-candidate', {
        targetId: data.viewerId,
        candidate: candidate.toJSON(),
      })
    },
  })

  // Add local tracks to peer connection
  localStream.value.getTracks().forEach((track) => {
    pc.addTrack(track, localStream.value!)
  })

  peerConnections.set(data.viewerId, pc)

  // Create and send offer
  const offer = await createOffer(pc)
  socket.emit('offer', {
    viewerId: data.viewerId,
    offer,
  })
})

// Handle answer from viewer
socket.on('answer', async (data: { viewerId: string; answer: RTCSessionDescriptionInit }) => {
  const pc = peerConnections.get(data.viewerId)
  if (pc) {
    await setRemoteDescription(pc, data.answer)
  }
})

// Handle ICE candidate from viewer
socket.on('ice-candidate', async (data: { fromId: string; candidate: RTCIceCandidateInit }) => {
  const pc = peerConnections.get(data.fromId)
  if (pc) {
    await addIceCandidate(pc, data.candidate)
  }
})

// Voice call handlers
socket.on('call-incoming', (data: { callerId: string }) => {
  console.log('[Call] Incoming call from:', data.callerId)
  incomingCall.value = { callerId: data.callerId }
  callStatus.value = 'ringing'

  // Show browser notification
  showCallNotification()
})

async function acceptCall() {
  if (!incomingCall.value) return

  try {
    // Get microphone access
    localAudioStream.value = await navigator.mediaDevices.getUserMedia({ audio: true })
    currentCallerId.value = incomingCall.value.callerId

    // Notify dashboard that call was accepted
    socket.emit('call-accepted', {
      callerId: incomingCall.value.callerId,
      token: token.value,
    })

    callStatus.value = 'connected'
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
  callStatus.value = 'idle'
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
  if (voicePeerConnection.value) {
    closePeerConnection(voicePeerConnection.value)
    voicePeerConnection.value = null
  }
  if (localAudioStream.value) {
    localAudioStream.value.getTracks().forEach((track) => track.stop())
    localAudioStream.value = null
  }
  currentCallerId.value = null
  callStatus.value = 'idle'
}

// Handle voice offer from dashboard
socket.on('voice-offer', async (data: { callerId: string; offer: RTCSessionDescriptionInit; token: string }) => {
  if (!localAudioStream.value) return

  const pc = createPeerConnection({
    onIceCandidate: (candidate) => {
      socket.emit('voice-ice-candidate', {
        targetId: data.callerId,
        candidate: candidate.toJSON(),
        token: token.value,
      })
    },
    onTrack: (event) => {
      // Play incoming audio from dashboard
      const audio = new Audio()
      audio.srcObject = event.streams[0]
      audio.play()
    },
  })

  voicePeerConnection.value = pc

  // Add local audio track
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
  console.log('[Call] Dashboard ended call')
  cleanupVoiceCall()
})

onMounted(() => {
  // Validate token exists
  if (!token.value) {
    status.value = 'error'
    errorMessage.value = 'Invalid share link'
  }
})

onUnmounted(() => {
  if (status.value === 'sharing') {
    stopSharing()
  }
  cleanupVoiceCall()
  disconnectSocket()
})
</script>

<template>
  <div class="min-h-screen bg-gray-100 flex items-center justify-center p-4">
    <!-- Incoming call modal -->
    <div
      v-if="callStatus === 'ringing'"
      class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
    >
      <div class="bg-white rounded-xl shadow-2xl p-8 max-w-sm w-full text-center animate-pulse">
        <div class="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg class="w-10 h-10 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
          </svg>
        </div>
        <h3 class="text-xl font-bold text-gray-900 mb-2">Incoming Call</h3>
        <p class="text-gray-600 mb-6">Admin wants to talk to you</p>
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

    <div class="bg-white rounded-xl shadow-lg max-w-lg w-full p-8">
      <div class="text-center mb-6">
        <h1 class="text-2xl font-bold text-gray-900 mb-1">DeskShare</h1>
        <p class="text-gray-500 text-sm">Screen Sharing</p>
      </div>

      <!-- Error state -->
      <div v-if="status === 'error' && !localStream" class="text-center py-8">
        <div class="text-red-500 text-lg mb-4">{{ errorMessage }}</div>
        <button
          v-if="errorMessage !== 'Invalid share link'"
          @click="status = 'idle'"
          class="text-blue-600 hover:underline"
        >
          Try again
        </button>
      </div>

      <!-- Main content -->
      <div v-else>
        <!-- Name input -->
        <div class="mb-6">
          <label for="worker-name" class="block text-sm font-medium text-gray-700 mb-2">
            Your Name <span class="text-red-500">*</span>
          </label>
          <input
            id="worker-name"
            v-model="workerName"
            type="text"
            placeholder="Enter your name"
            :disabled="status === 'sharing'"
            class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:text-gray-500"
          />
          <p v-if="nameError" class="text-red-500 text-sm mt-1">{{ nameError }}</p>
        </div>

        <!-- Instructions -->
        <p class="text-gray-600 text-center mb-6">
          Enter your name and click the button below to share your screen.
        </p>

        <!-- Video preview -->
        <div
          class="bg-gray-900 rounded-lg aspect-video mb-6 overflow-hidden flex items-center justify-center"
        >
          <video
            v-show="localStream"
            ref="videoElement"
            autoplay
            playsinline
            muted
            class="w-full h-full object-contain"
          ></video>
          <div v-if="!localStream" class="text-gray-500">
            <svg
              class="w-16 h-16 mx-auto mb-2 opacity-50"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
            <p class="text-sm">Preview will appear here</p>
          </div>
        </div>

        <!-- Notification permission indicator (only show when sharing) -->
        <div
          v-if="status === 'sharing' && notificationPermission !== 'granted'"
          class="bg-yellow-50 border border-yellow-300 rounded-lg p-3 mb-4 flex items-center justify-between"
        >
          <div class="flex items-center gap-2 text-yellow-800 text-sm">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            <span>Enable notifications to receive call alerts</span>
          </div>
          <button
            @click="requestNotificationPermission"
            class="px-3 py-1 bg-yellow-500 hover:bg-yellow-600 text-white text-sm font-medium rounded transition"
          >
            Enable
          </button>
        </div>

        <!-- Voice call indicator -->
        <div
          v-if="callStatus === 'connected'"
          class="bg-green-100 border border-green-300 rounded-lg p-4 mb-4 flex items-center justify-between"
        >
          <div class="flex items-center gap-3">
            <div class="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
            <span class="text-green-800 font-medium">Voice call active</span>
          </div>
          <button
            @click="endCallFromWorker"
            class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg transition"
          >
            End Call
          </button>
        </div>

        <!-- Status -->
        <p :class="['text-center mb-4 font-medium', statusColor]">
          {{ statusText }}
        </p>

        <!-- Action buttons -->
        <div class="space-y-3">
          <button
            v-if="status !== 'sharing'"
            @click="startSharing"
            :disabled="status === 'requesting'"
            class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-4 px-6 rounded-lg text-lg transition"
          >
            {{ status === 'requesting' ? 'Starting...' : 'Share my screen' }}
          </button>

          <button
            v-if="status === 'sharing'"
            @click="stopSharing"
            class="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 px-6 rounded-lg transition"
          >
            Stop sharing
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
