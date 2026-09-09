/** 分镜拆分：小批次生成草稿，全部成功后原子替换正式分镜。 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db, getInsertId, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { now } from '../utils/response.js'

export type StoryboardBreakdownStage = '读取剧本' | '分析剧本' | '生成分镜' | '保存分镜'
export interface StoryboardBreakdownStatus {
  task_id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  stage: StoryboardBreakdownStage
  started_at: string
  updated_at: string
  finished_at?: string
  error?: string
  result_count: number
  total_batches: number
  completed_batches: number
  current_batch?: number
  retry_count: number
  target_shots: number
}

const BATCH_SIZE = 5
const MAX_RETRIES = 3
const BATCH_TIMEOUT_MS = 3 * 60 * 1000
const activeTasks = new Set<string>()
type TaskRow = typeof schema.storyboardBreakdownTasks.$inferSelect

function statusOf(row: TaskRow, resultCount: number): StoryboardBreakdownStatus {
  return {
    task_id: row.taskId,
    status: row.status as StoryboardBreakdownStatus['status'],
    stage: row.stage as StoryboardBreakdownStage,
    started_at: row.startedAt,
    updated_at: row.updatedAt,
    finished_at: row.finishedAt || undefined,
    error: row.error || undefined,
    result_count: resultCount,
    total_batches: row.totalBatches,
    completed_batches: row.completedBatches,
    current_batch: row.currentBatch || undefined,
    retry_count: row.retryCount,
    target_shots: row.targetShots,
  }
}

function isToolName(name: unknown, ...candidates: string[]) {
  return typeof name === 'string' && candidates.includes(name)
}

function toolError(tool: any): string | null {
  const raw = tool?.result ?? tool?.output ?? tool?.data
  const value = typeof raw === 'string' ? (() => {
    try { return JSON.parse(raw) } catch { return null }
  })() : raw
  return value && typeof value === 'object' && value.error ? String(value.error) : null
}

async function getTask(taskId: string) {
  const [row] = await db.select().from(schema.storyboardBreakdownTasks)
    .where(eq(schema.storyboardBreakdownTasks.taskId, taskId))
  return row
}

async function setTask(taskId: string, patch: Record<string, any>) {
  await db.update(schema.storyboardBreakdownTasks)
    .set({ ...patch, updatedAt: now() })
    .where(eq(schema.storyboardBreakdownTasks.taskId, taskId))
}

async function setBatchTask(taskId: string, batchIndex: number, retryCount: number, patch: Record<string, any>) {
  await db.update(schema.storyboardBreakdownTasks)
    .set({ ...patch, updatedAt: now() })
    .where(and(
      eq(schema.storyboardBreakdownTasks.taskId, taskId),
      eq(schema.storyboardBreakdownTasks.status, 'running'),
      eq(schema.storyboardBreakdownTasks.currentBatch, batchIndex),
      eq(schema.storyboardBreakdownTasks.retryCount, retryCount),
    ))
}

async function getDraftItems(taskId: string) {
  return db.select().from(schema.storyboardBreakdownItems)
    .where(eq(schema.storyboardBreakdownItems.taskId, taskId))
    .orderBy(asc(schema.storyboardBreakdownItems.shotNumber))
}

function isBatchComplete(items: Array<{ batchIndex: number; shotNumber: number }>, batchIndex: number, batchStart: number, batchEnd: number) {
  const shots = items.filter(item => item.batchIndex === batchIndex).map(item => item.shotNumber)
  return shots.length === batchEnd - batchStart + 1
    && new Set(shots).size === shots.length
    && shots.every(shotNumber => shotNumber >= batchStart && shotNumber <= batchEnd)
}

async function syncRelations(tx: any, storyboardId: number, characterIds: number[], propIds: number[]) {
  for (const characterId of [...new Set(characterIds)]) {
    await tx.insert(schema.storyboardCharacters).values({ storyboardId, characterId })
  }
  for (const propId of [...new Set(propIds)]) {
    await tx.insert(schema.storyboardProps).values({ storyboardId, propId })
  }
}

async function validateAndSyncEpisodeBindings(tx: any, task: TaskRow, payloads: any[], ts: string) {
  const sceneIds = [...new Set(payloads.map(sb => sb.scene_id).filter((id): id is number => Number.isInteger(id)))]
  const characterIds = [...new Set(payloads.flatMap(sb => sb.character_ids || []))] as number[]
  const propIds = [...new Set(payloads.flatMap(sb => sb.prop_ids || []))] as number[]

  const sceneLinks = await tx.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, task.episodeId))
  const characterLinks = await tx.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, task.episodeId))
  const propLinks = await tx.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, task.episodeId))
  const linkedSceneIds = new Set(sceneLinks.map((row: any) => row.sceneId))
  const linkedCharacterIds = new Set(characterLinks.map((row: any) => row.characterId))
  const linkedPropIds = new Set(propLinks.map((row: any) => row.propId))

  for (const sceneId of sceneIds) {
    const [scene] = await tx.select().from(schema.scenes)
      .where(and(eq(schema.scenes.id, sceneId), eq(schema.scenes.userId, task.userId)))
    if (!scene || scene.dramaId !== task.dramaId || scene.deletedAt) throw new Error(`scene_id ${sceneId} 不属于当前项目`)
    if (!linkedSceneIds.has(sceneId)) {
      await tx.insert(schema.episodeScenes).values({ episodeId: task.episodeId, sceneId, createdAt: ts })
      linkedSceneIds.add(sceneId)
    }
  }
  for (const characterId of characterIds) {
    const [character] = await tx.select().from(schema.characters)
      .where(and(eq(schema.characters.id, characterId), eq(schema.characters.userId, task.userId)))
    if (!character || character.dramaId !== task.dramaId || character.deletedAt) throw new Error(`character_id ${characterId} 不属于当前项目`)
    if (!linkedCharacterIds.has(characterId)) {
      await tx.insert(schema.episodeCharacters).values({ episodeId: task.episodeId, characterId, createdAt: ts })
      linkedCharacterIds.add(characterId)
    }
  }
  for (const propId of propIds) {
    const [prop] = await tx.select().from(schema.props)
      .where(and(eq(schema.props.id, propId), eq(schema.props.userId, task.userId)))
    if (!prop || prop.dramaId !== task.dramaId || prop.deletedAt) throw new Error(`prop_id ${propId} 不属于当前项目`)
    if (!linkedPropIds.has(propId)) {
      await tx.insert(schema.episodeProps).values({ episodeId: task.episodeId, propId, createdAt: ts })
      linkedPropIds.add(propId)
    }
  }
}

async function commitDraft(task: TaskRow) {
  const items = await getDraftItems(task.taskId)
  if (items.length !== task.targetShots) throw new Error(`分镜草稿不完整：需要 ${task.targetShots} 个，实际 ${items.length} 个`)
  const payloads = items.map(item => {
    let value: any
    try { value = JSON.parse(item.payload) } catch { throw new Error(`分镜 ${item.shotNumber} 草稿不是有效 JSON`) }
    if (value.shot_number !== item.shotNumber) throw new Error(`分镜编号 ${item.shotNumber} 不一致`)
    return value
  })
  if (payloads.some((value, index) => value.shot_number !== index + 1)) throw new Error('分镜编号必须从 1 开始连续且不能重复')

  const ts = now()
  await db.transaction(async (tx) => {
    await validateAndSyncEpisodeBindings(tx, task, payloads, ts)
    const existing = await tx.select({ id: schema.storyboards.id }).from(schema.storyboards)
      .where(and(eq(schema.storyboards.userId, task.userId), eq(schema.storyboards.episodeId, task.episodeId)))
    const ids = existing.map(row => row.id)
    if (ids.length) {
      await tx.delete(schema.storyboardCharacters).where(inArray(schema.storyboardCharacters.storyboardId, ids))
      await tx.delete(schema.storyboardProps).where(inArray(schema.storyboardProps.storyboardId, ids))
      await tx.delete(schema.storyboardAudios).where(inArray(schema.storyboardAudios.storyboardId, ids))
      await tx.delete(schema.storyboards).where(inArray(schema.storyboards.id, ids))
    }

    let totalDuration = 0
    for (const sb of payloads) {
      const result = await tx.insert(schema.storyboards).values({
        userId: task.userId,
        episodeId: task.episodeId,
        storyboardNumber: sb.shot_number,
        sceneId: sb.scene_id ?? null,
        description: sb.description,
        atmosphere: sb.atmosphere,
        duration: sb.duration,
        createdAt: ts,
        updatedAt: ts,
      })
      await syncRelations(tx, getInsertId(result), sb.character_ids || [], sb.prop_ids || [])
      totalDuration += sb.duration
    }
    await tx.update(schema.episodes).set({ duration: totalDuration, updatedAt: ts })
      .where(and(eq(schema.episodes.id, task.episodeId), eq(schema.episodes.userId, task.userId)))
    await tx.update(schema.storyboardBreakdownTasks).set({
      status: 'completed', stage: '保存分镜', completedBatches: task.totalBatches,
      currentBatch: null, error: null, finishedAt: ts, activeKey: null, updatedAt: ts,
    }).where(eq(schema.storyboardBreakdownTasks.taskId, task.taskId))
    await tx.delete(schema.storyboardBreakdownItems).where(eq(schema.storyboardBreakdownItems.taskId, task.taskId))
  })
}

async function runBatch(task: TaskRow, batchIndex: number, batchStart: number, batchEnd: number) {
  const agent = mastra.getAgent('storyboard_breaker')
  if (!agent) throw new Error('分镜拆分 Agent 不可用')
  const requestContext = buildAgentRequestContext({
    userId: task.userId,
    episodeId: task.episodeId,
    dramaId: task.dramaId,
    modelOverride: task.model || undefined,
    textConfigId: task.configId || undefined,
    storyboardTaskId: task.taskId,
    storyboardBatchIndex: batchIndex,
    storyboardTotalBatches: task.totalBatches,
    storyboardBatchStart: batchStart,
    storyboardBatchEnd: batchEnd,
    storyboardRetryCount: task.retryCount,
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS)
  let stepUpdates = Promise.resolve()
  let saveCalled = false
  let stepError: string | null = null
  try {
    const request = `${task.message}\n\n这是分批任务。整集目标共 ${task.targetShots} 个分镜。当前第 ${batchIndex}/${task.totalBatches} 批，只生成并保存分镜 ${batchStart}-${batchEnd}，共 ${batchEnd - batchStart + 1} 个。请按完整剧本中的相对位置规划当前区间，先读取上下文，再只调用一次 save_storyboards。不要重复其他批次，不要输出整集分镜。`
    logTaskProgress('StoryboardBreakdown', 'request', {
      taskId: task.taskId,
      episodeId: task.episodeId,
      batchIndex,
      model: task.model || undefined,
      retryCount: task.retryCount,
      requestChars: request.length,
      paramsChars: JSON.stringify({ batchIndex, batchStart, batchEnd, maxSteps: 6 }).length,
    })
    const result = await agent.generate([{
      role: 'user',
      content: request,
    }], {
      maxSteps: 6,
      requestContext,
      abortSignal: controller.signal,
      onStepFinish: (step: any) => {
        const names = (step?.toolCalls || []).map((tool: any) => tool?.toolName || tool?.payload?.toolName).filter(Boolean)
        const toolName = names[names.length - 1]
        if (names.some((name: string) => isToolName(name, 'save_storyboards', 'saveStoryboards'))) saveCalled = true
        stepError ||= (step?.toolResults || []).map(toolError).find(Boolean) || null
        const stage = isToolName(toolName, 'read_storyboard_context', 'readStoryboardContext') ? '分析剧本'
          : isToolName(toolName, 'save_storyboards', 'saveStoryboards') ? '保存分镜'
            : names.length ? '生成分镜' : '分析剧本'
        stepUpdates = stepUpdates.then(() => setBatchTask(task.taskId, batchIndex, task.retryCount, { stage }))
        logTaskProgress('StoryboardBreakdown', 'step', { taskId: task.taskId, episodeId: task.episodeId, batchIndex, tools: names.join(',') || undefined })
      },
    })
    await stepUpdates
    const error = stepError || (result?.toolResults || []).map(toolError).find(Boolean)
    if (error) throw new Error(error)
    saveCalled ||= (result?.toolCalls || []).some((tool: any) => {
      const name = tool?.toolName || tool?.payload?.toolName
      return isToolName(name, 'save_storyboards', 'saveStoryboards')
    })
    if (!saveCalled) throw new Error(`第 ${batchIndex} 批未执行保存分镜操作`)
    const saved = await getDraftItems(task.taskId)
    if (!isBatchComplete(saved, batchIndex, batchStart, batchEnd)) {
      throw new Error(`第 ${batchIndex} 批保存不完整，实际 ${saved.filter(item => item.batchIndex === batchIndex).length} 个`)
    }
  } finally {
    await stepUpdates
    clearTimeout(timeout)
  }
}

async function executeTask(taskId: string) {
  if (activeTasks.has(taskId)) return
  activeTasks.add(taskId)
  try {
    let task = await getTask(taskId)
    if (!task || ['completed', 'failed'].includes(task.status)) return
    await setTask(taskId, { status: 'running', stage: '读取剧本' })
    const draftItems = await getDraftItems(taskId)
    for (let batchIndex = 1; batchIndex <= task.totalBatches; batchIndex++) {
      const batchStart = (batchIndex - 1) * BATCH_SIZE + 1
      const batchEnd = Math.min(task.targetShots, batchIndex * BATCH_SIZE)
      if (isBatchComplete(draftItems, batchIndex, batchStart, batchEnd)) {
        await setTask(taskId, { completedBatches: batchIndex, currentBatch: batchIndex, retryCount: 0 })
        continue
      }
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        await setTask(taskId, { status: 'running', stage: '生成分镜', currentBatch: batchIndex, retryCount: attempt - 1, error: null })
        logTaskProgress('StoryboardBreakdown', 'batch-start', { taskId, episodeId: task.episodeId, batchIndex, totalBatches: task.totalBatches, attempt, batchStart, batchEnd })
        try {
          task = (await getTask(taskId)) || task
          await runBatch(task, batchIndex, batchStart, batchEnd)
          draftItems.splice(0, draftItems.length, ...(await getDraftItems(taskId)))
          await setTask(taskId, { completedBatches: batchIndex, currentBatch: null, retryCount: 0, error: null })
          logTaskSuccess('StoryboardBreakdown', 'batch-complete', { taskId, episodeId: task.episodeId, batchIndex, count: batchEnd - batchStart + 1 })
          break
        } catch (error: any) {
          const message = error?.name === 'AbortError' ? '模型调用超时' : (error?.message || '批次处理失败')
          await setTask(taskId, { retryCount: attempt, error: `第 ${batchIndex} 批：${message}` })
          logTaskError('StoryboardBreakdown', 'batch-failed', { taskId, episodeId: task.episodeId, batchIndex, attempt, error: message })
          if (attempt === MAX_RETRIES) throw new Error(`第 ${batchIndex} 批连续失败 ${MAX_RETRIES} 次：${message}`)
        }
      }
    }
    task = (await getTask(taskId)) || task
    // 进入最终提交后关闭批次写入口，避免超时请求的迟到保存覆盖提交快照。
    await setTask(taskId, { stage: '保存分镜', currentBatch: null })
    await commitDraft(task)
    logTaskSuccess('StoryboardBreakdown', 'complete', { taskId, episodeId: task.episodeId, count: task.targetShots })
  } catch (error: any) {
    const task = await getTask(taskId)
    // commitDraft 已在同一事务内将任务标记为 completed；此后的日志或清理异常不能把成功任务改成失败。
    if (task && task.status !== 'completed') {
      await setTask(taskId, { status: 'failed', finishedAt: now(), activeKey: null, error: error?.message || '分镜拆分失败' })
      logTaskError('StoryboardBreakdown', 'failed', { taskId, episodeId: task.episodeId, error: error?.message })
    }
  } finally {
    activeTasks.delete(taskId)
  }
}

export async function startStoryboardBreakdown(
  episodeId: number,
  dramaId: number,
  opts: { userId: number; message: string; model?: string; configId?: number },
): Promise<{ started: boolean; taskId?: string }> {
  const rows = await db.select().from(schema.storyboardBreakdownTasks)
    .where(and(eq(schema.storyboardBreakdownTasks.userId, opts.userId), eq(schema.storyboardBreakdownTasks.episodeId, episodeId)))
  const active = rows.find(row => row.status === 'queued' || row.status === 'running')
  if (active) return { started: false, taskId: active.taskId }

  const [episode] = await db.select({ script: schema.episodes.scriptContent, content: schema.episodes.content })
    .from(schema.episodes).where(and(eq(schema.episodes.id, episodeId), eq(schema.episodes.userId, opts.userId)))
  const script = episode?.script || episode?.content || ''
  if (!script.trim()) throw new Error('Episode has no script')
  const targetShots = Math.max(1, Math.ceil(script.length / 100))
  const totalBatches = Math.ceil(targetShots / BATCH_SIZE)
  const taskId = randomUUID()
  const activeKey = `${opts.userId}:${episodeId}`
  const timestamp = now()
  try {
    await db.insert(schema.storyboardBreakdownTasks).values({
    taskId, userId: opts.userId, dramaId, episodeId, message: opts.message,
    model: opts.model || null, configId: opts.configId || null, status: 'queued', stage: '读取剧本',
    totalBatches, completedBatches: 0, currentBatch: null, retryCount: 0, targetShots,
    error: null, startedAt: timestamp, updatedAt: timestamp, finishedAt: null, activeKey,
    })
  } catch (error: any) {
    if (error?.code !== 'ER_DUP_ENTRY' && error?.errno !== 1062) throw error
    const active = (await db.select().from(schema.storyboardBreakdownTasks)
      .where(and(eq(schema.storyboardBreakdownTasks.userId, opts.userId), eq(schema.storyboardBreakdownTasks.episodeId, episodeId))))
      .find(row => row.status === 'queued' || row.status === 'running')
    if (active) return { started: false, taskId: active.taskId }
    throw error
  }
  logTaskStart('StoryboardBreakdown', 'start', { taskId, episodeId, dramaId, model: opts.model, targetShots, totalBatches })
  void executeTask(taskId)
  return { started: true, taskId }
}

export async function recoverStoryboardBreakdownTasks() {
  const tasks = await db.select().from(schema.storyboardBreakdownTasks)
    .where(inArray(schema.storyboardBreakdownTasks.status, ['queued', 'running']))
  for (const task of tasks) void executeTask(task.taskId)
  if (tasks.length) logTaskProgress('StoryboardBreakdown', 'recovered', { count: tasks.length })
}

export async function getStoryboardBreakdownStatus(userId: number, episodeId: number) {
  const rows = await db.select().from(schema.storyboardBreakdownTasks)
    .where(and(eq(schema.storyboardBreakdownTasks.userId, userId), eq(schema.storyboardBreakdownTasks.episodeId, episodeId)))
  const row = rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  if (!row) return null
  const resultCount = row.status === 'completed'
    ? (await db.select({ id: schema.storyboards.id }).from(schema.storyboards).where(and(eq(schema.storyboards.userId, userId), eq(schema.storyboards.episodeId, episodeId)))).length
    : (await getDraftItems(row.taskId)).length
  return statusOf(row, resultCount)
}
