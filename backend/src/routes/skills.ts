/**
 * 技能管理路由。
 * workspace 中的技能是只读默认值，用户新增和修改的内容写入数据库私有表。
 */
import { Hono } from 'hono'
import { success, badRequest, now } from '../utils/response.js'
import { resolveSkillAgentType, skillsManagerWorkspace } from '../agents/skills.js'
import { currentUser } from '../middleware/auth.js'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

const app = new Hono()
const fsm = () => skillsManagerWorkspace.filesystem!
const skillFile = (id: string) => `skills/${id}/SKILL.md`
const SKILL_ID_SEGMENT = /^[a-z0-9-]+$/

function isValidSkillId(id: string) {
  const segments = id.split('/')
  return !!segments.length && segments.every(segment => SKILL_ID_SEGMENT.test(segment))
}

function parseSkillMeta(content: string, fallbackName: string) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const getValue = (key: string) => frontmatter?.[1]
    .match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim().replace(/^['"]|['"]$/g, '') || ''
  return {
    name: getValue('name') || fallbackName,
    description: getValue('description'),
  }
}

// GET /skills — List all skills (经 workspace.skills 原生发现)
app.get('/', async (c) => {
  const userId = currentUser(c).id
  const metas = await skillsManagerWorkspace.skills?.list() || []
  const privateSkills = await db.select().from(schema.userAgentSkills)
    .where(eq(schema.userAgentSkills.userId, userId))
  const privateById = new Map(privateSkills.map(skill => [skill.skillId, skill]))
  const items = metas.map(meta => {
    const id = meta.path.replace(/^skills\//, '')
    const privateSkill = privateById.get(id)
    privateById.delete(id)
    return {
      id,
      name: privateSkill?.name || meta.name,
      description: privateSkill?.description || meta.description || '',
      is_default: !privateSkill,
    }
  })
  for (const skill of privateById.values()) {
    items.push({
      id: skill.skillId,
      name: skill.name,
      description: skill.description || '',
      is_default: false,
    })
  }
  return success(c, items)
})

// GET /skills/:id — Get skill content (raw, 含 frontmatter 供编辑)
app.get('/*', async (c) => {
  const id = c.req.path.slice('/api/v1/skills/'.length)
  if (!isValidSkillId(id)) return badRequest(c, 'Invalid skill id')
  const userId = currentUser(c).id
  const [privateSkill] = await db.select().from(schema.userAgentSkills)
    .where(and(eq(schema.userAgentSkills.userId, userId), eq(schema.userAgentSkills.skillId, id)))
  if (privateSkill) return success(c, { id, content: privateSkill.content, is_default: false })
  if (!await fsm().exists(skillFile(id))) return badRequest(c, 'Skill not found')
  const content = await fsm().readFile(skillFile(id), { encoding: 'utf-8' })
  return success(c, { id, content, is_default: true })
})

// PUT /skills/:id — Update skill content
app.put('/*', async (c) => {
  const id = c.req.path.slice('/api/v1/skills/'.length)
  if (!isValidSkillId(id)) return badRequest(c, 'Invalid skill id')
  const agentType = resolveSkillAgentType(id)
  if (!agentType) return badRequest(c, 'Skill id 不属于有效 Agent 目录')
  const userId = currentUser(c).id
  const body = await c.req.json()
  const content = String(body.content || '').trim()
  if (!content) return badRequest(c, 'Skill content is required')
  const meta = parseSkillMeta(content, id.split('/').at(-1) || id)
  const ts = now()
  const [existing] = await db.select({ id: schema.userAgentSkills.id }).from(schema.userAgentSkills)
    .where(and(eq(schema.userAgentSkills.userId, userId), eq(schema.userAgentSkills.skillId, id)))
  if (existing) {
    await db.update(schema.userAgentSkills)
      .set({ agentType, name: meta.name, description: meta.description, content, updatedAt: ts })
      .where(and(eq(schema.userAgentSkills.id, existing.id), eq(schema.userAgentSkills.userId, userId)))
  } else {
    await db.insert(schema.userAgentSkills).values({
      userId,
      agentType,
      skillId: id,
      name: meta.name,
      description: meta.description,
      content,
      createdAt: ts,
      updatedAt: ts,
    })
  }
  return success(c)
})

// POST /skills — Create new skill directory
app.post('/', async (c) => {
  const body = await c.req.json()
  const { id, description } = body
  if (!id) return badRequest(c, 'Skill id is required')
  // Mastra 技能规范：frontmatter name 必须与目录名一致，且只允许小写字母/数字/连字符
  const skillId = String(id)
  const segments = skillId.split('/')
  if (!isValidSkillId(skillId)) {
    return badRequest(c, 'Skill id 每段只能包含小写字母、数字和连字符')
  }
  const agentType = resolveSkillAgentType(skillId)
  if (!agentType) return badRequest(c, 'Skill id 必须位于有效 Agent 目录下')
  const userId = currentUser(c).id
  const [existing] = await db.select({ id: schema.userAgentSkills.id }).from(schema.userAgentSkills)
    .where(and(eq(schema.userAgentSkills.userId, userId), eq(schema.userAgentSkills.skillId, skillId)))
  if (existing || await fsm().exists(skillFile(skillId))) return badRequest(c, 'Skill already exists')

  const name = segments[segments.length - 1]
  const content = `---
name: ${name}
description: ${description || ''}
---

# ${name}

Write your skill content here.
`
  const ts = now()
  await db.insert(schema.userAgentSkills).values({
    userId,
    agentType,
    skillId,
    name,
    description: description || '',
    content,
    createdAt: ts,
    updatedAt: ts,
  })
  return success(c, { id: skillId, name, description: description || '' })
})

// DELETE /skills/:id — Delete skill directory
app.delete('/*', async (c) => {
  const id = c.req.path.slice('/api/v1/skills/'.length)
  if (!isValidSkillId(id)) return badRequest(c, 'Invalid skill id')
  const userId = currentUser(c).id
  const [privateSkill] = await db.select({ id: schema.userAgentSkills.id }).from(schema.userAgentSkills)
    .where(and(eq(schema.userAgentSkills.userId, userId), eq(schema.userAgentSkills.skillId, id)))
  if (!privateSkill) {
    if (await fsm().exists(skillFile(id))) return badRequest(c, '默认 Skill 只读，不能删除')
    return badRequest(c, 'Skill not found')
  }
  await db.delete(schema.userAgentSkills)
    .where(and(eq(schema.userAgentSkills.id, privateSkill.id), eq(schema.userAgentSkills.userId, userId)))
  return success(c, { is_default: await fsm().exists(skillFile(id)) })
})

export default app
