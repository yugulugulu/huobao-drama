import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, notFound, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { generateImage } from '../services/generation.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { ensureCharacterFinalPrompt } from '../services/final-prompt.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { currentUser } from '../middleware/auth.js'
import { findOwnedCharacter, findOwnedDrama, findOwnedEpisode } from '../services/ownership.js'

const app = new Hono()
const CHARACTER_IMAGE_SIZE = '1920x1080'

// POST /characters — 手动新增角色（传入 episode_id 时关联到该集）
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
  const res = await db.insert(schema.characters).values({
    userId,
    name: body.name.trim(),
    role: body.role || '',
    description: body.description || '',
    appearance: body.appearance || '',
    styling: body.styling || '',
    dramaId: body.drama_id,
    createdAt: ts,
    updatedAt: ts,
  })
  const charId = getInsertId(res)
  if (body.episode_id) {
    const existing = await db.select().from(schema.episodeCharacters)
      .where(and(eq(schema.episodeCharacters.episodeId, Number(body.episode_id)), eq(schema.episodeCharacters.characterId, charId)))
    if (!existing.length) {
      await db.insert(schema.episodeCharacters).values({ episodeId: Number(body.episode_id), characterId: charId, createdAt: ts })
    }
  }
  const [row] = await db.select().from(schema.characters)
    .where(and(eq(schema.characters.id, charId), eq(schema.characters.userId, userId)))
  return created(c, toSnakeCase(row))
})

function characterImagePrompt(char: typeof schema.characters.$inferSelect, stylePrompt = '') {
  return [
    stylePrompt || '',
    char.name,
    char.appearance || char.description || '人物立绘',
    char.styling || '',
    '16:9 横版角色定妆照',
    '半身角色海报构图',
    '正面',
    '高质量',
    '白色背景',
  ].filter(Boolean).join(', ')
}

// PUT /characters/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  if (!await findOwnedCharacter(id, userId)) return notFound(c, '角色不存在')
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'role', 'description', 'appearance', 'styling', 'imageUrl', 'localPath']) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (snakeKey in body) updates[key] = body[snakeKey]
    else if (key in body) updates[key] = body[key]
  }
  // 手动编辑最终提示词时以传入值为准；未传入则保留原值（修改信息时不再自动置空）
  if (body.final_prompt !== undefined) updates.finalPrompt = body.final_prompt || null
  else if (body.finalPrompt !== undefined) updates.finalPrompt = body.finalPrompt || null
  await db.update(schema.characters).set(updates).where(and(eq(schema.characters.id, id), eq(schema.characters.userId, userId)))
  return success(c)
})

// DELETE /characters/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  if (!await findOwnedCharacter(id, userId)) return notFound(c, '角色不存在')
  await db.update(schema.characters).set({ deletedAt: now() }).where(and(eq(schema.characters.id, id), eq(schema.characters.userId, userId)))
  return success(c)
})

// POST /characters/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const body = await c.req.json()
  const char = await findOwnedCharacter(id, userId)
  if (!char) return notFound(c, 'Character not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const ep = await findOwnedEpisode(Number(body.episode_id), userId)
  if (!ep || ep.dramaId !== char.dramaId) return notFound(c, 'Episode not found')

  const stylePrompt = await getDramaStylePrompt(char.dramaId, userId)
  const finalPrompt = await ensureCharacterFinalPrompt(char, ep.id, false, { userId, model: body.text_model, configId: body.text_config_id ?? undefined })
  const prompt = finalPrompt || characterImagePrompt(char, stylePrompt)
  try {
    logTaskStart('CharacterImage', 'generate', { characterId: id, episodeId: ep.id, dramaId: char.dramaId })
    const genId = await generateImage({ userId, characterId: id, dramaId: char.dramaId, prompt, model: body.model, size: CHARACTER_IMAGE_SIZE, configId: body.config_id ?? ep.imageConfigId ?? undefined })
    logTaskSuccess('CharacterImage', 'generate', { characterId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('CharacterImage', 'generate', { characterId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /characters/:id/generate-prompt — 独立生成/重新生成三视图最终提示词（不生图）
app.post('/:id/generate-prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const body = await c.req.json()
  const char = await findOwnedCharacter(id, userId)
  if (!char) return notFound(c, 'Character not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const ep = await findOwnedEpisode(Number(body.episode_id), userId)
  if (!ep || ep.dramaId !== char.dramaId) return notFound(c, 'Episode not found')

  logTaskStart('FinalPrompt', 'character-generate', { characterId: id, episodeId: ep.id, force: !!body.force })
  const finalPrompt = await ensureCharacterFinalPrompt(char, ep.id, !!body.force, { userId, model: body.text_model, configId: body.text_config_id ?? undefined })
  if (!finalPrompt) {
    logTaskError('FinalPrompt', 'character-generate', { characterId: id, error: 'agent returned empty prompt' })
    return badRequest(c, '最终提示词生成失败，请重试')
  }
  logTaskSuccess('FinalPrompt', 'character-generate', { characterId: id })
  return success(c, { final_prompt: finalPrompt })
})

// POST /characters/batch-generate-images
app.post('/batch-generate-images', async (c) => {
  const body = await c.req.json()
  const userId = currentUser(c).id
  const ids: number[] = body.character_ids || []
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  const ep = await findOwnedEpisode(Number(body.episode_id), userId)
  if (!ep) return notFound(c, 'Episode not found')
  const results: number[] = []
  const stylePrompt = await getDramaStylePrompt(ep.dramaId, userId)
  for (const cid of ids) {
    const char = await findOwnedCharacter(cid, userId)
    if (!char) continue
    if (char.dramaId !== ep.dramaId) continue
    const finalPrompt = await ensureCharacterFinalPrompt(char, ep.id, false, { userId, model: body.text_model, configId: body.text_config_id ?? undefined })
    const prompt = finalPrompt || characterImagePrompt(char, stylePrompt)
    try {
      const genId = await generateImage({ userId, characterId: cid, dramaId: char.dramaId, prompt, model: body.model, size: CHARACTER_IMAGE_SIZE, configId: body.config_id ?? ep.imageConfigId ?? undefined })
      results.push(genId)
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, ids: results })
})

export default app
