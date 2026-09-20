<template>
  <main class="login-page">
    <section class="login-panel">
      <div class="brand-mark"><Clapperboard :size="21" /></div>
      <div class="login-heading">
        <span>火宝短剧</span>
        <h1>管理后台</h1>
        <p>使用管理员账号登录</p>
      </div>
      <form @submit.prevent="submit">
        <label>
          <span>邮箱</span>
          <div class="field"><Mail :size="17" /><input v-model.trim="email" type="email" autocomplete="email" required placeholder="admin@example.com" /></div>
        </label>
        <label>
          <span>密码</span>
          <div class="field"><LockKeyhole :size="17" /><input v-model="password" type="password" autocomplete="current-password" minlength="8" required placeholder="请输入密码" /></div>
        </label>
        <p v-if="error" class="login-error"><CircleAlert :size="15" />{{ error }}</p>
        <button class="primary-button login-button" :disabled="submitting">
          <LoaderCircle v-if="submitting" class="spin" :size="17" />
          <span>{{ submitting ? '正在登录' : '登录管理后台' }}</span>
          <ArrowRight v-if="!submitting" :size="17" />
        </button>
      </form>
    </section>
    <aside class="login-visual" aria-hidden="true">
      <div class="visual-grid"></div>
      <div class="visual-title"><span>ADMIN CONSOLE</span><strong>账号与权限<br />集中管理</strong></div>
      <div class="visual-status"><i></i><span>系统服务正常</span></div>
    </aside>
  </main>
</template>

<script setup lang="ts">
import { ArrowRight, CircleAlert, Clapperboard, LoaderCircle, LockKeyhole, Mail } from 'lucide-vue-next'

const { login } = useAdminAuth()
const email = ref('')
const password = ref('')
const error = ref('')
const submitting = ref(false)

async function submit() {
  submitting.value = true
  error.value = ''
  try {
    await login(email.value, password.value)
    await navigateTo('/')
  } catch (err: any) {
    error.value = err.message || '登录失败'
  } finally {
    submitting.value = false
  }
}
</script>
