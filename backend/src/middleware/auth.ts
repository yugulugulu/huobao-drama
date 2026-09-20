/**
 * JWT 鉴权与当前用户上下文。
 * 所有受保护路由仅通过此处写入的 userId 识别调用方，禁止信任请求体中的用户标识。
 */
import type { Context, MiddlewareHandler } from 'hono'
import { sign, verify } from 'hono/jwt'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { forbidden, unauthorized } from '../utils/response.js'

export type UserRole = 'user' | 'admin'

export interface AuthUser {
  id: number
  email: string
  displayName: string
  role: UserRole
}

const JWT_ALGORITHM = 'HS256'
const JWT_TTL_SECONDS = 24 * 60 * 60

function jwtSecret() {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET 未配置')
  return secret
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null
  const prefix = `${name}=`
  return header.split(';').map(item => item.trim()).find(item => item.startsWith(prefix))?.slice(prefix.length) || null
}

function tokenFromRequest(c: Context): string | null {
  const authorization = c.req.header('Authorization')
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7).trim()
  return cookieValue(c.req.header('Cookie'), 'studio_token')
}

export async function createAccessToken(user: AuthUser): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub: String(user.id), email: user.email, name: user.displayName, role: user.role, iat: now, exp: now + JWT_TTL_SECONDS }, jwtSecret(), JWT_ALGORITHM)
}

/** 为浏览器写入不可被 JavaScript 读取的会话 Cookie。 */
export function setAuthCookie(c: Context, token: string) {
  const secure = process.env.COOKIE_SECURE === 'true'
  c.header('Set-Cookie', `studio_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${JWT_TTL_SECONDS}${secure ? '; Secure' : ''}`)
}

export function clearAuthCookie(c: Context) {
  const secure = process.env.COOKIE_SECURE === 'true'
  c.header('Set-Cookie', `studio_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`)
}

/** 全局中间件：验证 Token 后将认证用户放入 Hono Context。 */
export const authRequired: MiddlewareHandler = async (c, next) => {
  const token = tokenFromRequest(c)
  if (!token) return unauthorized(c, '请先登录')

  let payload
  try {
    payload = await verify(token, jwtSecret(), JWT_ALGORITHM)
  } catch {
    return unauthorized(c, '登录已过期，请重新登录')
  }
  const id = Number(payload.sub)
  if (!Number.isInteger(id) || id <= 0 || typeof payload.email !== 'string') {
    return unauthorized(c, '登录状态无效')
  }
  // 每次请求读取账号状态，使禁用、角色调整和删除立即生效。
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id))
  if (!user || !user.isActive) return unauthorized(c, '账号已被禁用或不存在')
  c.set('authUser', {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role === 'admin' ? 'admin' : 'user',
  } satisfies AuthUser)
  await next()
}

/** 管理接口在普通登录校验后追加角色检查。 */
export const adminRequired: MiddlewareHandler = async (c, next) => {
  if (currentUser(c).role !== 'admin') return forbidden(c, '需要管理员权限')
  await next()
}

/** 获取已由 authRequired 验证的当前用户，供业务路由统一使用。 */
export function currentUser(c: Context): AuthUser {
  const user = c.get('authUser') as AuthUser | undefined
  if (!user) throw new Error('当前路由缺少鉴权中间件')
  return user
}
