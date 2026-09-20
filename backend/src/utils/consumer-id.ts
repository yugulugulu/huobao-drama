import { randomUUID } from 'crypto'

/**
 * 生成唯一的 consumer_id
 */
export function generateConsumerId(): string {
  return `user_${randomUUID()}`
}

/**
 * 验证 consumer_id 格式
 * - 最大长度 128
 * - 允许字符：A-Z a-z 0-9 . _ : -
 */
export function validateConsumerId(id: string): boolean {
  const trimmed = id.trim()
  if (!trimmed || trimmed.length > 128) return false
  return /^[A-Za-z0-9._:-]+$/.test(trimmed)
}
