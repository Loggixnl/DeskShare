<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { isAuthenticated, currentAdmin, getShareUrl } from '@/lib/auth'

const router = useRouter()

const shareLink = computed(() => {
  if (!currentAdmin.value) return ''
  return getShareUrl(currentAdmin.value.shareToken)
})

function goToLogin() {
  router.push('/login')
}

function goToRegister() {
  router.push('/register')
}

function goToDashboard() {
  router.push('/dashboard')
}
</script>

<template>
  <div class="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-8">
    <h1 class="text-4xl font-bold mb-2">DeskShare</h1>
    <p class="text-gray-400 mb-8">Simple one-way screen sharing for teams</p>

    <div class="space-y-4 w-full max-w-md">
      <!-- Authenticated user -->
      <template v-if="isAuthenticated">
        <div class="bg-gray-800 rounded-lg p-4 text-center">
          <p class="text-gray-400 text-sm mb-2">Welcome back!</p>
          <p class="text-white font-medium">{{ currentAdmin?.email }}</p>
        </div>

        <button
          @click="goToDashboard"
          class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition"
        >
          Go to Dashboard
        </button>
      </template>

      <!-- Not authenticated -->
      <template v-else>
        <div class="bg-gray-800 rounded-lg p-6">
          <h2 class="text-lg font-semibold mb-4 text-center">Get Started</h2>
          <p class="text-gray-400 text-sm mb-4 text-center">
            Create an account to get your permanent share link, or sign in to access your dashboard.
          </p>

          <div class="space-y-3">
            <button
              @click="goToRegister"
              class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition"
            >
              Create Account
            </button>

            <button
              @click="goToLogin"
              class="w-full bg-gray-700 hover:bg-gray-600 text-white font-semibold py-3 px-6 rounded-lg transition"
            >
              Sign In
            </button>
          </div>
        </div>
      </template>

      <!-- Features -->
      <div class="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
        <div class="bg-gray-800/50 rounded-lg p-4">
          <div class="text-2xl mb-2">🔗</div>
          <h3 class="font-medium mb-1">Permanent Link</h3>
          <p class="text-gray-400 text-sm">One link that never changes</p>
        </div>
        <div class="bg-gray-800/50 rounded-lg p-4">
          <div class="text-2xl mb-2">👥</div>
          <h3 class="font-medium mb-1">Multiple Workers</h3>
          <p class="text-gray-400 text-sm">Many screens, one dashboard</p>
        </div>
        <div class="bg-gray-800/50 rounded-lg p-4">
          <div class="text-2xl mb-2">🎙️</div>
          <h3 class="font-medium mb-1">Voice Calls</h3>
          <p class="text-gray-400 text-sm">Two-way communication</p>
        </div>
      </div>
    </div>
  </div>
</template>
