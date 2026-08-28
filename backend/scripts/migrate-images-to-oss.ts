/**
 * 将数据库仍引用的本地图片迁移到当前环境 OSS。
 *
 * 归属规则：数据库记录的 user_id 是唯一可信来源，目标对象固定写入
 * users/{userId}/images/{filename}。上传和 OSS 校验全部成功后，才在事务内
 * 更新数据库；只有事务提交成功且没有遗留 static 图片引用时才删除本地文件。
 */
import fs from 'fs'
import path from 'path'
import OSS from 'ali-oss'
import type mysql from 'mysql2/promise'
import { backendRoot, localStorageRoot, storageDriver } from '../src/config/env.js'
import { pool } from '../src/db/index.js'

type OwnedReference = {
  table: string
  column: string
  id: number
  userId: number
  value: string
}

type Migration = {
  userId: number
  sourceReference: string
  sourcePath: string
  objectKey: string
  publicUrl: string
}

const PUBLIC_BASE_URL = (process.env.OSS_PUBLIC_BASE_URL || '').replace(/\/+$/, '')
const IMAGE_COLUMNS = [
  ['dramas', 'thumbnail'],
  ['episodes', 'thumbnail'],
  ['characters', 'image_url'],
  ['characters', 'reference_images'],
  ['characters', 'local_path'],
  ['scenes', 'image_url'],
  ['scenes', 'local_path'],
  ['props', 'image_url'],
  ['props', 'reference_images'],
  ['props', 'local_path'],
  ['storyboards', 'composed_image'],
  ['storyboards', 'first_frame_image'],
  ['storyboards', 'last_frame_image'],
  ['storyboards', 'reference_images'],
  ['sys_task', 'local_path'],
  ['sys_task', 'result_url'],
  ['sys_task', 'params'],
  ['assets', 'url'],
  ['assets', 'thumbnail_url'],
  ['assets', 'local_path'],
] as const

function assertEnvironment() {
  if (storageDriver !== 'oss') throw new Error('当前环境 STORAGE_DRIVER 不是 oss')
  for (const key of ['OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_PUBLIC_BASE_URL']) {
    const value = process.env[key]
    if (!value || value.includes('请填写')) throw new Error(`缺少有效配置：${key}`)
  }
}

function ossClient() {
  return new OSS({
    region: process.env.OSS_REGION!,
    bucket: process.env.OSS_BUCKET!,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID!,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET!,
  })
}

function localReference(value: string): string | null {
  const normalized = String(value || '').replace(/^\//, '')
  return normalized.startsWith('static/') ? normalized : null
}

function referencesInValue(value: string): string[] {
  return [...new Set(String(value || '').match(/\/?static\/[A-Za-z0-9_./-]+/g) || [])]
    .map(item => item.replace(/^\//, ''))
}

function sourcePath(reference: string): string {
  const relative = reference.slice('static/'.length)
  const resolved = path.resolve(localStorageRoot, relative)
  if (!resolved.startsWith(`${path.resolve(localStorageRoot)}${path.sep}`)) {
    throw new Error(`非法本地图片路径：${reference}`)
  }
  return resolved
}

function normalizedImageName(filePath: string): string {
  const name = path.basename(filePath)
  if (path.extname(name).toLowerCase() !== '.bin') return name
  const header = fs.readFileSync(filePath).subarray(0, 12)
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return `${path.basename(name, '.bin')}.png`
  }
  return name
}

function targetFor(userId: number, reference: string): Migration {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error(`无效 user_id：${userId}`)
  const filePath = sourcePath(reference)
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`本地文件不存在：${filePath}`)
  }
  const objectKey = `users/${userId}/images/${normalizedImageName(filePath)}`
  return {
    userId,
    sourceReference: reference,
    sourcePath: filePath,
    objectKey,
    publicUrl: `${PUBLIC_BASE_URL}/${objectKey}`,
  }
}

async function loadOwnedReferences(): Promise<OwnedReference[]> {
  const output: OwnedReference[] = []
  for (const [table, column] of IMAGE_COLUMNS) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT id, user_id AS userId, \`${column}\` AS value FROM \`${table}\` WHERE \`${column}\` LIKE ?`,
      ['%static/%'],
    )
    for (const row of rows) {
      output.push({ table, column, id: Number(row.id), userId: Number(row.userId), value: String(row.value || '') })
    }
  }
  return output
}

function buildMigrations(references: OwnedReference[]): Migration[] {
  const migrations = new Map<string, Migration>()
  for (const reference of references) {
    if (!Number.isInteger(reference.userId) || reference.userId <= 0) {
      throw new Error(`${reference.table}.${reference.column}#${reference.id} 缺少有效 user_id`)
    }
    for (const sourceReference of referencesInValue(reference.value)) {
      const migration = targetFor(reference.userId, sourceReference)
      migrations.set(`${migration.userId}:${migration.sourceReference}`, migration)

      const thumbReference = sourceReference.replace(/\.[^./]+$/, '_thumb.webp')
      const thumbPath = sourcePath(thumbReference)
      if (fs.existsSync(thumbPath)) {
        const thumbMigration = targetFor(reference.userId, thumbReference)
        migrations.set(`${thumbMigration.userId}:${thumbMigration.sourceReference}`, thumbMigration)
      }
    }
  }
  return [...migrations.values()]
}

async function uploadAndVerify(client: OSS, migration: Migration) {
  const localSize = fs.statSync(migration.sourcePath).size
  await client.put(migration.objectKey, migration.sourcePath, {
    headers: {
      'x-oss-object-acl': 'public-read',
      'x-oss-meta-user-id': String(migration.userId),
    },
  })
  const head = await client.head(migration.objectKey)
  const headers = head.res.headers as Record<string, string | number | undefined>
  const remoteSize = Number(headers['content-length'] || 0)
  const owner = String(headers['x-oss-meta-user-id'] || '')
  if (remoteSize !== localSize || owner !== String(migration.userId)) {
    throw new Error(`OSS 校验失败：${migration.objectKey}`)
  }
}

function replaceOwnedReferences(value: string, userId: number, migrations: Migration[]): string {
  let next = value
  for (const migration of migrations) {
    if (migration.userId !== userId) continue
    next = next.replaceAll(`/${migration.sourceReference}`, migration.publicUrl)
    next = next.replaceAll(migration.sourceReference, migration.publicUrl)
  }
  return next
}

async function updateDatabase(references: OwnedReference[], migrations: Migration[]) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    for (const reference of references) {
      const next = replaceOwnedReferences(reference.value, reference.userId, migrations)
      if (next === reference.value) continue
      const [result] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE \`${reference.table}\` SET \`${reference.column}\` = ? WHERE id = ? AND user_id = ? AND \`${reference.column}\` = ?`,
        [next, reference.id, reference.userId, reference.value],
      )
      if (result.affectedRows !== 1) {
        throw new Error(`并发更新冲突：${reference.table}.${reference.column}#${reference.id}`)
      }
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

async function countRemainingReferences(): Promise<number> {
  let count = 0
  for (const [table, column] of IMAGE_COLUMNS) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM \`${table}\` WHERE \`${column}\` LIKE ?`,
      ['%static/%'],
    )
    count += Number(rows[0]?.count || 0)
  }
  return count
}

function deleteMigratedLocalFiles(migrations: Migration[]) {
  const files = [...new Set(migrations.map(item => item.sourcePath))]
  for (const file of files) fs.unlinkSync(file)

  const removeEmptyDirs = (dir: string) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir)) {
      const child = path.join(dir, entry)
      if (fs.statSync(child).isDirectory()) removeEmptyDirs(child)
    }
    if (dir !== localStorageRoot && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  }
  removeEmptyDirs(localStorageRoot)
}

async function main() {
  assertEnvironment()
  const references = await loadOwnedReferences()
  const migrations = buildMigrations(references)
  if (!migrations.length) {
    console.log('没有需要迁移的本地图片引用')
    return
  }

  const users = [...new Set(migrations.map(item => item.userId))].sort((a, b) => a - b)
  console.log(`准备迁移 ${migrations.length} 个用户图片文件，用户：${users.join(', ')}`)
  const client = ossClient()
  for (const [index, migration] of migrations.entries()) {
    await uploadAndVerify(client, migration)
    console.log(`[${index + 1}/${migrations.length}] user=${migration.userId} ${migration.objectKey}`)
  }

  await updateDatabase(references, migrations)
  const remaining = await countRemainingReferences()
  if (remaining) throw new Error(`数据库仍有 ${remaining} 条本地图片引用，保留本地文件`)

  deleteMigratedLocalFiles(migrations)
  console.log(`迁移完成：${migrations.length} 个 OSS 对象，数据库引用已更新，本地图片已删除`)
}

main()
  .catch(error => {
    console.error(`迁移失败：${(error as Error).message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
