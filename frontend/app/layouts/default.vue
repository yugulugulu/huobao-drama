<template>
  <div class="shell">
    <!-- Header -->
    <header class="header">
      <div class="header-left">
        <button class="brand" @click="navigateTo('/')">
          <div class="brand-mark" aria-hidden="true"><LayoutGrid :size="17" :stroke-width="2" /></div>
          <div class="brand-text">
            <span class="brand-name">AI 短剧工作台</span>
            <span class="brand-sub">AI Drama Studio</span>
          </div>
        </button>
      </div>

      <nav class="header-nav">
        <NuxtLink to="/" class="nav-link" :class="{ active: route.path === '/' }">
          <LayoutGrid :size="15" :stroke-width="1.8" />
          <span>项目</span>
        </NuxtLink>
        <NuxtLink to="/settings" class="nav-link" :class="{ active: route.path === '/settings' }">
          <Settings :size="15" :stroke-width="1.8" />
          <span>设置</span>
        </NuxtLink>
      </nav>

      <div class="account">
        <div class="account-copy"><strong>{{ user?.display_name }}</strong><span>{{ user?.email }}</span></div>
        <button class="logout-button" title="退出登录" @click="logout"><LogOut :size="16" :stroke-width="1.8" /></button>
      </div>
    </header>

    <!-- AI 服务未配置引导横幅(缺任一类型即提示) -->
    <div v-if="missingConfigLabels.length" class="config-banner">
      <TriangleAlert :size="14" :stroke-width="1.8" />
      <span>尚未配置{{ missingConfigLabels.join('、') }}模型,AI 功能无法使用</span>
      <NuxtLink to="/settings" class="config-banner-link">前往设置</NuxtLink>
    </div>

    <main class="content">
      <slot />
    </main>
  </div>
</template>

<script setup>
import { LayoutGrid, LogOut, Settings, TriangleAlert } from 'lucide-vue-next'
import { aiConfigAPI } from '~/composables/useApi'

const route = useRoute()
const { user, logout } = useAuth()

const SERVICE_TYPE_LABELS = { text: '文本', image: '图片', video: '视频' }
const missingConfigLabels = ref([])

async function checkAiConfigs() {
  try {
    const configs = await aiConfigAPI.list()
    missingConfigLabels.value = Object.entries(SERVICE_TYPE_LABELS)
      .filter(([type]) => !configs.some(c => c.service_type === type && c.is_active))
      .map(([, label]) => label)
  } catch { /* 配置检查失败不阻塞页面 */ }
}

onMounted(checkAiConfigs)
// 设置页保存配置后返回时重新检查(布局跨页面复用,onMounted 只触发一次)
watch(() => route.path, checkAiConfigs)
</script>

<style scoped>
.shell {
  display: flex; flex-direction: column;
  height: 100vh; overflow: hidden;
  background: var(--bg-base);
}

/* === Header === */
.header {
  display: flex; align-items: center;
  height: 60px; flex-shrink: 0;
  padding: 0 24px;
  gap: 32px;
  background: rgba(251,251,253,0.72);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 1px solid var(--border);
  position: relative; z-index: 10;
}

.header-left { display: flex; align-items: center; }

.brand {
  display: flex; align-items: center; gap: 11px;
  background: transparent; border: none; cursor: pointer; padding: 4px 8px 4px 4px;
  text-decoration: none; border-radius: var(--radius);
  transition: background 0.18s var(--ease-out);
}
.brand:hover { background: var(--bg-hover); }
.brand:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.brand-mark {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  background: var(--text-0); border-radius: 9px;
  overflow: hidden;
}
.brand-logo {
  width: 22px;
  height: 22px;
  object-fit: contain;
  display: block;
}
.brand-fallback {
  font-size: 15px;
  font-weight: 700;
  color: #fff;
  line-height: 1;
}
.brand-text { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15; }
.brand-name {
  font-size: 15px; font-weight: 700;
  color: var(--text-0);
  letter-spacing: -0.01em;
}
.brand-sub {
  font-size: 10px; font-weight: 400;
  color: var(--text-3); margin-top: 1px;
  letter-spacing: 0.04em;
}

/* Nav — pill segmented group */
.header-nav {
  display: flex; gap: 2px;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: rgba(0,0,0,0.05);
}
.account { margin-left:auto; display:flex; align-items:center; gap:10px; min-width:0; }
.account-copy { display:flex; flex-direction:column; align-items:flex-end; min-width:0; line-height:1.2; }
.account-copy strong { max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-1); font-size:12px; font-weight:650; letter-spacing:0; }
.account-copy span { max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-3); font-size:10px; letter-spacing:0; }
.logout-button { width:32px; height:32px; display:grid; place-items:center; flex:none; border:0; border-radius:7px; background:transparent; color:var(--text-2); cursor:pointer; }
.logout-button:hover { background:var(--bg-hover); color:var(--text-0); }
.logout-button:focus-visible { outline:none; box-shadow:0 0 0 3px var(--button-focus); }
.nav-link {
  display: flex; align-items: center; gap: 6px;
  min-height: 32px;
  padding: 0 16px; border-radius: var(--radius-pill);
  font-size: 13px; font-weight: 600;
  color: var(--text-2); text-decoration: none;
  transition: all 0.18s var(--ease-out);
  border: none;
  line-height: 1;
}
.nav-link:hover { color: var(--text-0); }
.nav-link.active {
  background: #fff;
  color: var(--text-0);
  box-shadow: 0 1px 4px rgba(0,0,0,0.1);
}
.nav-link:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}

/* Config banner — AI 服务未配置引导 */
.config-banner {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 24px; flex-shrink: 0;
  font-size: 12.5px; color: #92400e;
  background: #fffbeb;
  border-bottom: 1px solid #fde68a;
  position: relative; z-index: 9;
}
.config-banner-link {
  margin-left: auto;
  font-size: 12.5px; font-weight: 600;
  color: #b45309; text-decoration: none;
  padding: 2px 10px; border-radius: var(--radius-pill);
  border: 1px solid #fcd34d;
  transition: all 0.18s var(--ease-out);
  line-height: 1.6;
}
.config-banner-link:hover { background: #fef3c7; color: #92400e; }

/* Content */
.content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
@media (max-width: 720px) {
  .header { padding:0 12px; gap:10px; }
  .brand-text, .account-copy { display:none; }
  .nav-link { padding:0 11px; }
}
</style>
