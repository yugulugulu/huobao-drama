<template>
  <Teleport to="body">
    <div v-if="open" class="dialog-layer" @click.self="emit('close')">
      <section class="dialog confirm-dialog" role="alertdialog" aria-modal="true">
        <div class="danger-icon"><Trash2 :size="20" /></div>
        <h2>删除用户</h2>
        <p>确认删除「{{ user?.display_name }}」？已有业务数据的用户不能删除，请改为禁用。</p>
        <footer class="dialog-actions"><button class="secondary-button" @click="emit('close')">取消</button><button class="danger-button" :disabled="loading" @click="emit('confirm')"><LoaderCircle v-if="loading" class="spin" :size="16" />{{ loading ? '删除中' : '确认删除' }}</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { LoaderCircle, Trash2 } from 'lucide-vue-next'
import type { AdminUser } from '../composables/useAdminApi'
defineProps<{ open: boolean; user: AdminUser | null; loading: boolean }>()
const emit = defineEmits<{ close: []; confirm: [] }>()
</script>
