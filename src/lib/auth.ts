import { ref, computed } from 'vue'

const API_BASE = import.meta.env.VITE_API_URL || ''

export interface Admin {
  id: number
  email: string
  shareToken: string
}

export interface AuthResponse {
  token: string
  admin: Admin
}

// Reactive auth state
const token = ref<string | null>(localStorage.getItem('auth_token'))
const admin = ref<Admin | null>(null)

// Try to load admin from localStorage on init
const storedAdmin = localStorage.getItem('auth_admin')
if (storedAdmin) {
  try {
    admin.value = JSON.parse(storedAdmin)
  } catch {
    localStorage.removeItem('auth_admin')
  }
}

export const isAuthenticated = computed(() => !!token.value && !!admin.value)
export const currentAdmin = computed(() => admin.value)
export const authToken = computed(() => token.value)

// Store auth data
function setAuth(authResponse: AuthResponse) {
  token.value = authResponse.token
  admin.value = authResponse.admin
  localStorage.setItem('auth_token', authResponse.token)
  localStorage.setItem('auth_admin', JSON.stringify(authResponse.admin))
}

// Clear auth data
export function logout() {
  token.value = null
  admin.value = null
  localStorage.removeItem('auth_token')
  localStorage.removeItem('auth_admin')
}

// Register a new admin
export async function register(email: string, password: string): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error || 'Registration failed')
  }

  setAuth(data)
  return data
}

// Login existing admin
export async function login(email: string, password: string): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error || 'Login failed')
  }

  setAuth(data)
  return data
}

// Verify current token and refresh admin data
export async function verifyAuth(): Promise<boolean> {
  if (!token.value) {
    return false
  }

  try {
    const response = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token.value}` },
    })

    if (!response.ok) {
      logout()
      return false
    }

    const data = await response.json()
    admin.value = data.admin
    localStorage.setItem('auth_admin', JSON.stringify(data.admin))
    return true
  } catch {
    logout()
    return false
  }
}

// Validate a share token (for workers)
export async function validateShareToken(shareToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/share/${shareToken}/validate`)
    const data = await response.json()
    return data.valid === true
  } catch {
    return false
  }
}

// Get share URL for admin
export function getShareUrl(shareToken: string): string {
  return `${window.location.origin}/share/${shareToken}`
}
