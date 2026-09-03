import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, notFound, now } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import { currentUser } from '../middleware/auth.js'
import { findOwnedAudio, findOwnedDrama, findOwnedEpisode } from '../services/ownership.js'
import { extOf, validateAudioFile } from './upload.js'
import { saveUploadedFile } from '../utils/storage.js'

const app = new Hono()

async function findAudioInDrama(id: number, dramaId: number, userId: number) {
  const audio = await findOwnedAudio(id, userId)
  return audio && audio.dramaId === dramaId && !audio.deletedAt ? audio : null
}

// POST /audios — 先创建元数据，文件需在创建成功后单独上传。
app.post('/', async (c) => {
  const body = await c.req.json()
  const userId = currentUser(c).id
  const dramaId = Number(body.drama_id)
  if (!dramaId) return badRequest(c, 'drama_id required')
  if (!String(body.name || '').trim()) return badRequest(c, 'name required')
  if (!await findOwnedDrama(dramaId, userId)) return notFound(c, '项目不存在')

  const episodeId = body.episode_id == null ? undefined : Number(body.episode_id)
  if (episodeId) {
    const episode = await findOwnedEpisode(episodeId, userId)
    if (!episode || episode.dramaId !== dramaId) return notFound(c, '剧集不存在')
  }

  const ts = now()
  const result = await db.insert(schema.audios).values({
    userId,
    dramaId,
    name: String(body.name).trim(),
    description: body.description ? String(body.description) : null,
    createdAt: ts,
    updatedAt: ts,
  })
  const audioId = getInsertId(result)
  const episodes = episodeId
    ? [{ id: episodeId }]
    : await db.select({ id: schema.episodes.id }).from(schema.episodes).where(and(
      eq(schema.episodes.userId, userId),
      eq(schema.episodes.dramaId, dramaId),
      isNull(schema.episodes.deletedAt),
    ))
  for (const episode of episodes) {
    await db.insert(schema.episodeAudios).values({
      userId,
      dramaId,
      episodeId: episode.id,
      audioId,
      createdAt: ts,
    }).catch((error: any) => {
      // 兼容重复请求或旧数据库没有唯一约束的情况。
      if (!String(error?.message || '').toLowerCase().includes('duplicate')) throw error
    })
  }
  const [audio] = await db.select().from(schema.audios)
    .where(and(eq(schema.audios.id, audioId), eq(schema.audios.userId, userId)))
  return created(c, toSnakeCase(audio))
})

// GET /audios?drama_id=... — 仅返回当前用户未删除的项目资产。
app.get('/', async (c) => {
  const dramaId = Number(c.req.query('drama_id'))
  const userId = currentUser(c).id
  if (!dramaId) return badRequest(c, 'drama_id required')
  if (!await findOwnedDrama(dramaId, userId)) return notFound(c, '项目不存在')
  const rows = await db.select().from(schema.audios)
    .where(and(eq(schema.audios.userId, userId), eq(schema.audios.dramaId, dramaId), isNull(schema.audios.deletedAt)))
  return success(c, toSnakeCaseArray(rows))
})

app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const audio = await findOwnedAudio(id, userId)
  if (!audio || audio.deletedAt) return notFound(c, '音频不存在')
  const body = await c.req.json()
  const updates: Record<string, unknown> = { updatedAt: now() }
  if (body.name !== undefined) {
    const name = String(body.name || '').trim()
    if (!name) return badRequest(c, 'name required')
    updates.name = name
  }
  if (body.description !== undefined) updates.description = body.description ? String(body.description) : null
  await db.update(schema.audios).set(updates).where(and(eq(schema.audios.id, id), eq(schema.audios.userId, userId)))
  return success(c)
})

// POST /audios/:id/upload — 重传覆盖同一资产记录，关联关系不变。
app.post('/:id/upload', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const audio = await findOwnedAudio(id, userId)
  if (!audio || audio.deletedAt) return notFound(c, '音频不存在')
  const body = await c.req.parseBody()
  const file = body.file
  if (!file || !(file instanceof File)) return badRequest(c, 'file is required')
  try {
    const buffer = await file.arrayBuffer()
    const format = validateAudioFile(file, buffer.byteLength)
    const reference = await saveUploadedFile(buffer, userId, 'uploads', file.name)
    await db.update(schema.audios).set({
      fileUrl: reference,
      localPath: reference,
      fileSize: buffer.byteLength,
      mimeType: file.type || null,
      format: format || extOf(file.name).replace(/^\./, ''),
      updatedAt: now(),
    }).where(and(eq(schema.audios.id, id), eq(schema.audios.userId, userId)))
    const [updated] = await db.select().from(schema.audios)
      .where(and(eq(schema.audios.id, id), eq(schema.audios.userId, userId)))
    return success(c, toSnakeCase(updated))
  } catch (err: any) {
    return badRequest(c, err.message || '音频上传失败')
  }
})

// DELETE /audios/:id — 软删除记录并移除集/分镜关联，保留历史物理文件。
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const audio = await findOwnedAudio(id, userId)
  if (!audio || audio.deletedAt) return notFound(c, '音频不存在')
  const ts = now()
  await db.transaction(async (tx) => {
    await tx.update(schema.audios).set({ deletedAt: ts, updatedAt: ts })
      .where(and(eq(schema.audios.id, id), eq(schema.audios.userId, userId)))
    await tx.delete(schema.episodeAudios).where(and(
      eq(schema.episodeAudios.audioId, id),
      eq(schema.episodeAudios.userId, userId),
      eq(schema.episodeAudios.dramaId, audio.dramaId),
    ))
    await tx.delete(schema.storyboardAudios).where(and(
      eq(schema.storyboardAudios.audioId, id),
      eq(schema.storyboardAudios.userId, userId),
      eq(schema.storyboardAudios.dramaId, audio.dramaId),
    ))
  })
  return success(c)
})

export { findAudioInDrama }
export default app
