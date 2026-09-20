import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const page = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')

test('video polling stops and records portrait verification as a dedicated terminal state', () => {
  assert.match(page, /res\?\.status === 'portrait_verification_required'/)
  assert.match(page, /pendingVideoIds\.value = pendingVideoIds\.value\.filter\(item => item !== storyboardId\)/)
  assert.match(page, /portraitVerificationTasks\.value = \{/)
  assert.match(page, /openPortraitVerification\(verification, storyboardId\)/)
})

test('portrait verification exposes a persistent link without automatic retry', () => {
  assert.match(page, /素材涉及真人隐私，需要进行真人认证。/)
  assert.match(page, />\s*前往认证\s*</)
  assert.match(page, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/)

  const goToVerification = page.slice(
    page.indexOf('function goToPortraitVerification'),
    page.indexOf('function configLabel'),
  )
  assert.doesNotMatch(goToVerification, /genVid\(/)
})

test('verification state is restored from the latest video task after refresh', () => {
  assert.match(page, /function syncPortraitVerificationTasks\(\)/)
  assert.match(page, /task\.status !== 'portrait_verification_required'/)
  assert.match(page, /syncPortraitVerificationTasks\(\)/)
  assert.match(page, /if \(state === 'verification'\) return '待认证'/)
})
