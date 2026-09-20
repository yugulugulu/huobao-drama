import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

test('users have roles and public registration cannot create administrators', () => {
  const schema = read('src/db/schema.ts')
  const mysql = read('src/db/mysql-schema.ts')
  const auth = read('src/routes/auth.ts')

  assert.match(schema, /role: varchar\('role', \{ length: 16 \}\)\.notNull\(\)\.default\('user'\)/)
  assert.match(mysql, /ADD COLUMN `role` VARCHAR\(16\) NOT NULL DEFAULT 'user'/)
  assert.match(auth, /role: 'user'/)
  assert.match(auth, /app\.post\('\/admin\/login'/)
  assert.match(auth, /user\.role !== 'admin'/)
})

test('admin user routes implement protected CRUD and account status changes', () => {
  const entry = read('src/index.ts')
  const routes = read('src/routes/adminUsers.ts')
  const middleware = read('src/middleware/auth.ts')

  assert.match(entry, /api\.use\('\/admin\/\*', adminRequired\)/)
  assert.match(entry, /api\.route\('\/admin\/users', adminUsers\)/)
  for (const route of ["app.get('/',", "app.get('/:id',", "app.post('/',", "app.put('/:id',", "app.delete('/:id',"]) {
    assert.ok(routes.includes(route), `missing ${route}`)
  }
  assert.match(middleware, /currentUser\(c\)\.role !== 'admin'/)
  assert.match(middleware, /!user \|\| !user\.isActive/)
})

test('admin operations protect the acting and final active administrator', () => {
  const routes = read('src/routes/adminUsers.ts')

  assert.match(routes, /不能取消自己的管理员角色/)
  assert.match(routes, /不能禁用自己的账号/)
  assert.match(routes, /不能删除自己的账号/)
  assert.match(routes, /系统必须至少保留一个启用的管理员/)
  assert.match(routes, /schema\.storyboardBreakdownTasks/)
  assert.match(routes, /schema\.episodeAudios/)
  assert.match(routes, /schema\.storyboardAudios/)
})

test('admin frontend is served independently and built into the production image', () => {
  const entry = read('src/index.ts')
  const dockerfile = read('../Dockerfile')
  const compose = read('../docker-compose.yml')

  assert.match(entry, /ADMIN_PORT \|\| 5680/)
  assert.match(entry, /admin-frontend', 'dist'/)
  assert.match(entry, /adminApp\.all\('\/api\/\*'/)
  assert.match(dockerfile, /FROM node:20-slim AS admin-frontend-build/)
  assert.match(dockerfile, /admin-frontend\/.output\/public/)
  assert.match(compose, /"5680:5680"/)
})
