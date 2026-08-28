import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIVideoAdapter } from '../src/services/adapters/openai-video'

const adapter = new OpenAIVideoAdapter()
const config = {
  provider: 'openai',
  baseUrl: 'https://tokenbox.you/v1',
  apiKey: 'test-key',
  model: 'doubao-seedance-2-0-260128',
}

test('builds TokenBox create requests without duplicate v1 path', () => {
  const request = adapter.buildGenerateRequest(config, {
    id: 1,
    prompt: 'test prompt',
    referenceImageUrls: JSON.stringify(['https://example.com/image.jpg']),
    referenceVideoUrls: JSON.stringify(['https://example.com/video.mp4']),
    referenceAudioUrls: JSON.stringify(['https://example.com/audio.mp3']),
    resolution: '720p',
    aspectRatio: '16:9',
    duration: 5,
    generateAudio: true,
  })

  assert.equal(request.url, 'https://tokenbox.you/v1/video/generations')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
  assert.deepEqual(request.body, {
    model: 'doubao-seedance-2-0-260128',
    content: [
      { type: 'text', text: 'test prompt' },
      { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' }, role: 'reference_image' },
      { type: 'video_url', video_url: { url: 'https://example.com/video.mp4' }, role: 'reference_video' },
      { type: 'audio_url', audio_url: { url: 'https://example.com/audio.mp3' }, role: 'reference_audio' },
    ],
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    generate_audio: true,
    watermark: false,
  })

  const withoutVersion = adapter.buildGenerateRequest({ ...config, baseUrl: 'https://tokenbox.you' }, {
    id: 2,
    prompt: 'test',
  })
  assert.equal(withoutVersion.url, 'https://tokenbox.you/v1/video/generations')
})

test('parses task IDs, upstream polling states, errors, and common video URL fields', () => {
  assert.deepEqual(adapter.parseGenerateResponse({ id: 'task-1' }), { isAsync: true, taskId: 'task-1' })
  assert.deepEqual(adapter.parseGenerateResponse({ task_id: 23 }), { isAsync: true, taskId: '23' })
  assert.deepEqual(adapter.parseGenerateResponse({ output: { video_url: 'https://example.com/sync.mp4' } }), {
    isAsync: false,
    videoUrl: 'https://example.com/sync.mp4',
  })

  assert.equal(adapter.buildPollRequest(config, 'task/1').url, 'https://tokenbox.you/v1/video/generations/task%2F1')
  assert.deepEqual(adapter.parsePollResponse({ status: 'queued' }), { status: 'processing' })
  assert.deepEqual(adapter.parsePollResponse({ status: 'running' }), { status: 'processing' })
  assert.deepEqual(adapter.parsePollResponse({ status: 'succeeded', content: { video_url: 'https://example.com/content.mp4' } }), {
    status: 'completed',
    videoUrl: 'https://example.com/content.mp4',
  })
  assert.deepEqual(adapter.parsePollResponse({ status: 'failed', error: { code: 'invalid', message: 'bad request' } }), {
    status: 'failed',
    error: '[invalid] bad request',
  })
})

test('unwraps TokenBox task responses before parsing upstream status', () => {
  assert.deepEqual(adapter.parsePollResponse({
    code: 'success',
    data: {
      status: 'FAILURE',
      fail_reason: 'wrapped failure',
      data: {
        status: 'failed',
        error: { code: 'INPUT_IMAGE_SENSITIVE_CONTENT', message: '参考图片包含敏感内容' },
      },
    },
  }), {
    status: 'failed',
    error: '[INPUT_IMAGE_SENSITIVE_CONTENT] 参考图片包含敏感内容',
  })

  assert.deepEqual(adapter.parsePollResponse({
    code: 'success',
    data: {
      status: 'SUCCESS',
      data: {
        status: 'succeeded',
        content: { video_url: 'https://example.com/tokenbox.mp4' },
      },
    },
  }), {
    status: 'completed',
    videoUrl: 'https://example.com/tokenbox.mp4',
  })
})
