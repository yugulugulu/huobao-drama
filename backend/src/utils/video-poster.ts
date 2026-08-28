/**
 * 视频海报帧提取 — 供 <video poster> 使用，避免列表页为显示首帧而缓冲整个视频
 */
import path from 'path'
import fs from 'fs'
import os from 'os'
import { materializeStorageFile, saveDerivedBuffer } from './storage.js'
import { ffmpeg, checkFfmpegSuite } from './ffmpeg.js'

/** 由视频相对路径推导海报帧路径：static/videos/x.mp4 → static/videos/x_poster.jpg */
export function posterPathFor(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '_poster.jpg')
}

/**
 * 抽取视频 0.5s 处画面作为海报帧（宽 640，等比缩放，与原视频同目录）。
 * 失败返回 null，不阻断主流程。
 */
export async function extractVideoPoster(relativePath: string): Promise<string | null> {
  let cleanupSource = () => {}
  let tempDir = ''
  try {
    // ffmpeg 二进制损坏（跨平台拷贝 node_modules / 下载不完整）时静默跳过，
    // 避免 fluent-ffmpeg 延迟回调里的同步 EFTYPE 崩掉整个进程
    const { ffmpeg: ffmpegOk } = await checkFfmpegSuite()
    if (!ffmpegOk) return null

    const posterRel = posterPathFor(relativePath)
    const source = await materializeStorageFile(relativePath)
    cleanupSource = source.cleanup
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-poster-'))
    const posterAbs = path.join(tempDir, 'poster.jpg')
    await new Promise<void>((resolve, reject) => {
      ffmpeg(source.path)
        .screenshots({
          timestamps: ['0.5'],
          filename: path.basename(posterAbs),
          folder: path.dirname(posterAbs),
          size: '640x?',
        })
        .on('end', () => resolve())
        .on('error', reject)
    })
    return await saveDerivedBuffer(posterRel, fs.readFileSync(posterAbs))
  } catch (err) {
    console.warn(`[video-poster] 海报帧提取失败 ${relativePath}:`, (err as Error).message)
    return null
  } finally {
    cleanupSource()
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
