/**
 * 分镜拆解 Agent 工具
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { db, getInsertId, schema } from '../../db/index.js'
import { and, eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'
import { getDramaId, getEpisodeId, getStoryboardBatch, getStoryboardTaskId, getUserId } from '../context.js'

async function syncStoryboardCharacters(conn: any, storyboardId: number, characterIds: number[]) {
  await conn.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))


  const uniqueIds = [...new Set(characterIds.filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    await conn.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    })
  }
}

async function syncStoryboardProps(conn: any, storyboardId: number, propIds: number[]) {
  await conn.delete(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))

  const uniqueIds = [...new Set(propIds.filter(Boolean))]
  if (!uniqueIds.length) return

  for (const propId of uniqueIds) {
    await conn.insert(schema.storyboardProps).values({
      storyboardId,
      propId,
    })
  }
}

async function getEpisodeSceneIds(conn: any, episodeId: number) {
  const links = await conn.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  return new Set(links.map((link: any) => link.sceneId))
}

async function getEpisodeCharacterIds(conn: any, episodeId: number) {
  const links = await conn.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  return new Set(links.map((link: any) => link.characterId))
}

async function getEpisodePropIds(conn: any, episodeId: number) {
  const links = await conn.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  return new Set(links.map((link: any) => link.propId))
}

async function validateStoryboardBindings(
  conn: any,
  userId: number,
  episodeId: number,
  dramaId: number,
  sceneId: number | null | undefined,
  characterIds: number[] | undefined,
  propIds?: number[] | undefined,
  syncEpisodeLinks = true,
) {
  const episodeSceneIds = await getEpisodeSceneIds(conn, episodeId)
  const episodeCharacterIds = await getEpisodeCharacterIds(conn, episodeId)
  const episodePropIds = await getEpisodePropIds(conn, episodeId)

  // 场景/角色/道具必须属于本剧；正式写入时自动补齐当前集关联。
  if (sceneId != null) {
    const [scene] = await conn.select().from(schema.scenes).where(and(eq(schema.scenes.id, sceneId), eq(schema.scenes.userId, userId)))
    if (!scene || scene.dramaId !== dramaId || scene.deletedAt) {
      throw new Error(`scene_id ${sceneId} 不属于当前项目`)
    }
    if (syncEpisodeLinks && !episodeSceneIds.has(sceneId)) {
      await conn.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: now() })
      episodeSceneIds.add(sceneId)
    }
  }

  const uniqueCharacterIds = [...new Set((characterIds || []).filter(Boolean))]
  for (const characterId of uniqueCharacterIds) {
    const [character] = await conn.select().from(schema.characters).where(and(eq(schema.characters.id, characterId), eq(schema.characters.userId, userId)))
    if (!character || character.dramaId !== dramaId || character.deletedAt) {
      throw new Error(`character_id ${characterId} 不属于当前项目`)
    }
    if (syncEpisodeLinks && !episodeCharacterIds.has(characterId)) {
      await conn.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: now() })
      episodeCharacterIds.add(characterId)
    }
  }

  const uniquePropIds = [...new Set((propIds || []).filter(Boolean))]
  for (const propId of uniquePropIds) {
    const [prop] = await conn.select().from(schema.props).where(and(eq(schema.props.id, propId), eq(schema.props.userId, userId)))
    if (!prop || prop.dramaId !== dramaId || prop.deletedAt) {
      throw new Error(`prop_id ${propId} 不属于当前项目`)
    }
    if (syncEpisodeLinks && !episodePropIds.has(propId)) {
      await conn.insert(schema.episodeProps).values({ episodeId, propId, createdAt: now() })
      episodePropIds.add(propId)
    }
  }
}

type ToolContext = ToolExecutionContext | undefined

function isNullText(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim().toLowerCase() === 'null')
}

function requireIds(context: ToolContext): { userId: number; episodeId: number; dramaId: number } | { error: string } {
  const userId = getUserId(context?.requestContext)
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!userId || !episodeId || !dramaId) return { error: 'Missing userId/episodeId/dramaId in request context' }
  return { userId, episodeId, dramaId }
}

const readStoryboardContext = createTool({
  id: 'read_storyboard_context',
  description: 'Read the screenplay, characters, scenes, and props for storyboard breakdown.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { userId, episodeId, dramaId } = ids
    const [ep] = await db.select().from(schema.episodes)
      .where(and(eq(schema.episodes.id, episodeId), eq(schema.episodes.userId, userId)))
    if (!ep) return { error: 'Episode not found' }
    const script = ep.scriptContent || ep.content
    if (!script) return { error: 'Episode has no script' }

    const charLinks = await db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId))
    const sceneLinks = await db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId))
    const propLinks = await db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId))

    const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
    const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))
    const linkedPropIds = new Set(propLinks.map(link => link.propId))

    const chars = await db.select().from(schema.characters)
      .where(and(eq(schema.characters.userId, userId), eq(schema.characters.dramaId, dramaId)))
    const scns = await db.select().from(schema.scenes)
      .where(and(eq(schema.scenes.userId, userId), eq(schema.scenes.dramaId, dramaId)))
    const prps = await db.select().from(schema.props)
      .where(and(eq(schema.props.userId, userId), eq(schema.props.dramaId, dramaId)))
    const existingStoryboards = await db.select().from(schema.storyboards)
      .where(and(eq(schema.storyboards.userId, userId), eq(schema.storyboards.episodeId, episodeId)))

    const characters = chars
      .filter(c => !c.deletedAt)
      .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
      .map(c => ({
        id: c.id,
        name: c.name,
        role: c.role || '',
        description: c.description || '',
        appearance: c.appearance || '',
        styling: c.styling || '',
        image_url: c.imageUrl || '',
        reference_images: c.referenceImages || '',
      }))

    const scenes = scns
      .filter(s => !s.deletedAt)
      .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
      .map(s => ({
        id: s.id,
        location: s.location,
        time: s.time,
        prompt: s.prompt || '',
        lighting: s.lighting || '',
        image_url: s.imageUrl || '',
        storyboard_count: s.storyboardCount || 0,
      }))

    const props = prps
      .filter(p => !p.deletedAt)
      .filter(p => !linkedPropIds.size || linkedPropIds.has(p.id))
      .map(p => ({
        id: p.id,
        name: p.name,
        type: p.type || '',
        description: p.description || '',
        image_url: p.imageUrl || '',
      }))

    const existingStoryboardPayload = await Promise.all(existingStoryboards
      .filter(sb => !sb.deletedAt)
      .map(async (sb) => {
        const links = await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
        const sbPropLinks = await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, sb.id))
        return {
          id: sb.id,
          shot_number: sb.storyboardNumber,
          title: sb.title || '',
          scene_id: sb.sceneId,
          character_ids: links.map(link => link.characterId),
          prop_ids: sbPropLinks.map(link => link.propId),
          shot_type: sb.shotType || '',
          duration: sb.duration || 0,
          description: sb.description || '',
          atmosphere: sb.atmosphere || '',
          video_prompt: sb.videoPrompt || '',
        }
      }))

    const payload = {
      episode: {
        id: ep.id,
        title: ep.title,
        episode_number: ep.episodeNumber,
        description: ep.description || '',
      },
      script,
      characters,
      scenes,
      props,
      existing_storyboards: existingStoryboardPayload,
    }
    logTaskSuccess('StoryboardTool', 'read-context', {
      episodeId,
      dramaId,
      characters: characters.length,
      scenes: scenes.length,
      props: props.length,
      existingStoryboards: payload.existing_storyboards.length,
      scriptLength: script.length,
    })
    return payload
  },
})

const saveStoryboards = createTool({
  id: 'save_storyboards',
  description: 'Save one small batch of generated storyboards to the current breakdown draft. It never replaces existing storyboards.',
  inputSchema: z.object({
    storyboards: z.array(z.object({
      shot_number: z.number().int().positive(),
      description: z.string().max(6000),
      atmosphere: z.string().max(1500),
      duration: z.number().int().min(8).max(15),
      scene_id: z.number().int().positive().nullable().optional(),
      character_ids: z.array(z.number().int().positive()).max(20).optional(),
      prop_ids: z.array(z.number().int().positive()).max(20).optional(),
    }).strict()).min(1).max(10),
  }),
  execute: async ({ storyboards }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { userId, episodeId, dramaId } = ids
    const taskId = getStoryboardTaskId(context?.requestContext)
    const batch = getStoryboardBatch(context?.requestContext)
    if (!taskId || !batch) return { error: '分镜拆分缺少批次上下文，无法保存' }
    if (storyboards.length > 10) return { error: '单批最多保存 10 个分镜，请拆分后重试' }
    const expectedCount = batch.batchEnd - batch.batchStart + 1
    if (storyboards.length !== expectedCount || storyboards.some(sb => sb.shot_number < batch.batchStart || sb.shot_number > batch.batchEnd)) {
      return { error: `当前批次必须恰好提交分镜 ${batch.batchStart}-${batch.batchEnd}，共 ${expectedCount} 个` }
    }
    const shotNumbers = storyboards.map(sb => sb.shot_number)
    if (new Set(shotNumbers).size !== shotNumbers.length) return { error: '当前批次存在重复 shot_number' }

    const [episode] = await db.select({ dramaId: schema.episodes.dramaId })
      .from(schema.episodes)
      .where(and(eq(schema.episodes.id, episodeId), eq(schema.episodes.userId, userId)))
    if (!episode || episode.dramaId !== dramaId) return { error: 'Episode does not belong to the current project' }
    const ts = now()
    logTaskProgress('StoryboardTool', 'save-begin', {
      taskId,
      episodeId,
      dramaId,
      batchIndex: batch.batchIndex,
      totalBatches: batch.totalBatches,
      payloadChars: JSON.stringify(storyboards).length,
      count: storyboards.length,
      shotNumbers: storyboards.map(sb => sb.shot_number).join(','),
    })
    await db.transaction(async (tx) => {
      const [task] = await tx.select().from(schema.storyboardBreakdownTasks)
        .where(and(
          eq(schema.storyboardBreakdownTasks.taskId, taskId),
          eq(schema.storyboardBreakdownTasks.userId, userId),
          eq(schema.storyboardBreakdownTasks.dramaId, dramaId),
          eq(schema.storyboardBreakdownTasks.episodeId, episodeId),
          eq(schema.storyboardBreakdownTasks.status, 'running'),
          eq(schema.storyboardBreakdownTasks.currentBatch, batch.batchIndex),
          eq(schema.storyboardBreakdownTasks.retryCount, batch.retryCount),
        ))
        .for('update')
      if (!task) throw new Error('当前批次已结束或已进入下一次重试，拒绝迟到的保存请求')

      for (const sb of storyboards) {
        await validateStoryboardBindings(tx, userId, episodeId, dramaId, sb.scene_id, sb.character_ids, sb.prop_ids, false)
        await tx.delete(schema.storyboardBreakdownItems).where(and(
          eq(schema.storyboardBreakdownItems.taskId, taskId),
          eq(schema.storyboardBreakdownItems.shotNumber, sb.shot_number),
        ))
        await tx.insert(schema.storyboardBreakdownItems).values({
          taskId,
          batchIndex: batch.batchIndex,
          shotNumber: sb.shot_number,
          payload: JSON.stringify(sb),
          createdAt: ts,
        })
      }
      await tx.update(schema.storyboardBreakdownTasks).set({
        stage: '保存分镜',
        currentBatch: batch.batchIndex,
        updatedAt: ts,
      }).where(eq(schema.storyboardBreakdownTasks.taskId, taskId))
    })

    logTaskSuccess('StoryboardTool', 'save-complete', {
      taskId,
      episodeId,
      batchIndex: batch.batchIndex,
      count: storyboards.length,
    })
    return { message: `Saved draft batch ${batch.batchIndex}`, count: storyboards.length, batch_index: batch.batchIndex }
  },
})

const updateStoryboard = createTool({
  id: 'update_storyboard',
  description: 'Update a specific storyboard shot.',
  inputSchema: z.object({
    storyboard_id: z.number(),
    title: z.string().nullable().optional(),
    shot_type: z.string().nullable().optional(),
    angle: z.string().nullable().optional(),
    movement: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    time: z.string().nullable().optional(),
    result: z.string().nullable().optional(),
    atmosphere: z.string().nullable().optional(),
    image_prompt: z.string().nullable().optional(),
    video_prompt: z.string().nullable().optional(),
    bgm_prompt: z.string().nullable().optional(),
    sound_effect: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    scene_id: z.number().nullable().optional(),
    character_ids: z.array(z.number()).optional(),
    prop_ids: z.array(z.number()).optional(),
    duration: z.number().optional(),
  }),
  execute: async ({ storyboard_id, ...fields }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { userId, episodeId, dramaId } = ids
    const [storyboard] = await db.select().from(schema.storyboards)
      .where(and(eq(schema.storyboards.id, storyboard_id), eq(schema.storyboards.userId, userId), eq(schema.storyboards.episodeId, episodeId)))
    if (!storyboard) return { error: `Storyboard ${storyboard_id} not found` }
    logTaskProgress('StoryboardTool', 'update-begin', {
      episodeId,
      storyboardId: storyboard_id,
      fields: Object.keys(fields),
    })

    const currentCharacterIds = 'character_ids' in fields
      ? fields.character_ids
      : (await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)))
          .map(link => link.characterId)

    const currentPropIds = 'prop_ids' in fields
      ? fields.prop_ids
      : (await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, storyboard_id)))
          .map(link => link.propId)

    await validateStoryboardBindings(
      db,
      userId,
      episodeId,
      dramaId,
      'scene_id' in fields ? fields.scene_id : storyboard.sceneId,
      currentCharacterIds,
      currentPropIds,
    )

    const updates: Record<string, any> = { updatedAt: now() }
    // 模型有时会把未修改字段回传为 null 或字符串 "null"，忽略这些值以免覆盖已有内容。
    if ('title' in fields && !isNullText(fields.title)) updates.title = fields.title
    if ('shot_type' in fields && !isNullText(fields.shot_type)) updates.shotType = fields.shot_type
    if ('angle' in fields && !isNullText(fields.angle)) updates.angle = fields.angle
    if ('movement' in fields && !isNullText(fields.movement)) updates.movement = fields.movement
    if ('location' in fields && !isNullText(fields.location)) updates.location = fields.location
    if ('time' in fields && !isNullText(fields.time)) updates.time = fields.time
    if ('result' in fields && !isNullText(fields.result)) updates.result = fields.result
    if ('atmosphere' in fields && !isNullText(fields.atmosphere)) updates.atmosphere = fields.atmosphere
    if ('image_prompt' in fields && !isNullText(fields.image_prompt)) updates.imagePrompt = fields.image_prompt
    if ('video_prompt' in fields && typeof fields.video_prompt === 'string' && !isNullText(fields.video_prompt) && fields.video_prompt.trim()) updates.videoPrompt = fields.video_prompt
    if ('bgm_prompt' in fields && !isNullText(fields.bgm_prompt)) updates.bgmPrompt = fields.bgm_prompt
    if ('sound_effect' in fields && !isNullText(fields.sound_effect)) updates.soundEffect = fields.sound_effect
    if ('description' in fields && !isNullText(fields.description)) updates.description = fields.description
    if ('scene_id' in fields) updates.sceneId = fields.scene_id
    if ('duration' in fields) updates.duration = fields.duration
    await db.update(schema.storyboards).set(updates)
      .where(and(eq(schema.storyboards.id, storyboard_id), eq(schema.storyboards.userId, userId), eq(schema.storyboards.episodeId, episodeId)))
    if ('character_ids' in fields) await syncStoryboardCharacters(db, storyboard_id, fields.character_ids || [])
    if ('prop_ids' in fields) await syncStoryboardProps(db, storyboard_id, fields.prop_ids || [])
    logTaskSuccess('StoryboardTool', 'update-complete', {
      episodeId,
      storyboardId: storyboard_id,
      updatedFields: Object.keys(updates),
      characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      propIds: 'prop_ids' in fields ? (fields.prop_ids || []).join(',') : undefined,
    })
    return { message: `Storyboard ${storyboard_id} updated` }
  },
})

export const storyboardTools = { readStoryboardContext, saveStoryboards, updateStoryboard }
