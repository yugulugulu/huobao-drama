import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../../frontend/app/composables/useApi.ts'

test('API responses preserve JSON errors and explain empty or invalid responses', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch')
  for (const [body, status] of [['', 500], ['<html>Bad Gateway</html>', 502], ['', 200], ['null', 200]]) {
    fetch.mock.mockImplementation(async () => new Response(body, { status }))
    await assert.rejects(api.post('/auth/login', {}), new RegExp(`HTTP ${status}`))
  }

  fetch.mock.mockImplementation(async () => Response.json({ code: 401, message: 'Invalid credentials' }, { status: 401 }))
  await assert.rejects(api.post('/auth/login', {}), /Invalid credentials/)

  fetch.mock.mockImplementation(async () => Response.json({ code: 200, data: { user: { id: 1 } } }))
  assert.deepEqual(await api.post('/auth/login', {}), { user: { id: 1 } })

  fetch.mock.mockImplementation(async () => Response.json({
    code: 'PORTRAIT_VERIFICATION_REQUIRED', verificationUrl: 'https://example.com/verify',
  }, { status: 400 }))
  await assert.rejects(api.post('/tasks', {}), error =>
    error.code === 'PORTRAIT_VERIFICATION_REQUIRED' && error.verificationUrl === 'https://example.com/verify')
})
