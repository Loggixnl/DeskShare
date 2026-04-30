<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { getSocket, connectSocket, disconnectSocket } from '@/lib/socket'
import {
  createPeerConnection,
  createOffer,
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
// Buffer ICE candidates that arrive before remote description is set
const pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>()

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

  // Notify server (server identifies session by socket.id)
  socket.emit('share-stopped')

  // Clear video
  if (videoElement.value) {
    videoElement.value.srcObject = null
  }

  status.value = 'stopped'
}

// Handle viewer joining - create offer for them
async function handleViewerJoined(data: { viewerId: string }) {
  if (!localStream.value) return

  // Close any existing peer connection for this viewer
  const existingPc = peerConnections.get(data.viewerId)
  if (existingPc) {
    closePeerConnection(existingPc)
    peerConnections.delete(data.viewerId)
  }

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
}

// Handle answer from viewer
async function handleAnswer(data: { viewerId: string; answer: RTCSessionDescriptionInit }) {
  const pc = peerConnections.get(data.viewerId)
  if (pc) {
    await setRemoteDescription(pc, data.answer)

    // Apply any pending ICE candidates that arrived before the answer
    const pending = pendingIceCandidates.get(data.viewerId)
    if (pending && pending.length > 0) {
      for (const candidate of pending) {
        try {
          await addIceCandidate(pc, candidate)
        } catch {
          // Ignore errors
        }
      }
      pendingIceCandidates.delete(data.viewerId)
    }
  }
}

// Handle ICE candidate from viewer
async function handleIceCandidate(data: { fromId: string; candidate: RTCIceCandidateInit }) {
  const pc = peerConnections.get(data.fromId)

  if (pc && pc.remoteDescription) {
    // Peer connection exists and has remote description, add candidate directly
    try {
      await addIceCandidate(pc, data.candidate)
    } catch {
      // Ignore errors
    }
  } else {
    // Buffer the candidate for later
    const pending = pendingIceCandidates.get(data.fromId) || []
    pending.push(data.candidate)
    pendingIceCandidates.set(data.fromId, pending)
  }
}

socket.on('viewer-joined', handleViewerJoined)
socket.on('answer', handleAnswer)
socket.on('ice-candidate', handleIceCandidate)

onMounted(() => {
  // Validate token exists
  if (!token.value) {
    status.value = 'error'
    errorMessage.value = 'Invalid share link'
  }
})

onUnmounted(() => {
  // Clean up socket event handlers
  socket.off('viewer-joined', handleViewerJoined)
  socket.off('answer', handleAnswer)
  socket.off('ice-candidate', handleIceCandidate)

  if (status.value === 'sharing') {
    stopSharing()
  }
  pendingIceCandidates.clear()
  disconnectSocket()
})
</script>

<template>
  <div class="min-h-screen bg-gray-100 flex items-center justify-center p-4">
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
