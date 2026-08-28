/**
 * Agent prompt 管理路由 — 读写 workspace/prompts/<agent_type>.md
 * 文件操作 jail 在 backend/workspace/ 目录内（仿 skills 路由）
 */
import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { validAgentTypes, DEFAULT_PROMPTS } from '../agents/index.js'
import { loadAgentPromptFile } from '../agents/prompts.js'
import { currentUser } from '../middleware/auth.js'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

const app = new Hono()
const checkType = (type: string) => validAgentTypes.includes(type)

// GET /prompts — 列出全部 Agent 的 prompt 状态
app.get('/', async (c) => {
  const userId = currentUser(c).id
  const list = await Promise.all(validAgentTypes.map(async (type) => {
    const [privateConfig] = await db.select({ id: schema.userAgentConfigs.id }).from(schema.userAgentConfigs)
      .where(and(eq(schema.userAgentConfigs.userId, userId), eq(schema.userAgentConfigs.agentType, type)))
    const file = await loadAgentPromptFile(userId, type)
    return {
      agent_type: type,
      name: file?.name || DEFAULT_PROMPTS[type].name,
      model: file?.model || '',
      is_default: !privateConfig,
    }
  }))
  return success(c, list)
})

// GET /prompts/:type — 有效内容（文件优先，缺失回退代码默认）
app.get('/:type', async (c) => {
  const type = c.req.param('type')
  if (!checkType(type)) return badRequest(c, 'Unknown agent type')
  const userId = currentUser(c).id
  const [privateConfig] = await db.select({ id: schema.userAgentConfigs.id }).from(schema.userAgentConfigs)
    .where(and(eq(schema.userAgentConfigs.userId, userId), eq(schema.userAgentConfigs.agentType, type)))
  const file = await loadAgentPromptFile(userId, type)
  if (file && privateConfig) {
    return success(c, {
      agent_type: type,
      name: file.name || DEFAULT_PROMPTS[type].name,
      model: file.model,
      system_prompt: file.instructions,
      is_default: false,
    })
  }
  return success(c, {
    agent_type: type,
    name: file?.name || DEFAULT_PROMPTS[type].name,
    model: file?.model || '',
    system_prompt: file?.instructions || DEFAULT_PROMPTS[type].instructions,
    is_default: true,
  })
})

// PUT /prompts/:type — 保存为 prompt 文件
app.put('/:type', async (c) => {
  const type = c.req.param('type')
  if (!checkType(type)) return badRequest(c, 'Unknown agent type')
  const userId = currentUser(c).id
  const body = await c.req.json()
  const instructions = String(body.system_prompt ?? '').trim()
  if (!instructions) return badRequest(c, 'system_prompt required')
  const name = String(body.name || DEFAULT_PROMPTS[type].name)
  const model = String(body.model ?? '').trim()
  const ts = now()
  const [existing] = await db.select({ id: schema.userAgentConfigs.id }).from(schema.userAgentConfigs)
    .where(and(eq(schema.userAgentConfigs.userId, userId), eq(schema.userAgentConfigs.agentType, type)))
  if (existing) {
    await db.update(schema.userAgentConfigs)
      .set({ model, systemPrompt: instructions, updatedAt: ts })
      .where(and(eq(schema.userAgentConfigs.id, existing.id), eq(schema.userAgentConfigs.userId, userId)))
  } else {
    await db.insert(schema.userAgentConfigs).values({
      userId,
      agentType: type,
      model,
      systemPrompt: instructions,
      createdAt: ts,
      updatedAt: ts,
    })
  }
  return success(c, { agent_type: type, name, model, is_default: false })
})

// POST /prompts/:type/reset — 删除文件，回退代码默认值
app.post('/:type/reset', async (c) => {
  const type = c.req.param('type')
  if (!checkType(type)) return badRequest(c, 'Unknown agent type')
  const userId = currentUser(c).id
  await db.delete(schema.userAgentConfigs)
    .where(and(eq(schema.userAgentConfigs.userId, userId), eq(schema.userAgentConfigs.agentType, type)))
  return success(c, { agent_type: type, is_default: true })
})

export default app
