/**
 * AI 服务抽象层 — 从数据库配置中获取 provider 和 API key
 */
import { db, schema } from '../db/index.js'
import { and, eq } from 'drizzle-orm'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { joinProviderUrl } from './adapters/url.js'

export type ServiceType = 'text' | 'image' | 'video'
export const TOKENBOX_BASE_URL = 'https://tokenbox.you'

export interface AIConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}

export const officialProviders: Record<ServiceType, readonly string[]> = {
  text: ['openai', 'gemini', 'deepseek', 'volcengine'],
  image: ['openai', 'gemini', 'volcengine'],
  video: ['openai', 'volcengine'],
}

export function isOfficialProvider(serviceType?: string | null, provider?: string | null): boolean {
  const normalizedServiceType = (serviceType || '').trim().toLowerCase() as ServiceType
  const normalizedProvider = (provider || '').trim().toLowerCase()
  const providers = officialProviders[normalizedServiceType]
  return !!providers && providers.includes(normalizedProvider)
}

export function getTextProviderBaseUrl(config: AIConfig) {
  const provider = config.provider.toLowerCase()

  if (provider === 'openai' || provider === 'deepseek') {
    return joinProviderUrl(config.baseUrl, '/v1', '')
  }

  if (provider === 'gemini') {
    return joinProviderUrl(config.baseUrl, '/v1beta', '')
  }

  if (provider === 'volcengine') {
    return joinProviderUrl(config.baseUrl, '/api/v3', '')
  }

  return config.baseUrl
}

// Agent 多步循环会逐步重复解析同一配置，相同配置只打一次日志避免刷屏
const lastLoggedActiveConfigKey = new Map<string, string>()
const lastLoggedConfigByIdKey = new Map<number, string>()

export async function getActiveConfig(serviceType: ServiceType, userId: number): Promise<AIConfig | null> {
  const rows = (await db.select().from(schema.aiServiceConfigs)
    .where(and(eq(schema.aiServiceConfigs.userId, userId), eq(schema.aiServiceConfigs.serviceType, serviceType)))
  )
    .filter(r => r.isActive && isOfficialProvider(serviceType, r.provider))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0)) // 高优先级优先

  const active = rows[0]
  if (!active) {
    logTaskWarn('AIConfig', 'active-config-missing', { serviceType })
    return null
  }

  const models = active.model ? JSON.parse(active.model) : []
  const logKey = `${active.id}:${models[0] || ''}`
  const cacheKey = `${userId}:${serviceType}`
  if (lastLoggedActiveConfigKey.get(cacheKey) !== logKey) {
    lastLoggedActiveConfigKey.set(cacheKey, logKey)
    logTaskProgress('AIConfig', 'active-config-selected', {
      serviceType,
      configId: active.id,
      provider: active.provider,
      model: models[0] || '',
      priority: active.priority,
    })
  }
  return {
    provider: active.provider || '',
    baseUrl: TOKENBOX_BASE_URL,
    apiKey: active.apiKey,
    model: models[0] || '',
  }
}

/** 重启恢复异步任务时，必须沿用任务创建时记录的 provider。 */
export async function getActiveConfigForProvider(
  serviceType: ServiceType,
  userId: number,
  provider: string,
): Promise<AIConfig | null> {
  const normalizedProvider = provider.toLowerCase()
  const rows = (await db.select().from(schema.aiServiceConfigs)
    .where(and(eq(schema.aiServiceConfigs.userId, userId), eq(schema.aiServiceConfigs.serviceType, serviceType)))
  )
    .filter(row => row.isActive && (row.provider || '').toLowerCase() === normalizedProvider)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))

  const active = rows[0]
  if (!active || !isOfficialProvider(serviceType, active.provider)) return null

  const models = active.model ? JSON.parse(active.model) : []
  return {
    provider: active.provider || '',
    baseUrl: TOKENBOX_BASE_URL,
    apiKey: active.apiKey,
    model: models[0] || '',
  }
}

export async function getTextConfig(userId: number): Promise<AIConfig> {
  const config = await getActiveConfig('text', userId)
  if (!config) throw new Error('未配置文本模型，请先到「设置」页添加并启用 AI 服务')
  return config
}

/**
 * 取某服务类型当前启用且优先级最高的官方配置 ID（创建集时自动锁定用）
 */
export async function getActiveConfigId(serviceType: ServiceType, userId: number): Promise<number | null> {
  const rows = (await db.select().from(schema.aiServiceConfigs)
    .where(and(eq(schema.aiServiceConfigs.userId, userId), eq(schema.aiServiceConfigs.serviceType, serviceType)))
  )
    .filter(r => r.isActive && isOfficialProvider(serviceType, r.provider))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
  return rows[0]?.id ?? null
}

export async function getConfigById(id: number, userId: number): Promise<AIConfig | null> {
  const [row] = await db.select().from(schema.aiServiceConfigs)
    .where(and(eq(schema.aiServiceConfigs.id, id), eq(schema.aiServiceConfigs.userId, userId)))
  if (!row || !row.isActive) {
    logTaskWarn('AIConfig', 'config-by-id-missing', { configId: id })
    return null
  }
  if (!isOfficialProvider(row.serviceType as ServiceType, row.provider)) {
    logTaskWarn('AIConfig', 'config-by-id-unsupported-provider', {
      configId: id,
      serviceType: row.serviceType,
      provider: row.provider,
    })
    return null
  }
  const models = row.model ? JSON.parse(row.model) : []
  const logKey = `${row.provider}:${models[0] || ''}:${row.serviceType}`
  if (lastLoggedConfigByIdKey.get(id) !== logKey) {
    lastLoggedConfigByIdKey.set(id, logKey)
    logTaskProgress('AIConfig', 'config-by-id-selected', {
      configId: id,
      provider: row.provider,
      model: models[0] || '',
      serviceType: row.serviceType,
    })
  }
  return {
    provider: row.provider || '',
    baseUrl: TOKENBOX_BASE_URL,
    apiKey: row.apiKey,
    model: models[0] || '',
  }
}
