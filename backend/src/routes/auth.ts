/** 注册、登录、退出和当前会话接口。 */
import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { badRequest, conflict, created, notFound, success, unauthorized, now } from '../utils/response.js'
import { authRequired, clearAuthCookie, createAccessToken, currentUser, setAuthCookie } from '../middleware/auth.js'
import { ensureUserStylePresets } from '../services/user-defaults.js'
import { generateConsumerId } from '../utils/consumer-id.js'

const app = new Hono()

function publicUser(user: typeof schema.users.$inferSelect) {
  return { id: user.id, email: user.email, display_name: user.displayName, role: user.role, is_active: user.isActive, created_at: user.createdAt }
}

async function authenticate(email: string, password: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email))
  if (!user || !user.isActive || !await bcrypt.compare(password, user.passwordHash)) return null
  return user
}

// POST /auth/register - 开放注册；密码仅以 bcrypt 哈希形式存储。
app.post('/register', async (c) => {
  const body = await c.req.json()
  const email = String(body.email || '').trim().toLowerCase()
  const displayName = String(body.display_name || body.displayName || '').trim()
  const password = String(body.password || '')
  if (!/^\S+@\S+\.\S+$/.test(email)) return badRequest(c, '请输入有效邮箱地址')
  if (!displayName || displayName.length > 64) return badRequest(c, '显示名不能为空且不能超过 64 个字符')
  if (password.length < 8) return badRequest(c, '密码至少需要 8 个字符')

  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email))
  if (existing) return conflict(c, '该邮箱已注册')

  const ts = now()
  const result = await db.insert(schema.users).values({
    email,
    displayName,
    passwordHash: await bcrypt.hash(password, 12),
    consumerId: generateConsumerId(),
    role: 'user',
    createdAt: ts,
    updatedAt: ts,
  })
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, getInsertId(result)))
  await ensureUserStylePresets(user.id)
  const token = await createAccessToken({ id: user.id, email: user.email, displayName: user.displayName, role: 'user' })
  setAuthCookie(c, token)
  return created(c, { user: publicUser(user), expires_in: 86400 })
})

// POST /auth/login - 始终使用统一失败信息，避免泄露邮箱是否已注册。
app.post('/login', async (c) => {
  const body = await c.req.json()
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const user = await authenticate(email, password)
  if (!user) return unauthorized(c, '邮箱或密码错误')
  const role = user.role === 'admin' ? 'admin' : 'user'
  const token = await createAccessToken({ id: user.id, email: user.email, displayName: user.displayName, role })
  setAuthCookie(c, token)
  return success(c, { user: publicUser(user), expires_in: 86400 })
})

// POST /auth/admin/login - 沿用账号密码校验，但只允许管理员进入管理端。
app.post('/admin/login', async (c) => {
  const body = await c.req.json()
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const user = await authenticate(email, password)
  if (!user || user.role !== 'admin') return unauthorized(c, '邮箱或密码错误，或账号无管理员权限')
  const token = await createAccessToken({ id: user.id, email: user.email, displayName: user.displayName, role: 'admin' })
  setAuthCookie(c, token)
  return success(c, { user: publicUser(user), expires_in: 86400 })
})

// 当前会话与退出接口也位于 /auth 下，因此在路由内部单独启用鉴权。
app.post('/logout', authRequired, (c) => {
  clearAuthCookie(c)
  return success(c)
})

app.get('/me', authRequired, async (c) => {
  const auth = currentUser(c)
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, auth.id))
  if (!user || !user.isActive) return notFound(c, '用户不存在')
  return success(c, { user: publicUser(user) })
})

export default app
