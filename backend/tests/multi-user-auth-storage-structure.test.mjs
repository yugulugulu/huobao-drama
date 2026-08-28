import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('JWT authentication is global for business APIs and expires after one day', () => {
  const entry = read('src/index.ts')
  const auth = read('src/middleware/auth.ts')
  const routes = read('src/routes/auth.ts')

  assert.match(entry, /api\.route\('\/auth', auth\)[\s\S]*api\.use\('\*', authRequired\)/)
  assert.match(auth, /const JWT_TTL_SECONDS = 24 \* 60 \* 60/)
  assert.match(auth, /HttpOnly; SameSite=Lax; Max-Age=\$\{JWT_TTL_SECONDS\}/)
  assert.match(auth, /verify\(token, jwtSecret\(\), JWT_ALGORITHM\)/)
  assert.match(routes, /bcrypt\.hash\(password, 12\)/)
  assert.match(routes, /app\.post\('\/register'/)
  assert.match(routes, /app\.post\('\/login'/)
})

test('private business tables and routes derive ownership from authenticated user', () => {
  const schema = read('src/db/schema.ts')
  const dramas = read('src/routes/dramas.ts')
  const configs = read('src/routes/aiConfigs.ts')
  const presets = read('src/routes/stylePresets.ts')
  const prompts = read('src/routes/prompts.ts')
  const skills = read('src/routes/skills.ts')

  for (const table of ['dramas', 'episodes', 'characters', 'scenes', 'storyboards', 'props', 'sysTask', 'videoMerges', 'assets', 'aiServiceConfigs', 'stylePresets']) {
    assert.match(schema, new RegExp(`export const ${table} = mysqlTable\\([\\s\\S]*?userId: int\\('user_id'\\)\\.notNull\\(\\)`))
  }
  for (const source of [dramas, configs, presets, prompts, skills]) {
    assert.match(source, /currentUser\(c\)\.id/)
    assert.match(source, /userId/)
  }
})

test('storage switches by environment and prefixes every new object with user id', () => {
  const env = read('src/config/env.ts')
  const storage = read('src/utils/storage.ts')
  const entry = read('src/index.ts')

  assert.match(env, /\.env\.\$\{appEnv\}/)
  assert.match(env, /appEnv === 'production' \? 'oss' : 'local'/)
  assert.match(env, /path\.resolve\(backendRoot, process\.env\.STORAGE_PATH/)
  assert.match(storage, /`users\/\$\{userId\}\/\$\{normalizeSubDir\(subDir\)\}/)
  assert.match(storage, /getOssClient\(\)\.put/)
  assert.match(entry, /storageDriver === 'local'/)
  assert.match(entry, /root: localStorageRoot/)
})

test('legacy schema migration backfills ownership and later-added prompt columns', () => {
  const mysql = read('src/db/mysql-schema.ts')
  const db = read('src/db/index.ts')

  assert.match(mysql, /table: 'characters', column: 'final_prompt'/)
  assert.match(mysql, /table: 'scenes', column: 'final_prompt'/)
  assert.match(mysql, /table: 'props', column: 'final_prompt'/)
  assert.match(db, /SET user_id = \? WHERE user_id IS NULL/)
  assert.match(db, /MODIFY COLUMN user_id INT NOT NULL/)
})
