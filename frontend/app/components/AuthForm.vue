<template>
  <section class="auth-form-wrap">
    <div class="auth-heading">
      <p>{{ mode === 'login' ? '欢迎回来' : '创建工作空间账号' }}</p>
      <h1>{{ mode === 'login' ? '登录火宝短剧' : '注册火宝短剧' }}</h1>
    </div>

    <form class="auth-form" @submit.prevent="submit">
      <label v-if="mode === 'register'">
        <span>显示名</span>
        <div class="field"><UserRound :size="17" /><input v-model.trim="displayName" name="name" autocomplete="name" maxlength="64" required placeholder="你的称呼" /></div>
      </label>
      <label>
        <span>邮箱</span>
        <div class="field"><Mail :size="17" /><input v-model.trim="email" name="email" type="email" autocomplete="email" required placeholder="name@example.com" /></div>
      </label>
      <label>
        <span>密码</span>
        <div class="field">
          <LockKeyhole :size="17" />
          <input v-model="password" name="password" :type="showPassword ? 'text' : 'password'" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" minlength="8" required placeholder="至少 8 个字符" />
          <button type="button" class="password-toggle" :title="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">
            <EyeOff v-if="showPassword" :size="17" /><Eye v-else :size="17" />
          </button>
        </div>
      </label>

      <p v-if="error" class="form-error" role="alert"><CircleAlert :size="15" />{{ error }}</p>
      <button class="submit-button" type="submit" :disabled="submitting">
        <LoaderCircle v-if="submitting" class="spin" :size="17" />
        <span>{{ submitting ? '正在提交' : mode === 'login' ? '登录' : '注册并进入' }}</span>
        <ArrowRight v-if="!submitting" :size="17" />
      </button>
    </form>

    <p class="auth-switch">
      {{ mode === 'login' ? '还没有账号？' : '已经有账号？' }}
      <NuxtLink :to="mode === 'login' ? '/register' : '/login'">{{ mode === 'login' ? '立即注册' : '返回登录' }}</NuxtLink>
    </p>
  </section>
</template>

<script setup lang="ts">
import { ArrowRight, CircleAlert, Eye, EyeOff, LoaderCircle, LockKeyhole, Mail, UserRound } from 'lucide-vue-next'

const props = defineProps<{ mode: 'login' | 'register' }>()
const route = useRoute()
const { login, register } = useAuth()
const email = ref('')
const displayName = ref('')
const password = ref('')
const showPassword = ref(false)
const submitting = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  submitting.value = true
  try {
    if (props.mode === 'login') await login(email.value, password.value)
    else await register(email.value, displayName.value, password.value)
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
      ? route.query.redirect
      : '/'
    await navigateTo(redirect)
  } catch (err: any) {
    error.value = err.message || '提交失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.auth-form-wrap { width:100%; max-width:360px; animation:form-in .45s cubic-bezier(.2,.8,.2,1) both; }
.auth-heading p { color:#f05a28; font-size:13px; font-weight:650; margin-bottom:8px; }
.auth-heading h1 { font-size:30px; line-height:1.2; letter-spacing:0; }
.auth-form { display:flex; flex-direction:column; gap:18px; margin-top:34px; }
label { display:flex; flex-direction:column; gap:7px; }
label > span { font-size:13px; font-weight:600; color:#414148; }
.field { height:44px; display:flex; align-items:center; gap:10px; padding:0 12px; border:1px solid #d9d9df; border-radius:7px; color:#92929b; background:#fff; transition:border-color .18s,box-shadow .18s; }
.field:focus-within { border-color:#71717b; box-shadow:0 0 0 3px rgba(23,23,27,.08); }
.field input { min-width:0; flex:1; border:0; outline:0; background:transparent; color:#17171b; font:14px/1.2 inherit; letter-spacing:0; }
.field input::placeholder { color:#aaaab2; }
.password-toggle { width:28px; height:28px; display:grid; place-items:center; border:0; background:transparent; color:#777780; cursor:pointer; border-radius:5px; }
.password-toggle:hover { background:#f1f1f4; color:#17171b; }
.form-error { display:flex; align-items:flex-start; gap:7px; color:#c6322a; font-size:12.5px; line-height:1.5; margin-top:-4px; }
.form-error svg { flex:none; margin-top:2px; }
.submit-button { height:44px; border:0; border-radius:7px; display:flex; align-items:center; justify-content:center; gap:9px; background:#1c1c20; color:white; font:650 14px/1 inherit; cursor:pointer; transition:background .18s,transform .12s; }
.submit-button:hover { background:#333338; }.submit-button:active { transform:scale(.99); }.submit-button:disabled { opacity:.65; cursor:wait; }
.auth-switch { margin-top:24px; color:#74747c; font-size:13px; }.auth-switch a { color:#17171b; font-weight:650; text-decoration:none; margin-left:4px; }.auth-switch a:hover { text-decoration:underline; }
.spin { animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg) } } @keyframes form-in { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:none } }
@media (prefers-reduced-motion:reduce) { .auth-form-wrap { animation:none; }.spin { animation:none; } }
</style>
