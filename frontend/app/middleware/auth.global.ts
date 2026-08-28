/**
 * 全局前端路由守卫。
 * 后端仍是最终安全边界；这里用于在进入工作台前恢复 Cookie 会话并改善跳转体验。
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const publicPages = new Set(['/login', '/register'])
  const { user, fetchUser } = useAuth()
  await fetchUser()

  if (!user.value && !publicPages.has(to.path)) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
  if (user.value && publicPages.has(to.path)) return navigateTo('/')
})
