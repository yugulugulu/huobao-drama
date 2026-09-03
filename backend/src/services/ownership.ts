/**
 * 资源归属校验。
 * 路由必须使用这些函数读取按 ID 定位的资源，避免用户通过枚举自增 ID 越权访问。
 */
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

async function owned<T>(table: any, id: number, userId: number): Promise<T | null> {
  const [row] = await db.select().from(table).where(and(eq(table.id, id), eq(table.userId, userId)))
  return row as T | undefined || null
}

export const findOwnedDrama = (id: number, userId: number) => owned<typeof schema.dramas.$inferSelect>(schema.dramas, id, userId)
export const findOwnedEpisode = (id: number, userId: number) => owned<typeof schema.episodes.$inferSelect>(schema.episodes, id, userId)
export const findOwnedCharacter = (id: number, userId: number) => owned<typeof schema.characters.$inferSelect>(schema.characters, id, userId)
export const findOwnedScene = (id: number, userId: number) => owned<typeof schema.scenes.$inferSelect>(schema.scenes, id, userId)
export const findOwnedProp = (id: number, userId: number) => owned<typeof schema.props.$inferSelect>(schema.props, id, userId)
export const findOwnedAudio = (id: number, userId: number) => owned<typeof schema.audios.$inferSelect>(schema.audios, id, userId)
export const findOwnedStoryboard = (id: number, userId: number) => owned<typeof schema.storyboards.$inferSelect>(schema.storyboards, id, userId)
export const findOwnedTask = (id: number, userId: number) => owned<typeof schema.sysTask.$inferSelect>(schema.sysTask, id, userId)

/** 验证一个剧集与项目均属于同一用户，防止请求体拼接不同用户的 ID。 */
export async function verifyOwnedEpisodeInDrama(episodeId: number, dramaId: number, userId: number) {
  const episode = await findOwnedEpisode(episodeId, userId)
  if (!episode || episode.dramaId !== dramaId) return null
  return episode
}
