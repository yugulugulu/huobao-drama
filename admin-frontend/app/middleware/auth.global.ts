export default defineNuxtRouteMiddleware(async (to) => {
  const { user, restore } = useAdminAuth()
  await restore()
  if (!user.value && to.path !== '/login') return navigateTo('/login')
  if (user.value && to.path === '/login') return navigateTo('/')
})
