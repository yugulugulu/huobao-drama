import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('storyboard breakdown persists bounded, idempotent draft batches', () => {
  const tools = read('src/agents/tools/storyboard-tools.ts')
  const schema = read('src/db/schema.ts')
  const mysql = read('src/db/mysql-schema.ts')

  assert.match(tools, /z\.array\(z\.object\([\s\S]*?\)\.strict\(\)\)\.min\(1\)\.max\(10\)/)
  assert.match(tools, /duration: z\.number\(\)\.int\(\)\.min\(8\)\.max\(15\)/)
  assert.match(tools, /new Set\(shotNumbers\)\.size !== shotNumbers\.length/)
  assert.match(tools, /storyboardBreakdownItems\.taskId/)
  assert.match(tools, /\.for\('update'\)/)
  assert.match(tools, /retryCount, batch\.retryCount/)
  assert.match(tools, /validateStoryboardBindings\(tx, userId, episodeId, dramaId, sb\.scene_id, sb\.character_ids, sb\.prop_ids, false\)/)
  assert.match(schema, /pk: primaryKey\(\{ columns: \[table\.taskId, table\.shotNumber\] \}\)/)
  assert.match(mysql, /PRIMARY KEY \(task_id, shot_number\)/)
})

test('storyboard breakdown retries one batch and aborts timed-out model calls', () => {
  const service = read('src/services/storyboard-breakdown.ts')

  assert.match(service, /const MAX_RETRIES = 3/)
  assert.match(service, /new AbortController\(\)/)
  assert.match(service, /controller\.abort\(\)/)
  assert.match(service, /abortSignal: controller\.signal/)
  assert.match(service, /setBatchTask\(task\.taskId, batchIndex, task\.retryCount/)
  assert.match(service, /for \(let attempt = 1; attempt <= MAX_RETRIES; attempt\+\+\)/)
  assert.match(service, /isBatchComplete\(draftItems, batchIndex, batchStart, batchEnd\)/)
  assert.match(service, /第 \$\{batchIndex\} 批连续失败/)
})

test('formal storyboards are replaced only in the final transaction', () => {
  const service = read('src/services/storyboard-breakdown.ts')

  assert.match(service, /await commitDraft\(task\)/)
  assert.match(service, /stage: '保存分镜', currentBatch: null/)
  assert.match(service, /await db\.transaction\(async \(tx\) => \{[\s\S]*?delete\(schema\.storyboards\)/)
  assert.match(service, /validateAndSyncEpisodeBindings\(tx, task, payloads, ts\)/)
  assert.match(service, /duration: totalDuration, updatedAt: ts/)
  assert.match(service, /status: 'completed'/)
  assert.match(service, /activeKey: null/)
  assert.match(service, /storyboardBreakdownItems\.taskId/)
  assert.match(service, /task && task\.status !== 'completed'/)
})

test('one episode cannot have two active breakdown tasks', () => {
  const service = read('src/services/storyboard-breakdown.ts')
  const schema = read('src/db/schema.ts')
  const mysql = read('src/db/mysql-schema.ts')

  assert.match(service, /const activeKey = `\$\{opts\.userId\}:\$\{episodeId\}`/)
  assert.match(service, /error\?\.code !== 'ER_DUP_ENTRY'/)
  assert.match(service, /status === 'queued' \|\| row\.status === 'running'/)
  assert.match(schema, /activeKeyUnique: uniqueIndex\('uk_storyboard_breakdown_tasks_active'\)/)
  assert.match(mysql, /UNIQUE KEY uk_storyboard_breakdown_tasks_active \(active_key\)/)
})

test('startup resumes persisted storyboard breakdown tasks', () => {
  const index = read('src/index.ts')
  const service = read('src/services/storyboard-breakdown.ts')

  assert.match(index, /await recoverStoryboardBreakdownTasks\(\)/)
  assert.match(service, /where\(inArray\(schema\.storyboardBreakdownTasks\.status, \['queued', 'running'\]\)\)/)
  assert.match(service, /for \(const task of tasks\) void executeTask\(task\.taskId\)/)
})
