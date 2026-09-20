import type { AdminUser } from './useAdminApi'

export function useAdminAuth() {
  const user = useState<AdminUser | null>('admin-user', () => null)
  const checked = useState('admin-auth-checked', () => false)

  async function restore() {
    if (checked.value) return user.value
    try {
      const result = await adminApi.me()
      user.value = result.user.role === 'admin' ? result.user : null
    } catch {
      user.value = null
    } finally {
      checked.value = true
    }
    return user.value
  }

  async function login(email: string, password: string) {
    const result = await adminApi.login(email, password)
    user.value = result.user
    checked.value = true
  }

  async function logout() {
    try { await adminApi.logout() } finally {
      user.value = null
      checked.value = true
      await navigateTo('/login')
    }
  }

  return { user, checked, restore, login, logout }
}
