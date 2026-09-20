import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

test('admin login uses the shared cookie-backed authentication API', () => {
  const api = read('app/composables/useAdminApi.ts')
  const auth = read('app/composables/useAdminAuth.ts')
  const middleware = read('app/middleware/auth.global.ts')

  assert.match(api, /credentials: 'include'/)
  assert.match(api, /'POST', '\/auth\/admin\/login'/)
  assert.match(auth, /result\.user\.role === 'admin'/)
  assert.match(middleware, /navigateTo\('\/login'\)/)
})

test('user management supports search, filters, pagination, CRUD and disable', () => {
  const page = read('app/pages/index.vue')
  const api = read('app/composables/useAdminApi.ts')

  assert.match(page, /搜索显示名或邮箱/)
  assert.match(page, /全部角色/)
  assert.match(page, /全部状态/)
  assert.match(page, /pageCount/)
  assert.match(page, /adminApi\.createUser/)
  assert.match(page, /adminApi\.updateUser/)
  assert.match(page, /adminApi\.deleteUser/)
  assert.match(page, /is_active: !user\.is_active/)
  assert.match(api, /\/admin\/users/)
})

test('admin UI includes responsive workspace, table and dialogs', () => {
  const css = read('app/assets/admin.css')
  const editor = read('app/components/UserEditor.vue')
  const confirm = read('app/components/ConfirmDialog.vue')

  assert.match(css, /\.admin-shell/)
  assert.match(css, /\.table-region/)
  assert.match(css, /@media \(max-width: 680px\)/)
  assert.match(css, /prefers-reduced-motion/)
  assert.match(editor, /编辑用户/)
  assert.match(editor, /重置密码/)
  assert.match(confirm, /确认删除/)
})
