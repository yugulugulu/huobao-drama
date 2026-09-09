import { Hono } from 'hono'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, badRequest, now } from '../utils/response.js'
import { toSnakeCaseArray, toSnakeCase } from '../utils/transform.js'
import { getActiveConfigId } from '../services/ai.js'
import { EXTRACT_TARGETS, getExtractionStatus, startExtraction, type ExtractTarget } from '../services/extraction.js'
import { getVideoPromptBatchStatus, startVideoPromptBatch } from '../services/video-prompts.js'
import { getStoryboardBreakdownStatus, startStoryboardBreakdown } from '../services/storyboard-breakdown.js'
import { currentUser } from '../middleware/auth.js'
import { findOwnedEpisode, findOwnedDrama } from '../services/ownership.js'

const app = new Hono()

// POST /episodes — Create a new episode
app.post('/', async (c) => {
  const body = await c.req.json()
  const userId = currentUser(c).id
  if (!body.drama_id) return badRequest(c, 'drama_id required')
  if (!await findOwnedDrama(Number(body.drama_id), userId)) return notFound(c, '剧本不存在')

  // 图片配置仍自动锁定；视频配置有则锁定，无则允许先创建项目
  const imageConfigId = body.image_config_id ?? await getActiveConfigId('image', userId)
  const videoConfigId = body.video_config_id ?? await getActiveConfigId('video', userId)
  if (!imageConfigId) return badRequest(c, '未找到启用的图片生成配置，请先在设置中心添加')
  const ts = now()

  // Get next episode number（忽略已软删的集，删除中间集后新集号可复用空位之后的最大值）
  const existing = await db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.userId, userId), eq(schema.episodes.dramaId, body.drama_id), isNull(schema.episodes.deletedAt)))
    .orderBy(schema.episodes.episodeNumber)
  const nextNum = existing.length ? Math.max(...existing.map(e => e.episodeNumber)) + 1 : 1

  const res = await db.insert(schema.episodes).values({
    userId,
    dramaId: body.drama_id,
    episodeNumber: nextNum,
    title: body.title || `第${nextNum}集`,
    imageConfigId,
    videoConfigId,
    // 视频分辨率在创建集时固定，后续可通过 PUT 修改
    resolution: ['720p', '1080p', '4k'].includes(body.resolution) ? body.resolution : '720p',
    createdAt: ts,
    updatedAt: ts,
  })

  const [ep] = await db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, getInsertId(res)), eq(schema.episodes.userId, userId)))

  // 项目级音频默认可用于每一集；后续只需在分镜中手动选择需要引用的音频。
  const projectAudios = await db.select({ id: schema.audios.id }).from(schema.audios).where(and(
    eq(schema.audios.userId, userId),
    eq(schema.audios.dramaId, ep.dramaId),
    isNull(schema.audios.deletedAt),
  ))
  for (const audio of projectAudios) {
    await db.insert(schema.episodeAudios).values({
      userId,
      dramaId: ep.dramaId,
      episodeId: ep.id,
      audioId: audio.id,
      createdAt: ts,
    }).catch((error: any) => {
      if (!String(error?.message || '').toLowerCase().includes('duplicate')) throw error
    })
  }
  return success(c, {
    id: ep.id,
    episode_number: ep.episodeNumber,
    title: ep.title,
    image_config_id: ep.imageConfigId,
    video_config_id: ep.videoConfigId,
    resolution: ep.resolution,
  })
})

// PUT /episodes/:id - Update episode fields
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  if (!await findOwnedEpisode(id, userId)) return notFound(c, '剧集不存在')
  const body = await c.req.json()

  const allowed = ['content', 'script_content', 'title', 'description', 'status', 'resolution']
  const updates: Record<string, any> = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }
  if (Object.keys(updates).length === 0) return badRequest(c, 'no valid fields')
  if ('resolution' in updates && !['720p', '1080p', '4k'].includes(updates.resolution)) {
    return badRequest(c, 'resolution 只支持 720p / 1080p / 4k')
  }

  // Map snake_case to camelCase for drizzle
  const drizzleUpdates: Record<string, any> = { updatedAt: now() }
  if ('content' in updates) drizzleUpdates.content = updates.content
  if ('script_content' in updates) drizzleUpdates.scriptContent = updates.script_content
  if ('title' in updates) drizzleUpdates.title = updates.title
  if ('description' in updates) drizzleUpdates.description = updates.description
  if ('status' in updates) drizzleUpdates.status = updates.status
  if ('resolution' in updates) drizzleUpdates.resolution = updates.resolution

  await db.update(schema.episodes).set(drizzleUpdates).where(and(eq(schema.episodes.id, id), eq(schema.episodes.userId, userId)))
  return success(c)
})

// DELETE /episodes/:id - Soft delete episode（其分镜/生成记录保留但不可达）
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const ep = await findOwnedEpisode(id, userId)
  if (!ep) return notFound(c, '剧集不存在')
  await db.update(schema.episodes).set({ deletedAt: now(), updatedAt: now() })
    .where(and(eq(schema.episodes.id, id), eq(schema.episodes.userId, userId)))
  return success(c)
})

// GET /episodes/:id/characters — characters linked to this episode
app.get('/:id/characters', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const userId = currentUser(c).id
  if (!await findOwnedEpisode(episodeId, userId)) return notFound(c, '剧集不存在')
  const links = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const charIds = links.map(l => l.characterId)
  if (!charIds.length) return success(c, [])
  const allChars = await db.select().from(schema.characters).where(eq(schema.characters.userId, userId))
  const result = allChars.filter(ch => charIds.includes(ch.id) && !ch.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:id/scenes — scenes linked to this episode
app.get('/:id/scenes', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const userId = currentUser(c).id
  if (!await findOwnedEpisode(episodeId, userId)) return notFound(c, '剧集不存在')
  const links = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const sceneIds = links.map(l => l.sceneId)
  if (!sceneIds.length) return success(c, [])
  const allScenes = await db.select().from(schema.scenes).where(eq(schema.scenes.userId, userId))
  const result = allScenes.filter(sc => sceneIds.includes(sc.id) && !sc.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:id/props — props linked to this episode
app.get('/:id/props', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const userId = currentUser(c).id
  if (!await findOwnedEpisode(episodeId, userId)) return notFound(c, '剧集不存在')
  const links = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const propIds = links.map(l => l.propId)
  if (!propIds.length) return success(c, [])
  const allProps = await db.select().from(schema.props).where(eq(schema.props.userId, userId))
  const result = allProps.filter(p => propIds.includes(p.id) && !p.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:id/audios — 当前集已关联的音频资产
app.get('/:id/audios', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const episode = await findOwnedEpisode(episodeId, userId)
  if (!episode) return notFound(c, '剧集不存在')
  const links = await db.select().from(schema.episodeAudios)
    .where(and(
      eq(schema.episodeAudios.userId, userId),
      eq(schema.episodeAudios.dramaId, episode.dramaId),
      eq(schema.episodeAudios.episodeId, episodeId),
    ))
  const ids = links.map(link => link.audioId)
  if (!ids.length) return success(c, [])
  const rows = await db.select().from(schema.audios).where(and(
    eq(schema.audios.userId, userId),
    eq(schema.audios.dramaId, episode.dramaId),
    isNull(schema.audios.deletedAt),
  ))
  return success(c, toSnakeCaseArray(rows.filter(audio => ids.includes(audio.id))))
})

// POST /episodes/:id/extract — 异步提取资产（target: characters | scenes | props），立即返回，前端轮询状态
app.post('/:id/extract', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const body = await c.req.json()
  const target = body.target as ExtractTarget
  if (!EXTRACT_TARGETS.includes(target)) return badRequest(c, 'target 必须是 characters / scenes / props')
  const ep = await findOwnedEpisode(id, userId)
  if (!ep) return notFound(c, '剧集不存在')
  const started = startExtraction(ep.id, ep.dramaId, target, { userId, model: body.model || undefined, configId: body.config_id ?? undefined })
  return success(c, { target, status: 'running', already_running: !started })
})

// GET /episodes/:id/extract-status — 查询三类资产提取任务状态
app.get('/:id/extract-status', async (c) => {
  const id = Number(c.req.param('id'))
  if (!await findOwnedEpisode(id, currentUser(c).id)) return notFound(c, '剧集不存在')
  return success(c, getExtractionStatus(id))
})

// POST /episodes/:id/generate-video-prompts — 异步批量为缺少视频提示词的分镜生成（立即返回，前端轮询状态）
app.post('/:id/generate-video-prompts', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const body = await c.req.json().catch(() => ({}))
  const ep = await findOwnedEpisode(id, userId)
  if (!ep) return notFound(c, '剧集不存在')
  const storyboardIds = Array.isArray(body.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : undefined
  const result = await startVideoPromptBatch(ep.id, ep.dramaId, { userId, model: body.model || undefined, configId: body.config_id ?? undefined }, storyboardIds)
  if (result.total === -1) return success(c, { status: 'running', already_running: true })
  if (!result.started) return success(c, { status: 'idle', total: 0 })
  return success(c, { status: 'running', total: result.total })
})

// GET /episodes/:id/video-prompts-status — 查询批量视频提示词任务状态
app.get('/:id/video-prompts-status', async (c) => {
  const id = Number(c.req.param('id'))
  if (!await findOwnedEpisode(id, currentUser(c).id)) return notFound(c, '剧集不存在')
  return success(c, getVideoPromptBatchStatus(id))
})

// POST /episodes/:id/break-storyboard — 异步拆分分镜，立即返回并由前端轮询状态
app.post('/:id/break-storyboard', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const body = await c.req.json().catch(() => ({}))
  const ep = await findOwnedEpisode(id, userId)
  if (!ep) return notFound(c, '剧集不存在')
  if (!body.message) return badRequest(c, 'message required')
  const result = await startStoryboardBreakdown(ep.id, ep.dramaId, {
    userId, message: body.message, model: body.model || undefined, configId: body.config_id ?? undefined,
  })
  return success(c, { status: 'running', already_running: !result.started, task_id: result.taskId })
})

// GET /episodes/:id/break-storyboard-status — 查询分镜拆分任务
app.get('/:id/break-storyboard-status', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = currentUser(c).id
  if (!await findOwnedEpisode(id, userId)) return notFound(c, '剧集不存在')
  return success(c, await getStoryboardBreakdownStatus(userId, id))
})

// GET /episodes/:episode_id/storyboards
app.get('/:episode_id/storyboards', async (c) => {
  const episodeId = Number(c.req.param('episode_id'))
  const userId = currentUser(c).id
  const episode = await findOwnedEpisode(episodeId, userId)
  if (!episode) return notFound(c, '剧集不存在')
  const rows = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.userId, userId), eq(schema.storyboards.episodeId, episodeId)))
    .orderBy(schema.storyboards.storyboardNumber)
  if (!rows.length) return success(c, [])

  const links = await db.select().from(schema.storyboardCharacters)
    .where(inArray(schema.storyboardCharacters.storyboardId, rows.map(row => row.id)))
  const charIdsByStoryboard = new Map<number, number[]>()
  for (const link of links) {
    const arr = charIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.characterId)
    charIdsByStoryboard.set(link.storyboardId, arr)
  }

  const propLinks = await db.select().from(schema.storyboardProps)
    .where(inArray(schema.storyboardProps.storyboardId, rows.map(row => row.id)))
  const propIdsByStoryboard = new Map<number, number[]>()
  for (const link of propLinks) {
    const arr = propIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.propId)
    propIdsByStoryboard.set(link.storyboardId, arr)
  }

  const audioLinks = await db.select().from(schema.storyboardAudios)
    .where(inArray(schema.storyboardAudios.storyboardId, rows.map(row => row.id)))
  const audioIdsByStoryboard = new Map<number, number[]>()
  for (const link of audioLinks) {
    const arr = audioIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.audioId)
    audioIdsByStoryboard.set(link.storyboardId, arr)
  }

  const episodeCharLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharIds = episodeCharLinks.map(link => link.characterId)
  const allChars = (await db.select().from(schema.characters).where(eq(schema.characters.userId, userId)))
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt)

  const episodePropLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const episodePropIds = episodePropLinks.map(link => link.propId)
  const allProps = (await db.select().from(schema.props).where(eq(schema.props.userId, userId)))
    .filter(p => episodePropIds.includes(p.id) && !p.deletedAt)

  const episodeAudioLinks = await db.select().from(schema.episodeAudios)
    .where(and(eq(schema.episodeAudios.userId, userId), eq(schema.episodeAudios.dramaId, episode.dramaId), eq(schema.episodeAudios.episodeId, episodeId)))
  const episodeAudioIds = episodeAudioLinks.map(link => link.audioId)
  const allAudios = (await db.select().from(schema.audios).where(and(
    eq(schema.audios.userId, userId),
    isNull(schema.audios.deletedAt),
  ))).filter(audio => episodeAudioIds.includes(audio.id))

  return success(c, rows.map((row) => ({
    ...toSnakeCase(row),
    character_ids: charIdsByStoryboard.get(row.id) || [],
    prop_ids: propIdsByStoryboard.get(row.id) || [],
    audio_ids: audioIdsByStoryboard.get(row.id) || [],
    characters: allChars
      .filter(ch => (charIdsByStoryboard.get(row.id) || []).includes(ch.id))
      .map(ch => toSnakeCase(ch)),
    props: allProps
      .filter(p => (propIdsByStoryboard.get(row.id) || []).includes(p.id))
      .map(p => toSnakeCase(p)),
    audios: allAudios
      .filter(audio => (audioIdsByStoryboard.get(row.id) || []).includes(audio.id))
      .map(audio => toSnakeCase(audio)),
  })))
})

// GET /episodes/:id/pipeline-status — 流水线进度
// GET /episodes/:id/generation-tasks — 按集聚合 sys_task + video_merges
// sys_task 无 episode_id,通过 storyboard/scene/character/prop 关联键归属到当前集
app.get('/:id/generation-tasks', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const ep = await findOwnedEpisode(episodeId, userId)
  if (!ep) return notFound(c, 'Episode not found')

  const sbs = await db.select().from(schema.storyboards).where(and(eq(schema.storyboards.userId, userId), eq(schema.storyboards.episodeId, episodeId)))
  const storyboardIds = new Set(sbs.map(s => s.id))

  const epScenes = await db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId))
  const sceneIds = new Set(epScenes.map(r => r.sceneId))
  // 兼容 scenes.episodeId 直挂的旧数据
  const directScenes = await db.select().from(schema.scenes).where(and(eq(schema.scenes.userId, userId), eq(schema.scenes.episodeId, episodeId)))
  directScenes.forEach(s => sceneIds.add(s.id))

  const epChars = await db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId))
  const characterIds = new Set(epChars.map(r => r.characterId))

  const dramaProps = await db.select().from(schema.props).where(and(eq(schema.props.userId, userId), eq(schema.props.dramaId, ep.dramaId)))
  const propIds = new Set(dramaProps.map(p => p.id))

  const allTasks = await db.select().from(schema.sysTask).where(and(eq(schema.sysTask.userId, userId), eq(schema.sysTask.dramaId, ep.dramaId)))
  const tasks = allTasks
    .filter(t =>
      (t.storyboardId && storyboardIds.has(t.storyboardId)) ||
      (t.sceneId && sceneIds.has(t.sceneId)) ||
      (t.characterId && characterIds.has(t.characterId)) ||
      (t.propId && propIds.has(t.propId))
    )
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))

  const merges = (await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.userId, userId), eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt))))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 20)

  return success(c, {
    tasks: toSnakeCaseArray(tasks),
    merges: toSnakeCaseArray(merges),
  })
})

app.get('/:id/pipeline-status', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const userId = currentUser(c).id
  const ep = await findOwnedEpisode(episodeId, userId)
  if (!ep) return notFound(c, 'Episode not found')

  const chars = await db.select().from(schema.characters).where(and(eq(schema.characters.userId, userId), eq(schema.characters.dramaId, ep.dramaId)))
  const scenes = await db.select().from(schema.scenes).where(and(eq(schema.scenes.userId, userId), eq(schema.scenes.dramaId, ep.dramaId)))
  const sbs = await db.select().from(schema.storyboards).where(and(eq(schema.storyboards.userId, userId), eq(schema.storyboards.episodeId, episodeId)))
  const merges = await db.select().from(schema.videoMerges).where(and(eq(schema.videoMerges.userId, userId), eq(schema.videoMerges.episodeId, episodeId)))

  const sbsWithImage = sbs.filter(s => s.composedImage)
  const sbsWithVideo = sbs.filter(s => s.videoUrl)
  const latestMerge = merges[merges.length - 1]

  function stepStatus(done: boolean, partial?: boolean) {
    if (done) return 'done'
    if (partial) return 'partial'
    return 'pending'
  }

  return success(c, {
    episode_id: episodeId,
    steps: {
      script_rewrite: { status: ep.scriptContent ? 'done' : (ep.content ? 'ready' : 'pending') },
      extract_characters: { status: stepStatus(chars.length > 0), count: chars.length },
      extract_scenes: { status: stepStatus(scenes.length > 0), count: scenes.length },
      extract_storyboards: { status: stepStatus(sbs.length > 0), count: sbs.length },
      generate_images: { status: stepStatus(sbsWithImage.length === sbs.length && sbs.length > 0, sbsWithImage.length > 0), completed: sbsWithImage.length, total: sbs.length },
      generate_videos: { status: stepStatus(sbsWithVideo.length === sbs.length && sbs.length > 0, sbsWithVideo.length > 0), completed: sbsWithVideo.length, total: sbs.length },
      merge_episode: { status: latestMerge?.status === 'completed' ? 'done' : (latestMerge ? latestMerge.status : 'pending'), merged_url: latestMerge?.mergedUrl },
    },
  })
})

export default app
