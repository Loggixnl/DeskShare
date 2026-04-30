<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import type { ActiveSession } from '@/lib/types'

const props = defineProps<{
  session: ActiveSession
}>()

const emit = defineEmits<{
  (e: 'focus', sessionId: string): void
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

watch(
  () => props.session.stream,
  (stream) => {
    if (videoElement.value && stream) {
      videoElement.value.srcObject = stream
    }
  },
  { immediate: true }
)

onMounted(() => {
  if (videoElement.value && props.session.stream) {
    videoElement.value.srcObject = props.session.stream
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
        @click="emit('focus', session.sessionId)"
        class="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white p-2 rounded opacity-0 group-hover:opacity-100 transition"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      </button>
    </div>

    <!-- Info bar -->
    <div class="p-3 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span
          :class="[
            'w-2 h-2 rounded-full',
            connectionBadge[session.connectionState || 'new'],
          ]"
        ></span>
        <span class="text-white font-medium text-sm truncate max-w-[150px]">
          {{ session.name }}
        </span>
      </div>
      <span class="text-gray-400 text-xs">
        {{ formatTime(session.startedAt) }}
      </span>
    </div>
  </div>
</template>
