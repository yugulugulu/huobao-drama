/** 管理员用户管理：查询、创建、编辑、禁用与安全删除。 */
import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { and, asc, count, desc, eq, like, or, sql } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { currentUser } from '../middleware/auth.js'
import { ensureUserStylePresets } from '../services/user-defaults.js'
import { badRequest, conflict, created, forbidden, notFound, now, success } from '../utils/response.js'
import { generateConsumerId } from '../utils/consumer-id.js'

const app = new Hono()
const roles = new Set(['user', 'admin'])
const ownedTables = [
  schema.dramas,
  schema.episodes,
  schema.characters,
  schema.scenes,
  schema.storyboards,
  schema.storyboardBreakdownTasks,
  schema.storyboardAudios,
  schema.props,
  schema.audios,
  schema.episodeAudios,
  schema.sysTask,
  schema.videoMerges,
  schema.assets,
]

function publicUser(user: typeof schema.users.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    role: user.role,
    is_active: user.isActive,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
  }
}

function activeValue(value: unknown) {
  return !(value === false || value === 0 || value === '0')
}

function userId(value: string) {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

async function isLastActiveAdmin(user: typeof schema.users.$inferSelect) {
  if (user.role !== 'admin' || !user.isActive) return false
  const rows = await db.select({ value: count() }).from(schema.users).where(and(
    eq(schema.users.role, 'admin'),
    eq(schema.users.isActive, true),
  ))
  return (rows[0]?.value || 0) <= 1
}

app.get('/', async (c) => {
  const query = String(c.req.query('query') || '').trim()
  const role = String(c.req.query('role') || '')
  const status = String(c.req.query('status') || '')
  const page = Math.max(1, Number.parseInt(c.req.query('page') || '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(c.req.query('page_size') || '20', 10) || 20))
  const conditions = []
  if (query) conditions.push(or(like(schema.users.email, `%${query}%`), like(schema.users.displayName, `%${query}%`)))
  if (roles.has(role)) conditions.push(eq(schema.users.role, role))
  if (status === 'active') conditions.push(eq(schema.users.isActive, true))
  if (status === 'disabled') conditions.push(eq(schema.users.isActive, false))
  const where = conditions.length ? and(...conditions) : undefined

  const [items, totalRows] = await Promise.all([
    db.select().from(schema.users).where(where).orderBy(desc(schema.users.createdAt), asc(schema.users.id)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ value: count() }).from(schema.users).where(where),
  ])
  const [allRows, activeRows, adminRows, disabledRows] = await Promise.all([
    db.select({ value: count() }).from(schema.users),
    db.select({ value: count() }).from(schema.users).where(eq(schema.users.isActive, true)),
    db.select({ value: count() }).from(schema.users).where(eq(schema.users.role, 'admin')),
    db.select({ value: count() }).from(schema.users).where(eq(schema.users.isActive, false)),
  ])
  return success(c, {
    items: items.map(publicUser),
    total: totalRows[0]?.value || 0,
    page,
    page_size: pageSize,
    stats: {
      total: allRows[0]?.value || 0,
      active: activeRows[0]?.value || 0,
      admins: adminRows[0]?.value || 0,
      disabled: disabledRows[0]?.value || 0,
    },
  })
})

app.get('/:id', async (c) => {
  const id = userId(c.req.param('id'))
  if (!id) return badRequest(c, '用户 ID 无效')
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id))
  if (!user) return notFound(c, '用户不存在')
  return success(c, { user: publicUser(user) })
})

app.post('/', async (c) => {
  const body = await c.req.json()
  const email = String(body.email || '').trim().toLowerCase()
  const displayName = String(body.display_name || body.displayName || '').trim()
  const password = String(body.password || '')
  const role = String(body.role || 'user')
  if (!/^\S+@\S+\.\S+$/.test(email)) return badRequest(c, '请输入有效邮箱地址')
  if (!displayName || displayName.length > 64) return badRequest(c, '显示名不能为空且不能超过 64 个字符')
  if (password.length < 8) return badRequest(c, '密码至少需要 8 个字符')
  if (!roles.has(role)) return badRequest(c, '用户角色无效')
  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email))
  if (existing) return conflict(c, '该邮箱已存在')

  const ts = now()
  const result = await db.insert(schema.users).values({
    consumerId: generateConsumerId(),
    email,
    displayName,
    passwordHash: await bcrypt.hash(password, 12),
    role,
    isActive: activeValue(body.is_active ?? true),
    createdAt: ts,
    updatedAt: ts,
  })
  const id = getInsertId(result)
  await ensureUserStylePresets(id)
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id))
  return created(c, { user: publicUser(user) })
})

app.put('/:id', async (c) => {
  const id = userId(c.req.param('id'))
  if (!id) return badRequest(c, '用户 ID 无效')
  const actor = currentUser(c)
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id))
  if (!user) return notFound(c, '用户不存在')
  const body = await c.req.json()
  const updates: Partial<typeof schema.users.$inferInsert> = { updatedAt: now() }

  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(email)) return badRequest(c, '请输入有效邮箱地址')
    const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.email, email), sql`${schema.users.id} <> ${id}`))
    if (existing) return conflict(c, '该邮箱已存在')
    updates.email = email
  }
  if (body.display_name !== undefined || body.displayName !== undefined) {
    const displayName = String(body.display_name ?? body.displayName).trim()
    if (!displayName || displayName.length > 64) return badRequest(c, '显示名不能为空且不能超过 64 个字符')
    updates.displayName = displayName
  }
  if (body.role !== undefined) {
    const role = String(body.role)
    if (!roles.has(role)) return badRequest(c, '用户角色无效')
    if (actor.id === id && role !== 'admin') return forbidden(c, '不能取消自己的管理员角色')
    updates.role = role
  }
  if (body.is_active !== undefined || body.isActive !== undefined) {
    const isActive = activeValue(body.is_active ?? body.isActive)
    if (actor.id === id && !isActive) return forbidden(c, '不能禁用自己的账号')
    updates.isActive = isActive
  }
  if (body.password !== undefined && String(body.password)) {
    const password = String(body.password)
    if (password.length < 8) return badRequest(c, '密码至少需要 8 个字符')
    updates.passwordHash = await bcrypt.hash(password, 12)
  }
  const removesActiveAdmin = user.role === 'admin' && user.isActive && (
    updates.role === 'user' || updates.isActive === false
  )
  if (removesActiveAdmin && await isLastActiveAdmin(user)) {
    return forbidden(c, '系统必须至少保留一个启用的管理员')
  }
  await db.update(schema.users).set(updates).where(eq(schema.users.id, id))
  const [updated] = await db.select().from(schema.users).where(eq(schema.users.id, id))
  return success(c, { user: publicUser(updated) })
})

app.delete('/:id', async (c) => {
  const id = userId(c.req.param('id'))
  if (!id) return badRequest(c, '用户 ID 无效')
  if (currentUser(c).id === id) return forbidden(c, '不能删除自己的账号')
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id))
  if (!user) return notFound(c, '用户不存在')
  if (await isLastActiveAdmin(user)) return forbidden(c, '系统必须至少保留一个启用的管理员')

  for (const table of ownedTables) {
    const rows = await db.select({ value: count() }).from(table).where(eq(table.userId, id))
    if ((rows[0]?.value || 0) > 0) return conflict(c, '该用户已有业务数据，请改为禁用账号')
  }
  await db.transaction(async (tx) => {
    await tx.delete(schema.userAgentSkills).where(eq(schema.userAgentSkills.userId, id))
    await tx.delete(schema.userAgentConfigs).where(eq(schema.userAgentConfigs.userId, id))
    await tx.delete(schema.stylePresets).where(eq(schema.stylePresets.userId, id))
    await tx.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.userId, id))
    await tx.delete(schema.users).where(eq(schema.users.id, id))
  })
  return success(c)
})

export default app
