import type { Context } from 'hono'

export function success(c: Context, data: any = null) {
  return c.json({ code: 200, data, message: 'success' })
}

export function created(c: Context, data: any = null) {
  return c.json({ code: 201, data, message: 'created' }, 201)
}

export function badRequest(c: Context, message = 'bad request') {
  return c.json({ code: 400, message }, 400)
}

/** 登录态缺失、失效或伪造时统一返回 401。 */
export function unauthorized(c: Context, message = 'unauthorized') {
  return c.json({ code: 401, message }, 401)
}

/** 已登录但没有执行当前操作的权限。 */
export function forbidden(c: Context, message = 'forbidden') {
  return c.json({ code: 403, message }, 403)
}

/** 资源冲突（例如邮箱或用户内风格 key 重复）。 */
export function conflict(c: Context, message = 'conflict') {
  return c.json({ code: 409, message }, 409)
}

export function notFound(c: Context, message = 'not found') {
  return c.json({ code: 404, message }, 404)
}

export function serverError(c: Context, message = 'internal error') {
  return c.json({ code: 500, message }, 500)
}

export function now() {
  return new Date().toISOString()
}
