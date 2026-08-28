import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, notFound, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { generateImage } from '../services/generation.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { ensurePropFinalPrompt } from '../services/final-prompt.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { currentUser } from '../middleware/auth.js'
import { findOwnedDrama, findOwnedEpisode, findOwnedProp } from '../services/ownership.js'

const app = new Hono()
// 道具图：白底单品静物，方形画布
const PROP_IMAGE_SIZE = '1024x1024'

// POST /props — 手动新增道具（传入 episode_id 时关联到该集）
app.post('/', async (c) => {
  const body = await c.req.json()
  const userId = currentUser(c).id
  if (!body.drama_id) return badRequest(c, 'drama_id required')
  if (!await findOwnedDrama(Number(body.drama_id), userId)) return notFound(c, '项目不存在')
  if (body.episode_id) {
    const episode = await findOwnedEpisode(Number(body.episode_id), userId)
    if (!episode || episode.dramaId !== Number(body.drama_id)) return notFound(c, '剧集不存在')
  }
  if (!body.name?.trim()) return badRequest(c, 'name required')
  const ts = now()
  const res = await db.insert(schema.props).values({
    userId,
    name: body.name.trim(),
    type: body.type || '',
    description: body.description || '',
    dramaId: body.drama_id,
    createdAt: ts,
    updatedAt: ts,
  })
  const propId = getInsertId(res)
  if (body.episode_id) {
    const existing = await db.select().from(schema.episodeProps)
      .where(and(eq(schema.episodeProps.episodeId, Number(body.episode_id)), eq(schema.episodeProps.propId, propId)))
    if (!existing.length) {
      await db.insert(schema.episodeProps).values({ episodeId: Number(body.episode_id), propId, createdAt: ts })
    }
  }
  const [row] = await db.select().from(schema.props)
    .where(and(eq(schema.props.id, propId), eq(schema.props.userId, userId)))
  return created(c, toSnakeCase(row))
})

// DELETE /props/:id — 软删除
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  if (!await findOwnedProp(id, userId)) return notFound(c, '道具不存在')
  await db.update(schema.props).set({ deletedAt: now(), updatedAt: now() }).where(and(eq(schema.props.id, id), eq(schema.props.userId, userId)))
  return success(c)
})

// PUT /props/:id — 更新道具（物品外貌/类型/最终提示词）
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  if (!await findOwnedProp(id, userId)) return notFound(c, '道具不存在')
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.name !== undefined) updates.name = body.name
  if (body.type !== undefined) updates.type = body.type
  if (body.description !== undefined) updates.description = body.description
  // 用户上传道具图：直接写入图片地址与本地路径
  if (body.image_url !== undefined) updates.imageUrl = body.image_url
  else if (body.imageUrl !== undefined) updates.imageUrl = body.imageUrl
  if (body.local_path !== undefined) updates.localPath = body.local_path
  else if (body.localPath !== undefined) updates.localPath = body.localPath
  // 手动编辑最终提示词时以传入值为准；未传入则保留原值（修改信息时不再自动置空）
  if (body.final_prompt !== undefined) updates.finalPrompt = body.final_prompt || null
  else if (body.finalPrompt !== undefined) updates.finalPrompt = body.finalPrompt || null
  await db.update(schema.props).set(updates).where(and(eq(schema.props.id, id), eq(schema.props.userId, userId)))
  return success(c)
})

/** 本地兜底提示词：白底单品，不掺杂其他元素 */
function propImagePrompt(prop: typeof schema.props.$inferSelect, stylePrompt = '') {
  return [
    stylePrompt || '',
    `single product photo of ${prop.name}`,
    prop.description || '',
    'isolated on a pure white background',
    'no other objects, no people, no scenery',
    'soft even studio lighting',
    'high detail',
    'no text, no watermark',
  ].filter(Boolean).join(', ')
}

// POST /props/:id/generate-prompt — 独立生成/重新生成白底单品最终提示词（不生图）
app.post('/:id/generate-prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const body = await c.req.json()
  const prop = await findOwnedProp(id, userId)
  if (!prop) return notFound(c, 'Prop not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const ep = await findOwnedEpisode(Number(body.episode_id), userId)
  if (!ep || ep.dramaId !== prop.dramaId) return notFound(c, 'Episode not found')

  logTaskStart('FinalPrompt', 'prop-generate', { propId: id, episodeId: ep.id, force: !!body.force })
  const finalPrompt = await ensurePropFinalPrompt(prop, ep.id, !!body.force, { userId, model: body.text_model, configId: body.text_config_id ?? undefined })
  if (!finalPrompt) {
    logTaskError('FinalPrompt', 'prop-generate', { propId: id, error: 'agent returned empty prompt' })
    return badRequest(c, '最终提示词生成失败，请重试')
  }
  logTaskSuccess('FinalPrompt', 'prop-generate', { propId: id })
  return success(c, { final_prompt: finalPrompt })
})

// POST /props/:id/generate-image — 生成道具白底单品图
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const body = await c.req.json()
  const prop = await findOwnedProp(id, userId)
  if (!prop) return notFound(c, 'Prop not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const ep = await findOwnedEpisode(Number(body.episode_id), userId)
  if (!ep || ep.dramaId !== prop.dramaId) return notFound(c, 'Episode not found')

  const stylePrompt = await getDramaStylePrompt(prop.dramaId, userId)
  const finalPrompt = await ensurePropFinalPrompt(prop, ep.id, false, { userId, model: body.text_model, configId: body.text_config_id ?? undefined })
  const prompt = finalPrompt || propImagePrompt(prop, stylePrompt)
  try {
    logTaskStart('PropImage', 'generate', { propId: id, episodeId: ep.id, dramaId: prop.dramaId })
    const genId = await generateImage({ userId, propId: id, dramaId: prop.dramaId, prompt, model: body.model, size: PROP_IMAGE_SIZE, configId: body.config_id ?? ep.imageConfigId ?? undefined })
    logTaskSuccess('PropImage', 'generate', { propId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('PropImage', 'generate', { propId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

export default app
