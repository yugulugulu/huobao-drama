import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, notFound, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { currentUser } from '../middleware/auth.js'

const app = new Hono()

// 风格 key 仅作为用户内的稳定标识，兼容常见的 kebab-case 和 snake_case 写法。
const VALUE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

// GET /style-presets — 默认只返回启用项，?all=1 返回全部
app.get('/', async (c) => {
  const all = c.req.query('all') === '1'
  const userId = currentUser(c).id
  const rows = await db.select().from(schema.stylePresets).where(eq(schema.stylePresets.userId, userId))
  const filtered = all ? rows : rows.filter(r => r.isActive)
  filtered.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.id - b.id)
  return success(c, filtered.map(r => toSnakeCase(r)))
})

// POST /style-presets — 新增风格预设
app.post('/', async (c) => {
  const body = await c.req.json()
  const userId = currentUser(c).id
  if (!body.name?.trim()) return badRequest(c, '风格名称必填')
  if (!body.value?.trim()) return badRequest(c, '风格 key 必填')
  if (!VALUE_PATTERN.test(body.value.trim())) return badRequest(c, '风格 key 仅支持小写字母、数字、中划线或下划线')
  if (!body.prompt?.trim()) return badRequest(c, '提示词片段必填')

  const value = body.value.trim()
  const [dup] = await db.select().from(schema.stylePresets)
    .where(and(eq(schema.stylePresets.userId, userId), eq(schema.stylePresets.value, value)))
  if (dup) return badRequest(c, '风格 key 已存在')

  const ts = now()
  const res = await db.insert(schema.stylePresets).values({
    userId,
    name: body.name.trim(),
    value,
    prompt: body.prompt.trim(),
    description: body.description || null,
    sortOrder: Number(body.sort_order ?? body.sortOrder ?? 0),
    isActive: body.is_active === false || body.is_active === 0 ? false : true,
    createdAt: ts,
    updatedAt: ts,
  })
  const [row] = await db.select().from(schema.stylePresets)
    .where(and(eq(schema.stylePresets.id, getInsertId(res)), eq(schema.stylePresets.userId, userId)))
  return created(c, toSnakeCase(row))
})

// PUT /style-presets/:id — 更新（value 创建后不可修改）
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const body = await c.req.json()
  const [row] = await db.select().from(schema.stylePresets)
    .where(and(eq(schema.stylePresets.id, id), eq(schema.stylePresets.userId, userId)))
  if (!row) return notFound(c, '风格预设不存在')

  const updates: Record<string, any> = { updatedAt: now() }
  if (body.name !== undefined) updates.name = String(body.name).trim()
  if (body.prompt !== undefined) updates.prompt = String(body.prompt).trim()
  if (body.description !== undefined) updates.description = body.description || null
  if (body.sort_order !== undefined || body.sortOrder !== undefined) {
    updates.sortOrder = Number(body.sort_order ?? body.sortOrder)
  }
  if (body.is_active !== undefined || body.isActive !== undefined) {
    const v = body.is_active ?? body.isActive
    updates.isActive = !(v === false || v === 0)
  }
  await db.update(schema.stylePresets).set(updates)
    .where(and(eq(schema.stylePresets.id, id), eq(schema.stylePresets.userId, userId)))
  return success(c)
})

// DELETE /style-presets/:id — 硬删除（已使用此风格的项目保留 key，无害）
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  await db.delete(schema.stylePresets).where(and(eq(schema.stylePresets.id, id), eq(schema.stylePresets.userId, userId)))
  return success(c)
})

export default app
