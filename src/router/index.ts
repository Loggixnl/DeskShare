import { createRouter, createWebHistory } from 'vue-router'
import { isAuthenticated, verifyAuth } from '@/lib/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/HomePage.vue'),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginPage.vue'),
      meta: { guest: true },
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('@/views/RegisterPage.vue'),
      meta: { guest: true },
    },
    {
      path: '/share/:token',
      name: 'share',
      component: () => import('@/views/SharePage.vue'),
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardPage.vue'),
      meta: { requiresAuth: true },
    },
  ],
})

// Auth guard
router.beforeEach(async (to, _from, next) => {
  // Check if route requires auth
  if (to.meta.requiresAuth) {
    // Verify token is still valid
    const valid = await verifyAuth()
    if (!valid) {
      return next({ name: 'login', query: { redirect: to.fullPath } })
    }
  }

  // Redirect authenticated users away from guest pages (login/register)
  if (to.meta.guest && isAuthenticated.value) {
    return next({ name: 'dashboard' })
  }

  next()
})

export default router
