<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'

const props = defineProps<{
  name: string
  stream?: MediaStream
}>()

const videoElement = ref<HTMLVideoElement | null>(null)

async function playVideo() {
  if (videoElement.value) {
    try {
      await videoElement.value.play()
    } catch (err) {
      console.warn('[WorkerTile] Autoplay failed:', err)
    }
  }
}

watch(
  () => props.stream,
  async (stream) => {
    if (videoElement.value && stream) {
      videoElement.value.srcObject = stream
      await playVideo()
    }
  },
  { immediate: true }
)

onMounted(async () => {
  if (videoElement.value && props.stream) {
    videoElement.value.srcObject = props.stream
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
  <div class="bg-gray-900 rounded-lg overflow-hidden">
    <div class="aspect-video relative">
      <video
        ref="videoElement"
        autoplay
        playsinline
        muted
        class="w-full h-full object-contain"
      ></video>

      <!-- No stream placeholder -->
      <div
        v-if="!stream"
        class="absolute inset-0 flex items-center justify-center text-gray-500"
      >
        <div class="text-center">
          <svg class="w-8 h-8 mx-auto mb-1 opacity-50 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <p class="text-xs">Connecting...</p>
        </div>
      </div>
    </div>
    <div class="px-3 py-2 bg-gray-800">
      <p class="text-white text-sm font-medium truncate">{{ name }}</p>
    </div>
  </div>
</template>
