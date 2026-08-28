import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('POST /episodes auto-locks configs when not provided', () => {
  const route = read('src/routes/episodes.ts')
  const ai = read('src/services/ai.ts')

  // 不再强制要求 config id
  assert.doesNotMatch(route, /image_config_id and video_config_id are required/)
  // 通过 getActiveConfigId 自动锁定
  assert.match(route, /getActiveConfigId\('image', userId\)/)
  assert.match(route, /getActiveConfigId\('video', userId\)/)
  // ai.ts 提供 getActiveConfigId
  assert.match(ai, /export async function getActiveConfigId/)
  // 图片配置仍是创建项目所需能力；视频配置允许为空，创建后再按需配置
  assert.match(route, /未找到启用的图片生成配置/)
  assert.doesNotMatch(route, /未找到启用的视频生成配置/)
  assert.match(route, /videoConfigId,/)
})

test('POST /episodes still honors explicit config ids when caller passes them', () => {
  const route = read('src/routes/episodes.ts')

  assert.match(route, /body\.image_config_id \?\? await getActiveConfigId\('image', userId\)/)
  assert.match(route, /body\.video_config_id \?\? await getActiveConfigId\('video', userId\)/)
})
