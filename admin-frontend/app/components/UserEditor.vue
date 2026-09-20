<template>
  <Teleport to="body">
    <div v-if="open" class="dialog-layer" @click.self="emit('close')">
      <section class="dialog" role="dialog" aria-modal="true" :aria-label="editing ? '编辑用户' : '新建用户'">
        <header class="dialog-header">
          <div><span>{{ editing ? `用户 #${user?.id}` : 'USER ACCOUNT' }}</span><h2>{{ editing ? '编辑用户' : '新建用户' }}</h2></div>
          <button class="icon-button" title="关闭" @click="emit('close')"><X :size="18" /></button>
        </header>
        <form class="editor-form" @submit.prevent="save">
          <label><span>显示名</span><input v-model.trim="draft.display_name" required maxlength="64" placeholder="请输入显示名" /></label>
          <label><span>邮箱</span><input v-model.trim="draft.email" required type="email" placeholder="name@example.com" /></label>
          <div class="field-grid">
            <label><span>角色</span><select v-model="draft.role"><option value="user">普通用户</option><option value="admin">管理员</option></select></label>
            <label><span>状态</span><select v-model="draft.is_active"><option :value="true">正常</option><option :value="false">禁用</option></select></label>
          </div>
          <label><span>{{ editing ? '重置密码' : '初始密码' }}</span><input v-model="draft.password" :required="!editing" type="password" minlength="8" :placeholder="editing ? '留空则不修改' : '至少 8 个字符'" /></label>
          <p v-if="error" class="form-error"><CircleAlert :size="15" />{{ error }}</p>
          <footer class="dialog-actions"><button type="button" class="secondary-button" @click="emit('close')">取消</button><button class="primary-button" :disabled="saving"><LoaderCircle v-if="saving" class="spin" :size="16" />{{ saving ? '保存中' : '保存' }}</button></footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { CircleAlert, LoaderCircle, X } from 'lucide-vue-next'
import type { AdminUser, UserRole } from '../composables/useAdminApi'

const props = defineProps<{ open: boolean; user: AdminUser | null; saving: boolean; error: string }>()
const emit = defineEmits<{ close: []; save: [payload: Record<string, unknown>] }>()
const editing = computed(() => Boolean(props.user))
const draft = reactive<{ display_name: string; email: string; role: UserRole; is_active: boolean; password: string }>({ display_name: '', email: '', role: 'user', is_active: true, password: '' })

watch(() => [props.open, props.user] as const, () => {
  if (!props.open) return
  Object.assign(draft, {
    display_name: props.user?.display_name || '',
    email: props.user?.email || '',
    role: props.user?.role || 'user',
    is_active: props.user?.is_active ?? true,
    password: '',
  })
}, { immediate: true })

function save() {
  const payload: Record<string, unknown> = { ...draft }
  if (editing.value && !draft.password) delete payload.password
  emit('save', payload)
}
</script>
