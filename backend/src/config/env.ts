/**
 * 环境配置加载与校验。
 *
 * 开发机默认读取 .env.development，生产环境只读取 .env.production。
 * 不同环境使用各自的 OSS 桶和凭据，避免开发资源与生产资源混用。
 */
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const backendRoot = path.resolve(__dirname, '../..')

export const appEnv = process.env.NODE_ENV === 'production' ? 'production' : 'development'
dotenv.config({ path: path.join(backendRoot, `.env.${appEnv}`) })

export const storageDriver = process.env.STORAGE_DRIVER || (appEnv === 'production' ? 'oss' : 'local')

/**
 * 本地存储路径始终相对 backend 目录解析，避免从仓库根目录或进程管理器启动时写入不同位置。
 * 使用 OSS 时该路径仅作为本地兼容配置，不承载对象资源。
 */
export const localStorageRoot = path.resolve(backendRoot, process.env.STORAGE_PATH || '../data/static')

/** 启动时及早暴露配置错误，避免任务运行到一半才发现存储不可用。 */
export function validateEnvironment() {
  const missing: string[] = []
  const invalid = (value: string | undefined) => !value || value.includes('请填写')
  if (invalid(process.env.JWT_SECRET) || process.env.JWT_SECRET!.length < 32) missing.push('JWT_SECRET（至少 32 位）')
  if (storageDriver !== 'local' && storageDriver !== 'oss') missing.push('STORAGE_DRIVER（仅支持 local 或 oss）')

  if (storageDriver === 'oss') {
    for (const key of ['OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_PUBLIC_BASE_URL']) {
      if (invalid(process.env[key])) missing.push(key)
    }
  }

  if (missing.length) {
    throw new Error(`环境 ${appEnv} 缺少或无效配置：${missing.join('、')}`)
  }
}
