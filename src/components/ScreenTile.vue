<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import type { ActiveSession } from '@/lib/types'

const props = defineProps<{
  session: ActiveSession
  callStatus?: 'idle' | 'calling' | 'connected'
  hideCallButton?: boolean
  hideMediaToggle?: boolean
  workerMediaType?: 'screen' | 'webcam'
}>()

const emit = defineEmits<{
  (e: 'focus', sessionId: string): void
  (e: 'call', sessionId: string): void
  (e: 'hangup', sessionId: string): void
  (e: 'cancelCall', sessionId: string): void
  (e: 'toggleMedia', sessionId: string, newType: 'screen' | 'webcam'): void
}>()

const videoElement = ref<HTMLVideoElement | null>(null)

const connectionBadge = {
  connected: 'bg-green-500',
  connecting: 'bg-yellow-500',
  disconnected: 'bg-red-500',
  failed: 'bg-red-500',
  closed: 'bg-gray-500',
  new: 'bg-blue-500',
}

function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString()
}

// Explicitly play video to fix Windows black screen issue
async function playVideo() {
  if (videoElement.value) {
    try {
      await videoElement.value.play()
    } catch (err) {
      console.warn('[Video] Autoplay failed, user interaction may be required:', err)
    }
  }
}

watch(
  () => props.session.stream,
  async (stream) => {
    if (videoElement.value && stream) {
      videoElement.value.srcObject = stream
      await playVideo()
    }
  },
  { immediate: true }
)

onMounted(async () => {
  if (videoElement.value && props.session.stream) {
    videoElement.value.srcObject = props.session.stream
    await playVideo()
  }
})

onUnmounted(() => {
  if (videoElement.value) {
    videoElement.value.srcObject = null
  }
})
</script>

<template>
  <div class="bg-gray-800 rounded-lg overflow-hidden group">
    <!-- Video container -->
    <div class="aspect-video bg-gray-900 relative">
      <video
        ref="videoElement"
        autoplay
        playsinline
        muted
        class="w-full h-full object-contain"
      ></video>

      <!-- No stream placeholder -->
      <div
        v-if="!session.stream"
        class="absolute inset-0 flex items-center justify-center text-gray-500"
      >
        <div class="text-center">
          <svg class="w-12 h-12 mx-auto mb-2 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <p class="text-sm">Connecting...</p>
        </div>
      </div>

      <!-- Focus button (shows on hover) -->
      <button
        @click="emit('focus', session.sessionId || session.token)"
        class="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white p-2 rounded opacity-0 group-hover:opacity-100 transition"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      </button>
    </div>

    <!-- Info bar -->
    <div class="p-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span
            :class="[
              'w-2 h-2 rounded-full',
              connectionBadge[session.connectionState || 'new'],
            ]"
          ></span>
          <span class="text-white font-medium text-sm truncate max-w-[120px]">
            {{ session.name }}
          </span>
          <!-- Call buttons (only shown if not hidden) -->
          <template v-if="!hideCallButton">
          <!-- Call button (idle state) -->
          <button
            v-if="callStatus === 'idle' || !callStatus"
            @click.stop="emit('call', session.sessionId || session.token)"
            class="p-1.5 rounded-full bg-gray-700 hover:bg-green-600 transition"
            title="Start voice call"
          >
            <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </button>
          <!-- Cancel call button (calling state) -->
          <button
            v-else-if="callStatus === 'calling'"
            @click.stop="emit('cancelCall', session.sessionId || session.token)"
            class="p-1.5 rounded-full bg-yellow-500 hover:bg-red-600 animate-pulse transition"
            title="Cancel call"
          >
            <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <!-- Hangup button (when connected) -->
          <button
            v-else
            @click.stop="emit('hangup', session.sessionId || session.token)"
            class="p-1.5 rounded-full bg-red-600 hover:bg-red-700 transition animate-pulse"
            title="End call"
          >
            <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
            </svg>
          </button>
        </template>
        </div>
        <span class="text-gray-400 text-xs">
          {{ formatTime(session.startedAt) }}
        </span>
      </div>
      <!-- Media type toggle (admin only) -->
      <div v-if="!hideMediaToggle" class="mt-2 flex items-center justify-between">
        <span class="text-gray-400 text-xs">Share:</span>
        <div class="flex gap-1">
          <button
            @click.stop="emit('toggleMedia', session.sessionId || session.token, 'screen')"
            :class="[
              'px-2 py-0.5 rounded text-xs font-medium transition',
              workerMediaType === 'screen' || !workerMediaType
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            ]"
          >
            Screen
          </button>
          <button
            @click.stop="emit('toggleMedia', session.sessionId || session.token, 'webcam')"
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
</template>
