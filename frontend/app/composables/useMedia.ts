/**
 * 媒体地址辅助 — 列表/卡片用缩略图与海报帧，大图预览仍用原图
 *
 * 命名约定（后端生成产物时自动产出，见 backend/src/utils/storage.ts、video-poster.ts）：
 *   图片 static/images/x.png      → 缩略图 static/images/x_thumb.webp
 *   视频 static/videos|merged/x.mp4 → 海报帧 static/videos|merged/x_poster.jpg
 * 存量文件可用 `npm run backfill-artwork`（backend）补齐。
 */

/** 图片地址 → 缩略图地址；同时支持本地 static 路径和 OSS 公开 URL。 */
export function thumbOf(url: string): string {
  if (!url || !/\.(png|jpe?g|webp|gif)(?:\?.*)?$/i.test(url)) return url
  return url.replace(/\.[^./?]+(?=$|\?)/, '_thumb.webp')
}

/** 缩略图加载失败（老数据未回填）时回退原图 */
export function thumbFallback(e: Event, orig: string) {
  const el = e.target as HTMLImageElement
  if (!el || el.dataset.fbk || !orig) return
  el.dataset.fbk = '1'
  el.src = orig
}

/** 视频地址 → 海报帧地址；同时支持本地 static 路径和 OSS 公开 URL。 */
export function posterOf(url: string): string {
  if (!url || !/\.(mp4|webm|mov)(?:\?.*)?$/i.test(url)) return ''
  return url.replace(/\.[^./?]+(?=$|\?)/, '_poster.jpg')
}
