/**
 * 统一文件存储工具。
 * 存储驱动由当前环境文件决定；所有新文件均使用 users/{userId}/...
 * 作为对象前缀，从物理路径层面隔离用户资源。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import OSS from 'ali-oss'
import sharp from 'sharp'
import { v4 as uuid } from 'uuid'
import { localStorageRoot, storageDriver } from '../config/env.js'

const OSS_PUBLIC_BASE_URL = (process.env.OSS_PUBLIC_BASE_URL || '').replace(/\/+$/, '')

let ossClient: OSS | null = null

function getOssClient(): OSS {
  if (!ossClient) {
    ossClient = new OSS({
      region: process.env.OSS_REGION!,
      bucket: process.env.OSS_BUCKET!,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID!,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET!,
    })
  }
  return ossClient
}

function normalizeSubDir(subDir: string): string {
  return subDir.replace(/^\/+|\/+$/g, '').replace(/\.\./g, '')
}

function buildObjectKey(userId: number, subDir: string, originalName: string): string {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('无效的存储用户 ID')
  const ext = path.extname(originalName) || '.bin'
  return `users/${userId}/${normalizeSubDir(subDir)}/${uuid()}${ext.toLowerCase()}`
}

function objectOwnerId(key: string): number {
  const match = key.match(/^users\/(\d+)\//)
  const userId = Number(match?.[1])
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`OSS 对象路径缺少有效用户前缀：${key}`)
  }
  return userId
}

function keyToReference(key: string): string {
  return storageDriver === 'oss' ? `${OSS_PUBLIC_BASE_URL}/${key}` : `static/${key}`
}

function referenceToKey(reference: string): string {
  const normalized = reference.replace(/^\//, '')
  if (normalized.startsWith('static/')) return normalized.slice('static/'.length)
  if (OSS_PUBLIC_BASE_URL && normalized.startsWith(`${OSS_PUBLIC_BASE_URL}/`)) {
    return normalized.slice(OSS_PUBLIC_BASE_URL.length + 1)
  }
  throw new Error(`不是当前存储驱动管理的文件：${reference}`)
}

async function putBuffer(key: string, buffer: Buffer): Promise<string> {
  if (storageDriver === 'oss') {
    const userId = objectOwnerId(key)
    await getOssClient().put(key, buffer, {
      headers: {
        'x-oss-object-acl': 'public-read',
        'x-oss-meta-user-id': String(userId),
      },
    })
  } else {
    const filePath = path.join(localStorageRoot, key)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, buffer)
  }
  return keyToReference(key)
}

/** 判断 URL/路径是否由当前应用的存储驱动管理。 */
export function isManagedStorageReference(reference: string): boolean {
  const normalized = String(reference || '').replace(/^\//, '')
  return normalized.startsWith('static/')
    || !!(OSS_PUBLIC_BASE_URL && normalized.startsWith(`${OSS_PUBLIC_BASE_URL}/`))
}

/** 下载远程生成结果并持久化到当前用户目录。 */
export async function downloadFile(url: string, userId: number, subDir: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  const ext = getExtFromUrl(url)
  const key = buildObjectKey(userId, subDir, `remote${ext}`)
  return putBuffer(key, Buffer.from(await response.arrayBuffer()))
}

/** 保存浏览器上传文件。 */
export async function saveUploadedFile(data: ArrayBuffer, userId: number, subDir: string, originalName: string): Promise<string> {
  return putBuffer(buildObjectKey(userId, subDir, originalName), Buffer.from(data))
}

/** 将本地临时文件上传到当前存储驱动，适合视频等大文件。 */
export async function saveLocalFile(localPath: string, userId: number, subDir: string, originalName: string): Promise<string> {
  const key = buildObjectKey(userId, subDir, originalName)
  if (storageDriver === 'oss') {
    await getOssClient().put(key, localPath, {
      headers: {
        'x-oss-object-acl': 'public-read',
        'x-oss-meta-user-id': String(objectOwnerId(key)),
      },
    })
    return keyToReference(key)
  }
  const target = path.join(localStorageRoot, key)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(localPath, target)
  return keyToReference(key)
}

function getExtFromUrl(url: string): string {
  try {
    const ext = path.extname(new URL(url).pathname)
    if (ext && ext.length <= 8) return ext
  } catch {}
  return '.bin'
}

/** 仅供本地驱动的静态文件服务使用；OSS 引用应通过 readStorageBuffer/materializeStorageFile 读取。 */
export function getAbsolutePath(relativePath: string): string {
  return path.join(localStorageRoot, referenceToKey(relativePath))
}

/** 保存 Base64 图片。 */
export async function saveBase64Image(base64Data: string, mimeType: string, userId: number, subDir: string): Promise<string> {
  const key = buildObjectKey(userId, subDir, `base64${mimeTypeToExt(mimeType)}`)
  return putBuffer(key, Buffer.from(base64Data, 'base64'))
}

/** 由图片引用推导缩略图引用。 */
export function thumbPathFor(reference: string): string {
  return reference.replace(/\.[^./?]+(?=$|\?)/, '_thumb.webp')
}

/** 读取本地或 OSS 文件内容；HTTP 历史资源也可兼容读取。 */
export async function readStorageBuffer(reference: string): Promise<Buffer> {
  if (/^https?:\/\//.test(reference)) {
    const response = await fetch(reference)
    if (!response.ok) throw new Error(`读取远程文件失败：${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
  return fs.readFileSync(getAbsolutePath(reference))
}

/** 保存与源文件同目录、固定命名的衍生文件（缩略图、海报帧）。 */
export async function saveDerivedBuffer(derivedReference: string, buffer: Buffer): Promise<string> {
  return putBuffer(referenceToKey(derivedReference), buffer)
}

/** 为图片生成宽 400 的 WebP 缩略图。失败不阻断主流程。 */
export async function generateImageThumb(reference: string): Promise<string | null> {
  try {
    const thumbReference = thumbPathFor(reference)
    const output = await sharp(await readStorageBuffer(reference))
      .rotate()
      .resize({ width: 400, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer()
    return saveDerivedBuffer(thumbReference, output)
  } catch (error) {
    console.warn(`[storage] 缩略图生成失败 ${reference}:`, (error as Error).message)
    return null
  }
}

export async function readImageAsDataUrl(reference: string): Promise<string> {
  const buffer = await readStorageBuffer(reference)
  const ext = path.extname(new URL(reference, 'http://local').pathname).toLowerCase()
  return `data:${extToMimeType(ext)};base64,${buffer.toString('base64')}`
}

export async function readImageAsCompressedDataUrl(
  reference: string,
  options: { maxWidth?: number; maxHeight?: number; quality?: number } = {},
): Promise<string> {
  const resized = sharp(await readStorageBuffer(reference)).rotate().resize({
    width: options.maxWidth ?? 768,
    height: options.maxHeight ?? 768,
    fit: 'inside',
    withoutEnlargement: true,
  })
  const metadata = await resized.metadata()
  const output = metadata.hasAlpha
    ? await resized.flatten({ background: '#ffffff' }).jpeg({ quality: options.quality ?? 68, mozjpeg: true }).toBuffer()
    : await resized.jpeg({ quality: options.quality ?? 68, mozjpeg: true }).toBuffer()
  return `data:image/jpeg;base64,${output.toString('base64')}`
}

/**
 * 将存储引用物化为本地文件，供 FFmpeg 等只接受文件路径的工具使用。
 * 本地驱动直接返回原文件；OSS/HTTP 下载到临时目录并提供清理函数。
 */
export async function materializeStorageFile(reference: string): Promise<{ path: string; cleanup: () => void }> {
  if (!/^https?:\/\//.test(reference)) {
    return { path: getAbsolutePath(reference), cleanup: () => {} }
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-storage-'))
  const ext = getExtFromUrl(reference)
  const tempPath = path.join(tempDir, `source${ext}`)
  fs.writeFileSync(tempPath, await readStorageBuffer(reference))
  return {
    path: tempPath,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  }
}

export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/)
  return match ? { mimeType: match[1], data: match[2] } : null
}

function mimeTypeToExt(mimeType: string): string {
  return ({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  } as Record<string, string>)[mimeType] || '.png'
}

function extToMimeType(ext: string): string {
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  } as Record<string, string>)[ext] || 'image/png'
}
