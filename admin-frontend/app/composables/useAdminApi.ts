export type UserRole = 'user' | 'admin'

export interface AdminUser {
  id: number
  email: string
  display_name: string
  role: UserRole
  is_active: boolean
  created_at: string
  updated_at: string
}

interface ApiEnvelope<T> {
  code: number
  data: T
  message: string
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response.json() as ApiEnvelope<T>
  if (!response.ok || result.code >= 400) throw new Error(result.message || '请求失败')
  return result.data
}

export const adminApi = {
  login: (email: string, password: string) => request<{ user: AdminUser }>('POST', '/auth/admin/login', { email, password }),
  me: () => request<{ user: AdminUser }>('GET', '/auth/me'),
  logout: () => request('POST', '/auth/logout'),
  users: (params: URLSearchParams) => request<{ items: AdminUser[]; total: number; page: number; page_size: number; stats: { total: number; active: number; admins: number; disabled: number } }>('GET', `/admin/users?${params}`),
  createUser: (body: Record<string, unknown>) => request<{ user: AdminUser }>('POST', '/admin/users', body),
  updateUser: (id: number, body: Record<string, unknown>) => request<{ user: AdminUser }>('PUT', `/admin/users/${id}`, body),
  deleteUser: (id: number) => request('DELETE', `/admin/users/${id}`),
}
