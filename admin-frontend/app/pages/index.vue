<template>
  <div class="admin-shell">
    <aside :class="['sidebar', { 'mobile-open': mobileNavOpen }]">
      <div class="sidebar-brand"><div class="brand-mark small"><Clapperboard :size="18" /></div><div><strong>火宝短剧</strong><span>管理后台</span></div></div>
      <nav><span>工作区</span><a class="active"><UsersRound :size="17" />用户管理</a></nav>
      <div class="sidebar-account"><div class="avatar">{{ initials }}</div><div><strong>{{ authUser?.display_name }}</strong><span>{{ authUser?.email }}</span></div><button class="icon-button dark" title="退出登录" @click="logout"><LogOut :size="17" /></button></div>
    </aside>

    <main class="workspace">
      <header class="topbar"><button class="mobile-menu icon-button" title="导航" @click="mobileNavOpen = true"><Menu :size="18" /></button><div><span>管理后台</span><strong>用户管理</strong></div><button class="primary-button" @click="openCreate"><UserPlus :size="16" />新建用户</button></header>

      <section class="content">
        <div class="page-heading"><div><h1>用户管理</h1><p>管理账号状态、角色与登录凭据</p></div><button class="icon-button" title="刷新" :disabled="loading" @click="loadUsers"><RefreshCw :size="17" :class="{ spin: loading }" /></button></div>

        <div class="stats-band">
          <div><span>全部用户</span><strong>{{ stats.total }}</strong></div>
          <div><span>正常账号</span><strong>{{ stats.active }}</strong></div>
          <div><span>管理员</span><strong>{{ stats.admins }}</strong></div>
          <div><span>禁用账号</span><strong>{{ stats.disabled }}</strong></div>
        </div>

        <div class="toolbar">
          <div class="search-field"><Search :size="17" /><input v-model="query" placeholder="搜索显示名或邮箱" @input="queueSearch" /><button v-if="query" title="清空" @click="query = ''; loadUsers()"><X :size="15" /></button></div>
          <select v-model="roleFilter" @change="applyFilters"><option value="">全部角色</option><option value="user">普通用户</option><option value="admin">管理员</option></select>
          <select v-model="statusFilter" @change="applyFilters"><option value="">全部状态</option><option value="active">正常</option><option value="disabled">禁用</option></select>
        </div>

        <section class="table-region" aria-live="polite">
          <table>
            <thead><tr><th>用户</th><th>角色</th><th>状态</th><th>创建时间</th><th class="actions-heading">操作</th></tr></thead>
            <tbody>
              <tr v-for="item in users" :key="item.id">
                <td><div class="user-cell"><div class="avatar table-avatar">{{ getInitials(item.display_name) }}</div><div><strong>{{ item.display_name }}</strong><span>{{ item.email }}</span></div></div></td>
                <td><span :class="['role-badge', item.role]">{{ item.role === 'admin' ? '管理员' : '普通用户' }}</span></td>
                <td><div class="status-cell"><i :class="{ disabled: !item.is_active }"></i>{{ item.is_active ? '正常' : '已禁用' }}</div></td>
                <td><span class="date-cell">{{ formatDate(item.created_at) }}</span></td>
                <td><div class="row-actions"><button class="icon-button" title="编辑" @click="openEdit(item)"><Pencil :size="16" /></button><button class="icon-button" :title="item.is_active ? '禁用' : '启用'" :disabled="item.id === authUser?.id" @click="toggleUser(item)"><UserX v-if="item.is_active" :size="16" /><UserCheck v-else :size="16" /></button><button class="icon-button danger" title="删除" :disabled="item.id === authUser?.id" @click="openDelete(item)"><Trash2 :size="16" /></button></div></td>
              </tr>
            </tbody>
          </table>
          <div v-if="loading" class="table-state"><LoaderCircle class="spin" :size="20" />正在加载用户</div>
          <div v-else-if="!users.length" class="table-state"><UsersRound :size="22" /><span>没有符合条件的用户</span></div>
        </section>

        <footer v-if="total > pageSize" class="pagination"><span>共 {{ total }} 位用户</span><div><button class="icon-button" title="上一页" :disabled="page === 1" @click="page--; loadUsers()"><ChevronLeft :size="17" /></button><span>{{ page }} / {{ pageCount }}</span><button class="icon-button" title="下一页" :disabled="page === pageCount" @click="page++; loadUsers()"><ChevronRight :size="17" /></button></div></footer>
      </section>
    </main>

    <button v-if="mobileNavOpen" class="mobile-nav-backdrop" title="关闭导航" @click="mobileNavOpen = false"></button>

    <UserEditor :open="editorOpen" :user="editingUser" :saving="saving" :error="editorError" @close="editorOpen = false" @save="saveUser" />
    <ConfirmDialog :open="deleteOpen" :user="deletingUser" :loading="deleting" @close="deleteOpen = false" @confirm="deleteUser" />
  </div>
</template>

<script setup lang="ts">
import { ChevronLeft, ChevronRight, Clapperboard, LoaderCircle, LogOut, Menu, Pencil, RefreshCw, Search, Trash2, UserCheck, UserPlus, UsersRound, UserX, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import type { AdminUser } from '../composables/useAdminApi'

const { user: authUser, logout } = useAdminAuth()
const users = ref<AdminUser[]>([])
const total = ref(0)
const stats = reactive({ total: 0, active: 0, admins: 0, disabled: 0 })
const loading = ref(false)
const query = ref('')
const roleFilter = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = 20
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
const initials = computed(() => getInitials(authUser.value?.display_name || '管理员'))
const editorOpen = ref(false)
const editingUser = ref<AdminUser | null>(null)
const saving = ref(false)
const editorError = ref('')
const deleteOpen = ref(false)
const deletingUser = ref<AdminUser | null>(null)
const deleting = ref(false)
const mobileNavOpen = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined

function getInitials(name: string) { return name.trim().slice(0, 2).toUpperCase() || 'U' }
function formatDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) }

async function loadUsers() {
  loading.value = true
  try {
    const params = new URLSearchParams({ page: String(page.value), page_size: String(pageSize) })
    if (query.value) params.set('query', query.value)
    if (roleFilter.value) params.set('role', roleFilter.value)
    if (statusFilter.value) params.set('status', statusFilter.value)
    const result = await adminApi.users(params)
    users.value = result.items
    total.value = result.total
    Object.assign(stats, result.stats)
  } catch (err: any) { toast.error(err.message || '加载用户失败') }
  finally { loading.value = false }
}

function queueSearch() { clearTimeout(searchTimer); page.value = 1; searchTimer = setTimeout(loadUsers, 300) }
function applyFilters() { page.value = 1; loadUsers() }
function openCreate() { editingUser.value = null; editorError.value = ''; editorOpen.value = true }
function openEdit(user: AdminUser) { editingUser.value = user; editorError.value = ''; editorOpen.value = true }
function openDelete(user: AdminUser) { deletingUser.value = user; deleteOpen.value = true }

async function saveUser(payload: Record<string, unknown>) {
  saving.value = true
  editorError.value = ''
  try {
    if (editingUser.value) await adminApi.updateUser(editingUser.value.id, payload)
    else await adminApi.createUser(payload)
    toast.success(editingUser.value ? '用户信息已更新' : '用户已创建')
    editorOpen.value = false
    await loadUsers()
  } catch (err: any) { editorError.value = err.message || '保存失败' }
  finally { saving.value = false }
}

async function toggleUser(user: AdminUser) {
  try {
    await adminApi.updateUser(user.id, { is_active: !user.is_active })
    toast.success(user.is_active ? '用户已禁用' : '用户已启用')
    await loadUsers()
  } catch (err: any) { toast.error(err.message || '操作失败') }
}

async function deleteUser() {
  if (!deletingUser.value) return
  deleting.value = true
  try {
    await adminApi.deleteUser(deletingUser.value.id)
    toast.success('用户已删除')
    deleteOpen.value = false
    await loadUsers()
  } catch (err: any) { toast.error(err.message || '删除失败') }
  finally { deleting.value = false }
}

onMounted(loadUsers)
onUnmounted(() => clearTimeout(searchTimer))
</script>
