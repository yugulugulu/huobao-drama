/** 用户首次注册时创建的私有默认数据。 */
import { db, schema } from '../db/index.js'
import { stylePresetSeeds } from '../db/mysql-schema.js'
import { now } from '../utils/response.js'

/**
 * 为新用户复制默认风格预设。
 * 每个用户拥有自己的记录，之后编辑或删除不会影响其他账号。
 */
export async function ensureUserStylePresets(userId: number) {
  const ts = now()
  await db.insert(schema.stylePresets).values(stylePresetSeeds.map(seed => ({
    userId,
    name: seed.name,
    value: seed.value,
    prompt: seed.prompt,
    description: seed.description,
    sortOrder: seed.sortOrder,
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }))).onDuplicateKeyUpdate({ set: { updatedAt: ts } })
}
