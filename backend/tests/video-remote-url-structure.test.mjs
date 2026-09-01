import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('completed generated videos are persisted through the unified storage layer', () => {
  const generation = read('src/services/generation.ts')

  assert.match(generation, /downloadFile\(videoUrl, record\.userId, 'videos'\)/)
  assert.match(generation, /extractVideoPoster\(localPath\)/)
  assert.match(generation, /resultUrl: localPath, localPath/)
  assert.match(generation, /\.set\(\{ videoUrl: localPath, duration:/)
  assert.doesNotMatch(generation, /resultUrl: videoUrl, localPath: null/)
  assert.doesNotMatch(generation, /\.set\(\{ videoUrl, duration:/)
})

test('frontend renders application-managed video references', () => {
  const episode = read('../frontend/app/views/drama/episode.vue')

  assert.match(episode, /function mediaSrc\(url\)/)
  assert.match(episode, /\^https\?:\\\/\\\//)
  assert.match(episode, /:src="mediaSrc\(getVideoUrl\(task\.storyboard\)\)"/)
  assert.match(episode, /:src="mediaSrc\(previewVideoUrl \|\| getVideoUrl\(selectedSb\)\)"/)
  assert.match(episode, /:src="mediaSrc\(taskVideoPath\(t\)\)"/)
})
