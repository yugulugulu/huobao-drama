/**
 * Agent 请求上下文 — 通过 Mastra RequestContext 按请求注入
 * 路由层 build → generate({ requestContext }) → 工具 execute 内读取
 */
import { RequestContext } from '@mastra/core/request-context'

export interface AgentRequestContextValues {
  userId: number
  episodeId: number
  dramaId: number
  modelOverride?: string
  textConfigId?: number
  storyboardTaskId?: string
  storyboardBatchIndex?: number
  storyboardTotalBatches?: number
  storyboardBatchStart?: number
  storyboardBatchEnd?: number
  storyboardRetryCount?: number
}

export function buildAgentRequestContext(values: AgentRequestContextValues): RequestContext<AgentRequestContextValues> {
  const rc = new RequestContext<AgentRequestContextValues>()
  rc.set('userId', values.userId)
  rc.set('episodeId', values.episodeId)
  rc.set('dramaId', values.dramaId)
  if (values.modelOverride) rc.set('modelOverride', values.modelOverride)
  if (values.textConfigId) rc.set('textConfigId', values.textConfigId)
  if (values.storyboardTaskId) rc.set('storyboardTaskId', values.storyboardTaskId)
  if (values.storyboardBatchIndex != null) rc.set('storyboardBatchIndex', values.storyboardBatchIndex)
  if (values.storyboardTotalBatches != null) rc.set('storyboardTotalBatches', values.storyboardTotalBatches)
  if (values.storyboardBatchStart != null) rc.set('storyboardBatchStart', values.storyboardBatchStart)
  if (values.storyboardBatchEnd != null) rc.set('storyboardBatchEnd', values.storyboardBatchEnd)
  if (values.storyboardRetryCount != null) rc.set('storyboardRetryCount', values.storyboardRetryCount)
  return rc
}

/** Agent 工具只能从服务端写入的上下文读取用户 ID。 */
export function getUserId(requestContext: RequestContext | undefined): number | null {
  const v = requestContext?.get('userId' as never)
  return typeof v === 'number' ? v : null
}

export function getEpisodeId(requestContext: RequestContext | undefined): number | null {
  const v = requestContext?.get('episodeId' as never)
  return typeof v === 'number' ? v : null
}

export function getDramaId(requestContext: RequestContext | undefined): number | null {
  const v = requestContext?.get('dramaId' as never)
  return typeof v === 'number' ? v : null
}

export function getStoryboardTaskId(requestContext: RequestContext | undefined): string | null {
  const v = requestContext?.get('storyboardTaskId' as never)
  return typeof v === 'string' && v ? v : null
}

export interface StoryboardBatchContext {
  batchIndex: number
  totalBatches: number
  batchStart: number
  batchEnd: number
  retryCount: number
}

export function getStoryboardBatch(requestContext: RequestContext | undefined): StoryboardBatchContext | null {
  const value = (key: string) => requestContext?.get(key as never)
  const batchIndex = value('storyboardBatchIndex')
  const totalBatches = value('storyboardTotalBatches')
  const batchStart = value('storyboardBatchStart')
  const batchEnd = value('storyboardBatchEnd')
  const retryCount = value('storyboardRetryCount')
  if (typeof batchIndex !== 'number' || typeof totalBatches !== 'number' || typeof batchStart !== 'number' || typeof batchEnd !== 'number' || typeof retryCount !== 'number') return null
  return { batchIndex, totalBatches, batchStart, batchEnd, retryCount }
}
