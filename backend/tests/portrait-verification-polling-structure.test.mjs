import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const generation = await readFile(new URL('../src/services/generation.ts', import.meta.url), 'utf8')
const schema = await readFile(new URL('../src/db/schema.ts', import.meta.url), 'utf8')
const mysqlSchema = await readFile(new URL('../src/db/mysql-schema.ts', import.meta.url), 'utf8')

test('HTTP 428 responses are parsed and persisted as a terminal verification state', () => {
  assert.match(generation, /if \(!resp\.ok && resp\.status !== 428\) continue/)
  assert.match(generation, /parsePollResponse\(result, \{ httpStatus: resp\.status \}\)/)
  assert.match(generation, /pollResp\.status === 'portrait_verification_required'/)
  assert.match(generation, /await requirePortraitVerification\(record\.id, record\.userId, pollResp\)/)
  assert.match(generation, /status: 'portrait_verification_required'/)
})

test('verification fields are present in both Drizzle and bootstrap/backfill schemas', () => {
  for (const field of ['errorCode', 'verificationId', 'verificationUrl', 'providerError']) {
    assert.match(schema, new RegExp(`${field}:`))
  }
  for (const column of ['error_code', 'verification_id', 'verification_url', 'provider_error']) {
    assert.match(mysqlSchema, new RegExp(column))
  }
})
