/**
 * OpenAI-compatible video generation adapter for TokenBox-style endpoints.
 * Create: POST /v1/video/generations
 * Poll:   GET  /v1/video/generations/{taskId}
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

const DEFAULT_MODEL = 'doubao-seedance-2-0-260128'
const REF_LIMITS = { images: 9, videos: 3, audios: 3 } as const

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((url) => typeof url === 'string' && url.trim()) : []
  } catch {
    return []
  }
}

function extractError(result: any): string {
  const payload = result?.data?.data ?? result?.data ?? result
  const error = payload?.error ?? result?.data?.fail_reason ?? result?.error ?? result?.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = error.message || error.detail || JSON.stringify(error)
    return error.code ? `[${error.code}] ${message}` : message
  }
  return 'Video generation failed'
}

export class OpenAIVideoAdapter implements VideoProviderAdapter {
  provider = 'openai'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    const prompt = (record.prompt || '').trim()
    const refImages = parseUrlArray(record.referenceImageUrls)
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)

    if (refImages.length > REF_LIMITS.images || refVideos.length > REF_LIMITS.videos || refAudios.length > REF_LIMITS.audios) {
      throw new Error(`参考素材超限：图片≤${REF_LIMITS.images}、视频≤${REF_LIMITS.videos}、音频≤${REF_LIMITS.audios}`)
    }
    if (refAudios.length > 0 && refImages.length + refVideos.length === 0) {
      throw new Error('参考音频需要至少 1 个参考图片或视频')
    }
    if (!prompt && !refImages.length && !refVideos.length && !refAudios.length) {
      throw new Error('多模态参考模式需要至少一个参考素材或 prompt')
    }

    const content: any[] = []
    if (prompt) content.push({ type: 'text', text: prompt })
    for (const url of refImages) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of refVideos) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
    for (const url of refAudios) {
      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/video/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: {
        model,
        content,
        resolution: record.resolution === '480p' ? '480p' : '720p',
        ratio: record.aspectRatio || 'adaptive',
        duration: this.normalizeDuration(record.duration),
        generate_audio: record.generateAudio !== 0 && record.generateAudio !== false,
        watermark: false,
      },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const taskId = result?.id || result?.task_id || result?.data?.id || result?.data?.task_id
    if (taskId) return { isAsync: true, taskId: String(taskId) }

    const videoUrl = this.extractVideoUrl(result)
    if (videoUrl) return { isAsync: false, videoUrl }

    throw new Error('No id, task_id or video_url in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/video/generations/${encodeURIComponent(taskId)}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const payload = result?.data?.data ?? result?.data ?? result
    const status = String(payload?.status || '').toLowerCase()

    if (status === 'succeeded') {
      return {
        status: 'completed',
        videoUrl: this.extractVideoUrl(result) || undefined,
      }
    }
    if (status === 'failed') {
      return { status: 'failed', error: extractError(result) }
    }
    if (status === 'queued' || status === 'running') return { status: 'processing' }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    const payload = result?.data?.data ?? result?.data ?? result
    return payload?.content?.video_url
      || payload?.video_url
      || result?.content?.video_url
      || result?.data?.content?.video_url
      || result?.data?.video_url
      || result?.result?.video_url
      || result?.output?.video_url
      || null
  }

  private normalizeDuration(duration?: number | null): number {
    const parsed = Math.round(Number(duration || 5))
    if (!Number.isFinite(parsed)) return 5
    return Math.min(15, Math.max(4, parsed))
  }
}
