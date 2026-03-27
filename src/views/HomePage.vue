<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const generatedToken = ref('')
const copied = ref(false)

const shareLink = computed(() => {
  if (!generatedToken.value) return ''
  return `${window.location.origin}/share/${generatedToken.value}`
})

function generateToken(): string {
  return Math.random().toString(36).substring(2, 15)
}

function createShareLink() {
  generatedToken.value = generateToken()
  copied.value = false
}

async function copyLink() {
  await navigator.clipboard.writeText(shareLink.value)
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 2000)
}

function goToDashboard() {
  router.push('/dashboard')
}
</script>

<template>
  <div class="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-8">
    <h1 class="text-4xl font-bold mb-2">DeskShare</h1>
    <p class="text-gray-400 mb-8">Simple one-way screen sharing</p>

    <div class="space-y-4 w-full max-w-md">
      <button
        @click="createShareLink"
        class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition"
      >
        Generate Share Link
      </button>

      <div v-if="generatedToken" class="bg-gray-800 rounded-lg p-4 animate-fade-in">
        <p class="text-sm text-gray-400 mb-2">Share this link with the worker:</p>
        <div class="flex gap-2">
          <input
            type="text"
            readonly
            :value="shareLink"
            class="flex-1 bg-gray-700 text-white px-3 py-2 rounded text-sm font-mono"
          />
          <button
            @click="copyLink"
            :class="[
              'px-4 py-2 rounded text-sm transition min-w-[70px]',
              copied
                ? 'bg-green-600 text-white'
                : 'bg-gray-600 hover:bg-gray-500 text-white'
            ]"
          >
            {{ copied ? 'Copied!' : 'Copy' }}
          </button>
        </div>
      </div>

      <hr class="border-gray-700" />

      <button
        @click="goToDashboard"
        class="w-full bg-gray-700 hover:bg-gray-600 text-white font-semibold py-3 px-6 rounded-lg transition"
      >
        Open Dashboard
      </button>
    </div>
  </div>
</template>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.2s ease-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
