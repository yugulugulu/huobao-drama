import { authAPI } from './useApi'

export interface SessionUser {
  id: number
  email: string
  display_name: string
  role: 'user' | 'admin'
  is_active: boolean
  created_at: string
}

/** 全局会话状态；JWT 保存在 HttpOnly Cookie，前端只持有公开用户信息。 */
export function useAuth() {
  const user = useState<SessionUser | null>('auth-user', () => null)
  const checked = useState<boolean>('auth-checked', () => false)

  async function fetchUser(force = false) {
    if (checked.value && !force) return user.value
    try {
      const result = await authAPI.me()
      user.value = result.user
    } catch {
      user.value = null
    } finally {
      checked.value = true
    }
    return user.value
  }

  async function login(email: string, password: string) {
    const result = await authAPI.login({ email, password })
    user.value = result.user
    checked.value = true
    return result.user
  }

  async function register(email: string, displayName: string, password: string) {
    const result = await authAPI.register({ email, display_name: displayName, password })
    user.value = result.user
    checked.value = true
    return result.user
  }

  async function logout() {
    try { await authAPI.logout() } finally {
      user.value = null
      checked.value = true
      await navigateTo('/login')
    }
  }

  return { user, checked, fetchUser, login, register, logout }
}
