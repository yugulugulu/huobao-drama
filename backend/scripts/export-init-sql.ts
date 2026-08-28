/**
 * 导出初始化 SQL — 把 src/db/mysql-schema.ts 中的内嵌 DDL/DML 生成为独立 init.sql
 *
 * 用法: npx tsx scripts/export-init-sql.ts [输出路径]
 * 默认输出: <repo>/docker/init.sql
 *
 * 说明:
 * - 应用启动时本就会自动执行同样的初始化(initMySqlSchema),该文件是可选产物,
 *   用于 DBA 审核、预建表或挂到 MySQL 容器的 /docker-entrypoint-initdb.d/
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  mysqlColumnBackfillStatements,
  mysqlSchemaStatements,
  tenantMigrationStatements,
} from '../src/db/mysql-schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outPath = path.resolve(process.argv[2] || path.join(__dirname, '../../docker/init.sql'))
const databaseName = process.env.MYSQL_DATABASE || 'huobao_drama'
if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) throw new Error(`非法数据库名: ${databaseName}`)

const sections: string[] = []
const legacyBackfillSql = new Set(mysqlColumnBackfillStatements.map(({ sql }) => sql))
const freshDatabaseStatements = tenantMigrationStatements.filter(sql => !legacyBackfillSql.has(sql))

sections.push(`-- ============================================================================
-- AI Drama Studio 初始化 SQL
-- 由 backend/scripts/export-init-sql.ts 从 backend/src/db/mysql-schema.ts 生成
-- 生成时间: ${new Date().toISOString()}
--
-- 用途: 在全新 MySQL 8.0+ 服务器上创建数据库与当前完整表结构。
-- 默认风格预设由应用在用户注册或历史账号初始化时按用户写入。
-- ============================================================================

SET NAMES utf8mb4;
CREATE DATABASE IF NOT EXISTS \`${databaseName}\`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE \`${databaseName}\`;
`)

sections.push(`-- ----------------------------------------------------------------------------
-- 1. 建表(${mysqlSchemaStatements.length} 张)
-- ----------------------------------------------------------------------------
${mysqlSchemaStatements.map(s => `${s};`).join('\n\n')}
`)

sections.push(`-- ----------------------------------------------------------------------------
-- 2. 当前版本增量结构
-- 说明: 此文件面向空数据库，以下语句在基础表上补齐多用户字段与索引。
-- ----------------------------------------------------------------------------
${freshDatabaseStatements.map(s => `${s};`).join('\n\n')}
`)

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, sections.join('\n'), 'utf8')
console.log(`✅ 已导出: ${outPath}`)
console.log(`   数据库 ${databaseName}, 基础建表 ${mysqlSchemaStatements.length} 条, 增量结构 ${freshDatabaseStatements.length} 条`)
