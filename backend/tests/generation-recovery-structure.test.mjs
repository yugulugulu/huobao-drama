import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('backend startup recovers persisted generation tasks before listening', () => {
  const index = read('src/index.ts')
  const generation = read('src/services/generation.ts')

  assert.match(index, /import \{ recoverProcessingGenerationTasks \} from '\.\/services\/generation\.js'/)
  assert.match(index, /await recoverProcessingGenerationTasks\(\)[\s\S]*serve\(\{ fetch: app\.fetch, port \}\)/)
  assert.match(generation, /where\(eq\(schema\.sysTask\.status, 'processing'\)\)/)
})

test('restart recovery fails synchronous tasks and resumes asynchronous polling', () => {
  const generation = read('src/services/generation.ts')
  const ai = read('src/services/ai.ts')

  assert.match(generation, /if \(!record\.taskId\)[\s\S]*RESTART_INTERRUPTED_ERROR/)
  assert.match(generation, /服务重启导致生成中断，请重新生成/)
  assert.match(generation, /getActiveConfigForProvider\(type, record\.userId, provider\)/)
  assert.match(generation, /pollTask\(record, config, record\.taskId\)/)
  assert.match(ai, /\(row\.provider \|\| ''\)\.toLowerCase\(\) === normalizedProvider/)
})
