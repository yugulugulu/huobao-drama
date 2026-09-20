import '../config/env.js'
import fs from 'fs'
import mysql from 'mysql2/promise'
import bcrypt from 'bcryptjs'
import { drizzle } from 'drizzle-orm/mysql2'
import * as schema from './schema.js'
import { initMySqlSchema, stylePresetSeedStatements } from './mysql-schema.js'
import { generateConsumerId } from '../utils/consumer-id.js'

// 容器内 127.0.0.1 指向容器自身;未显式配置时默认指向宿主机
// (Linux 需 --add-host=host.docker.internal:host-gateway 才能解析)
const inContainer = fs.existsSync('/.dockerenv')
const usingDefaultHost = !process.env.DATABASE_URL && !process.env.MYSQL_HOST

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL

  const host = process.env.MYSQL_HOST || (inContainer ? 'host.docker.internal' : '127.0.0.1')
  const port = process.env.MYSQL_PORT || '3306'
  const user = encodeURIComponent(process.env.MYSQL_USER || 'huobao')
  const password = encodeURIComponent(process.env.MYSQL_PASSWORD || 'huobao')
  const database = process.env.MYSQL_DATABASE || 'huobao_drama'
  return `mysql://${user}:${password}@${host}:${port}/${database}`
}

export const pool = mysql.createPool({
  uri: databaseUrl(),
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  charset: 'utf8mb4',
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 启动建表带重试：Docker 部署时 MySQL 容器就绪晚于应用启动，直接失败会导致进程崩溃 */
export async function initDb(retries = 10, delayMs = 3000) {
  for (let attempt = 1; ; attempt++) {
    try {
      await initMySqlSchema(pool)
      await migrateLegacyData(pool)
      await enforceTenantOwnership(pool)
      await migrateConsumerIds(pool)
      await ensureInitialAdmin(pool)
      return
    } catch (err) {
      if (attempt >= retries) throw err
      console.warn(`[db] init failed (attempt ${attempt}/${retries}), retrying in ${delayMs}ms: ${(err as Error).message}`)
      if (attempt === 1 && usingDefaultHost && inContainer) {
        console.warn('[db] 未配置数据库连接:容器内默认尝试宿主机 host.docker.internal:3306。' +
          '如使用独立 MySQL 容器或外部数据库,请设置 DATABASE_URL 或 MYSQL_HOST 环境变量')
      }
      await sleep(delayMs)
    }
  }
}

/**
 * 将单用户时代的记录迁给兼容账号。
 * 使用 user_id IS NULL 作为条件，因此即使服务重启也不会改写已经归属到真实用户的数据。
 */
async function migrateLegacyData(pool: mysql.Pool) {
  const email = (process.env.LEGACY_OWNER_EMAIL || 'legacy@local.huobao').toLowerCase()
  const displayName = process.env.LEGACY_OWNER_DISPLAY_NAME || '历史数据所有者'
  const password = process.env.LEGACY_OWNER_PASSWORD || 'change-this-legacy-password'
  const ts = new Date().toISOString()
  const [existingRows] = await pool.query<mysql.RowDataPacket[]>('SELECT id FROM users WHERE email = ? LIMIT 1', [email])
  let userId = existingRows[0]?.id as number | undefined
  if (!userId) {
    const [result] = await pool.query<mysql.ResultSetHeader>(
      'INSERT INTO users (email, display_name, password_hash, consumer_id, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [email, displayName, await bcrypt.hash(password, 12), generateConsumerId(), ts, ts],
    )
    userId = result.insertId
  }

  const tenantTables = ['dramas', 'episodes', 'characters', 'scenes', 'storyboards', 'props', 'audios', 'sys_task', 'video_merges', 'assets', 'ai_service_configs', 'style_presets']
  for (const table of tenantTables) {
    await pool.query(`UPDATE \`${table}\` SET user_id = ? WHERE user_id IS NULL`, [userId])
  }
  for (const seed of stylePresetSeedStatements(userId)) {
    await pool.query(seed.sql, seed.params)
  }
}

/**
 * 历史数据回填完成后将 user_id 收紧为非空，防止后续代码遗漏归属字段。
 * MODIFY COLUMN 可重复执行，适合当前项目的启动式轻量迁移机制。
 */
async function enforceTenantOwnership(pool: mysql.Pool) {
  const tenantTables = ['dramas', 'episodes', 'characters', 'scenes', 'storyboards', 'props', 'audios', 'sys_task', 'video_merges', 'assets', 'ai_service_configs', 'style_presets']
  for (const table of tenantTables) {
    await pool.query(`ALTER TABLE \`${table}\` MODIFY COLUMN user_id INT NOT NULL`)
  }
}

/** 为现有用户生成唯一的 consumer_id */
async function migrateConsumerIds(pool: mysql.Pool) {
  // 先添加列（如果不存在）
  try {
    await pool.query(`
      ALTER TABLE users
      ADD COLUMN consumer_id VARCHAR(128) UNIQUE NULL
    `)
  } catch (err: any) {
    // 列已存在，忽略错误
    if (!err.message.includes('Duplicate column name')) {
      throw err
    }
  }

  // 获取所有没有 consumer_id 的用户
  const [users] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT id FROM users WHERE consumer_id IS NULL OR consumer_id = ""'
  )

  // 逐个生成唯一的 consumer_id
  for (const user of users) {
    let attempts = 0
    while (attempts < 5) {
      try {
        const consumerId = generateConsumerId()
        await pool.query(
          'UPDATE users SET consumer_id = ? WHERE id = ?',
          [consumerId, user.id]
        )
        break
      } catch (err: any) {
        if (err.code === 'ER_DUP_ENTRY') {
          attempts++
          continue
        }
        throw err
      }
    }
  }

  // 收紧为 NOT NULL
  await pool.query(`
    ALTER TABLE users
    MODIFY COLUMN consumer_id VARCHAR(128) NOT NULL UNIQUE
  `)
}

/** 可选地从部署环境创建或提升首个管理员，避免开放注册产生管理员账号。 */
async function ensureInitialAdmin(pool: mysql.Pool) {
  const email = String(process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase()
  if (!email) return

  const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT id, role FROM users WHERE email = ? LIMIT 1', [email])
  const existing = rows[0]
  const ts = new Date().toISOString()
  if (existing) {
    if (existing.role !== 'admin') {
      await pool.query('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', ['admin', ts, existing.id])
    }
    return
  }

  const password = String(process.env.INITIAL_ADMIN_PASSWORD || '')
  if (password.length < 8) {
    throw new Error('配置 INITIAL_ADMIN_EMAIL 时，INITIAL_ADMIN_PASSWORD 至少需要 8 个字符')
  }
  const displayName = String(process.env.INITIAL_ADMIN_DISPLAY_NAME || '系统管理员').trim().slice(0, 64) || '系统管理员'
  const [result] = await pool.query<mysql.ResultSetHeader>(
    'INSERT INTO users (email, display_name, password_hash, consumer_id, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    [email, displayName, await bcrypt.hash(password, 12), generateConsumerId(), 'admin', ts, ts],
  )
  for (const seed of stylePresetSeedStatements(result.insertId)) {
    await pool.query(seed.sql, seed.params)
  }
}

export function getInsertId(result: unknown) {
  const packet = Array.isArray(result) ? result[0] : result
  const insertId = (packet as { insertId?: number | string } | undefined)?.insertId
  if (insertId === undefined || insertId === null) {
    throw new Error('MySQL insert did not return an insertId')
  }
  return Number(insertId)
}

await initDb()

export const db = drizzle(pool, { schema, mode: 'default' })
export { schema }
export type DB = typeof db
