/** 分镜拆分任务：异步执行 Agent，并为前端提供可恢复的进度状态。 */
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export type StoryboardBreakdownStage = '读取剧本' | '分析剧本' | '生成分镜' | '保存分镜'
export interface StoryboardBreakdownStatus {
  status: 'queued' | 'running' | 'completed' | 'failed'
  stage: StoryboardBreakdownStage
  started_at: string
  updated_at: string
  finished_at?: string
  error?: string
  result_count: number
}

const TASK_TIMEOUT_MS = 5 * 60 * 1000
const tasks = new Map<string, StoryboardBreakdownStatus>()
const keyOf = (userId: number, episodeId: number) => `${userId}:${episodeId}`

function toolError(tool: any): string | null {
  const raw = tool?.result ?? tool?.output ?? tool?.data
  const value = typeof raw === 'string' ? (() => {
    try { return JSON.parse(raw) } catch { return null }
  })() : raw
  return value && typeof value === 'object' && value.error ? String(value.error) : null
}

function isToolName(name: unknown, ...candidates: string[]) {
  return typeof name === 'string' && candidates.includes(name)
}

function setStatus(task: StoryboardBreakdownStatus, patch: Partial<StoryboardBreakdownStatus>) {
  Object.assign(task, patch, { updated_at: new Date().toISOString() })
}

export function startStoryboardBreakdown(
  episodeId: number,
  dramaId: number,
  opts: { userId: number; message: string; model?: string; configId?: number },
): boolean {
  const key = keyOf(opts.userId, episodeId)
  const existing = tasks.get(key)
  if (existing && (existing.status === 'queued' || existing.status === 'running')) return false

  const timestamp = new Date().toISOString()
  const task: StoryboardBreakdownStatus = {
    status: 'queued', stage: '读取剧本', started_at: timestamp, updated_at: timestamp, result_count: 0,
  }
  tasks.set(key, task)
  logTaskStart('StoryboardBreakdown', 'start', { episodeId, dramaId, model: opts.model, configId: opts.configId })

  void (async () => {
    const agent = mastra.getAgent('storyboard_breaker')
    if (!agent) throw new Error('分镜拆分 Agent 不可用')
    const context = buildAgentRequestContext({
      userId: opts.userId, episodeId, dramaId,
      modelOverride: opts.model, textConfigId: opts.configId,
    })
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('分镜拆分超时，请检查模型配置或重试')), TASK_TIMEOUT_MS)
    })
    setStatus(task, { status: 'running', stage: '读取剧本' })
    const result = await Promise.race([
      agent.generate([{ role: 'user', content: opts.message }], {
        maxSteps: 20,
        requestContext: context,
        onStepFinish: (step: any) => {
          const names = (step?.toolCalls || []).map((tool: any) => tool?.toolName || tool?.payload?.toolName).filter(Boolean)
          const toolName = names[names.length - 1]
          const stage = isToolName(toolName, 'read_storyboard_context', 'readStoryboardContext') ? '分析剧本'
            : isToolName(toolName, 'save_storyboards', 'saveStoryboards') ? '保存分镜'
              : names.length ? '生成分镜' : task.stage
          setStatus(task, { stage })
          logTaskProgress('StoryboardBreakdown', 'step', { episodeId, stage, tools: names.join(',') || undefined, text: (step?.text || '').slice(0, 200) || undefined })
        },
      }),
      timeout,
    ])
    const toolCalls = result?.toolCalls || []
    const toolResults = result?.toolResults || []
    const failedTool = toolResults.map((tool: any) => toolError(tool)).find(Boolean)
    if (failedTool) {
      throw new Error(failedTool)
    }
    const saveCalled = toolCalls.some((tool: any) => {
      const name = tool?.toolName || tool?.payload?.toolName
      return isToolName(name, 'save_storyboards', 'saveStoryboards')
    })
    if (!saveCalled) throw new Error('分镜拆分未执行保存分镜操作，模型可能未返回有效结果')

    const rows = await db.select({ id: schema.storyboards.id })
      .from(schema.storyboards)
      .where(and(eq(schema.storyboards.userId, opts.userId), eq(schema.storyboards.episodeId, episodeId)))
    if (!rows.length) throw new Error('分镜拆分完成但未生成任何分镜')
    setStatus(task, { status: 'completed', stage: '保存分镜', result_count: rows.length, finished_at: new Date().toISOString() })
    logTaskSuccess('StoryboardBreakdown', 'complete', { episodeId, count: rows.length })
  })().catch((err: any) => {
    setStatus(task, { status: 'failed', finished_at: new Date().toISOString(), error: err?.message || '分镜拆分失败' })
    logTaskError('StoryboardBreakdown', 'failed', { episodeId, error: err?.message })
  })
  return true
}

export function getStoryboardBreakdownStatus(userId: number, episodeId: number) {
  return tasks.get(keyOf(userId, episodeId)) || null
}
