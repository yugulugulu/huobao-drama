import { Hono } from 'hono'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest, notFound } from '../utils/response.js'
import { generateImage, generateVideo } from '../services/generation.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { currentUser } from '../middleware/auth.js'
import { findOwnedCharacter, findOwnedDrama, findOwnedScene, findOwnedStoryboard, findOwnedTask } from '../services/ownership.js'
import { isOwnedStorageReference } from '../utils/storage.js'

const app = new Hono()

type TaskType = 'image' | 'video'

function uniqueUrls(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

function promptReferencesName(prompt: string, name: string): boolean {
  if (!name) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return prompt.includes(`@${name}`)
    || new RegExp(`@音频\\d+${escaped}(?![^\\s@])`).test(prompt)
}

function taskResponse(row: typeof schema.sysTask.$inferSelect) {
  if (!row.providerError) return row
  try {
    return { ...row, providerError: JSON.parse(row.providerError) }
  } catch {
    return row
  }
}

// POST /tasks — 发起生成任务（body.type: image | video）
app.post('/', async (c) => {
  const body = await c.req.json()
  const userId = currentUser(c).id
  const type = body.type as TaskType
  if (type !== 'image' && type !== 'video') return badRequest(c, 'type 必须为 image 或 video')

  if (type === 'image') {
    if (!body.prompt) return badRequest(c, 'prompt is required')
  } else {
    // 视频生成只保留多模态参考：校验素材上限与必填项
    const imgs = body.reference_image_urls?.length || 0
    const vids = body.reference_video_urls?.length || 0
    const auds = uniqueUrls(body.reference_audio_urls).length
    if (imgs > 9 || vids > 3 || auds > 3) {
      return badRequest(c, '参考素材超限：图片≤9、视频≤3、音频≤3')
    }
    if (auds > 0 && imgs + vids === 0) {
      return badRequest(c, '参考音频需要至少 1 个参考图片或视频')
    }
    if (imgs + vids + auds === 0 && !body.prompt) {
      return badRequest(c, '多模态参考模式需要至少一个参考素材或 prompt')
    }
  }

  try {
    if (body.drama_id && !await findOwnedDrama(Number(body.drama_id), userId)) return notFound(c, '项目不存在')
    if (body.storyboard_id && !await findOwnedStoryboard(Number(body.storyboard_id), userId)) return notFound(c, '分镜不存在')
    if (body.scene_id && !await findOwnedScene(Number(body.scene_id), userId)) return notFound(c, '场景不存在')
    if (body.character_id && !await findOwnedCharacter(Number(body.character_id), userId)) return notFound(c, '角色不存在')
    // 集锁定的生成配置优先于请求指定；视频分辨率同样锁定到集
    let configId: number | undefined = body.config_id
    let episodeResolution: string | undefined
    let mergedReferenceAudioUrls = uniqueUrls(body.reference_audio_urls)
    for (const reference of mergedReferenceAudioUrls) {
      if (!isOwnedStorageReference(reference, userId)) {
        return badRequest(c, '参考音频必须是当前用户上传的文件')
      }
    }
    if (body.storyboard_id) {
      const [sb] = await db.select().from(schema.storyboards).where(and(eq(schema.storyboards.id, Number(body.storyboard_id)), eq(schema.storyboards.userId, userId)))
      if (sb) {
        const [ep] = await db.select().from(schema.episodes).where(and(eq(schema.episodes.id, sb.episodeId), eq(schema.episodes.userId, userId)))
        const locked = type === 'image' ? ep?.imageConfigId : ep?.videoConfigId
        if (locked != null) configId = locked
        if (type === 'video' && ep?.resolution) episodeResolution = ep.resolution

        if (type === 'video' && ep) {
          const storyboardLinks = await db.select().from(schema.storyboardAudios).where(and(
            eq(schema.storyboardAudios.userId, userId),
            eq(schema.storyboardAudios.dramaId, ep.dramaId),
            eq(schema.storyboardAudios.storyboardId, sb.id),
          ))
          const episodeLinks = await db.select().from(schema.episodeAudios).where(and(
            eq(schema.episodeAudios.userId, userId),
            eq(schema.episodeAudios.dramaId, ep.dramaId),
            eq(schema.episodeAudios.episodeId, ep.id),
          ))
          const episodeAudioIds = new Set(episodeLinks.map(link => link.audioId))
          const audioIds = [...new Set(storyboardLinks.map(link => link.audioId))]
            .filter(audioId => episodeAudioIds.has(audioId))
          if (audioIds.length) {
            const audios = await db.select().from(schema.audios).where(and(
              eq(schema.audios.userId, userId),
              eq(schema.audios.dramaId, ep.dramaId),
              inArray(schema.audios.id, audioIds),
              isNull(schema.audios.deletedAt),
            ))
            const prompt = String(body.prompt || '')
            const assetUrls = audios
              .filter(audio => audio.fileUrl && promptReferencesName(prompt, audio.name))
              .map(audio => audio.fileUrl!)
            mergedReferenceAudioUrls = uniqueUrls([...assetUrls, ...mergedReferenceAudioUrls])
          }
        }
      }
    }

    if (type === 'video') {
      const imgs = Array.isArray(body.reference_image_urls) ? body.reference_image_urls.length : 0
      const vids = Array.isArray(body.reference_video_urls) ? body.reference_video_urls.length : 0
      if (mergedReferenceAudioUrls.length > 3) return badRequest(c, '参考素材超限：图片≤9、视频≤3、音频≤3')
      if (mergedReferenceAudioUrls.length > 0 && imgs + vids === 0) return badRequest(c, '参考音频需要至少 1 个参考图片或视频')
    }

    logTaskStart('TaskAPI', 'generate', {
      type,
      storyboardId: body.storyboard_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      dramaId: body.drama_id,
    })
    logTaskPayload('TaskAPI', 'request body', body)

    const id = type === 'image'
      ? await generateImage({
        userId,
        storyboardId: body.storyboard_id,
        dramaId: body.drama_id,
        sceneId: body.scene_id,
        characterId: body.character_id,
        prompt: body.prompt,
        model: body.model,
        size: body.size,
        referenceImages: body.reference_images,
        frameType: body.frame_type,
        configId,
      })
      : await generateVideo({
        userId,
        storyboardId: body.storyboard_id,
        dramaId: body.drama_id,
        prompt: body.prompt,
        model: body.model,
        referenceMode: 'reference',
        referenceImageUrls: body.reference_image_urls,
        referenceVideoUrls: body.reference_video_urls,
        referenceAudioUrls: mergedReferenceAudioUrls,
        generateAudio: body.generate_audio,
        duration: body.duration,
        aspectRatio: body.aspect_ratio,
        resolution: episodeResolution || body.resolution,
        configId,
      })

    const [record] = await db.select().from(schema.sysTask)
      .where(and(eq(schema.sysTask.id, id), eq(schema.sysTask.userId, userId)))
    logTaskSuccess('TaskAPI', 'generate', { taskId: id, type, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('TaskAPI', 'generate', { type, error: err.message || err.code })

    // 透传真人认证错误
    if (err.code === 'PORTRAIT_VERIFICATION_REQUIRED') {
      return c.json({
        code: 'PORTRAIT_VERIFICATION_REQUIRED',
        message: err.message || '素材涉及真人隐私，需要进行真人认证',
        verificationUrl: err.verificationUrl
      }, 403)
    }

    return badRequest(c, err.message)
  }
})

// GET /tasks/:id — 轮询任务状态
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const row = await findOwnedTask(id, currentUser(c).id)
  if (!row) return notFound(c, '任务不存在')
  return success(c, taskResponse(row))
})

// GET /tasks — 按 type / storyboard_id / drama_id 过滤
app.get('/', async (c) => {
  const type = c.req.query('type')
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')

  const userId = currentUser(c).id
  let rows = await db.select().from(schema.sysTask).where(eq(schema.sysTask.userId, userId))

  if (type) rows = rows.filter(r => r.type === type)
  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))

  return success(c, rows)
})

// DELETE /tasks/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  if (!await findOwnedTask(id, userId)) return notFound(c, '任务不存在')
  await db.delete(schema.sysTask).where(and(eq(schema.sysTask.id, id), eq(schema.sysTask.userId, userId)))
  return success(c)
})

export default app
