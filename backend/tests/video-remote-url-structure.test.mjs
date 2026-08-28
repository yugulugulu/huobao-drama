import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('completed generated videos keep the upstream URL without persistent storage', () => {
  const generation = read('src/services/generation.ts')

  assert.doesNotMatch(generation, /downloadFile\(videoUrl/)
  assert.doesNotMatch(generation, /extractVideoPoster\(localPath\)/)
  assert.match(generation, /resultUrl: videoUrl, localPath: null/)
  assert.match(generation, /\.set\(\{ videoUrl, duration:/)
})

test('frontend renders upstream video URLs without adding a local path prefix', () => {
  const episode = read('../frontend/app/views/drama/episode.vue')

  assert.match(episode, /function mediaSrc\(url\)/)
  assert.match(episode, /\^https\?:\\\/\\\//)
  assert.match(episode, /:src="mediaSrc\(getVideoUrl\(task\.storyboard\)\)"/)
  assert.match(episode, /:src="mediaSrc\(previewVideoUrl \|\| getVideoUrl\(selectedSb\)\)"/)
  assert.match(episode, /:src="mediaSrc\(taskVideoPath\(t\)\)"/)
})
