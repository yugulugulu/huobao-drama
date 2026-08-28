<template>
  <div class="auth-shell">
    <header class="auth-brand">
      <img :src="brandLogo" alt="火宝短剧" />
      <div><strong>火宝短剧</strong><span>Huobao Shorts</span></div>
    </header>
    <main class="auth-main"><slot /></main>
    <div class="auth-visual" aria-hidden="true">
      <div class="frame frame-one"></div><div class="frame frame-two"></div><div class="frame frame-three"></div>
      <div class="timeline"><span></span><span></span><span></span><span></span><span></span></div>
    </div>
  </div>
</template>

<script setup>
import brandLogo from '~/assets/huobao-logo.png'
</script>

<style scoped>
.auth-shell { min-height:100svh; position:relative; overflow:hidden; display:grid; grid-template-columns:minmax(340px,520px) 1fr; background:#f7f7f9; color:#17171b; }
.auth-brand { position:absolute; z-index:2; top:28px; left:34px; display:flex; align-items:center; gap:11px; }
.auth-brand img { width:34px; height:34px; object-fit:contain; background:#17171b; border-radius:8px; padding:5px; }
.auth-brand div { display:flex; flex-direction:column; line-height:1.15; }
.auth-brand strong { font-size:15px; }.auth-brand span { margin-top:2px; color:#8a8a93; font-size:10px; }
.auth-main { z-index:1; display:flex; align-items:center; justify-content:center; padding:96px 56px 56px; background:#fff; border-right:1px solid #e7e7eb; }
.auth-visual { position:relative; min-width:0; background:#1b1b1f; overflow:hidden; }
.frame { position:absolute; width:42%; aspect-ratio:16/10; border:1px solid rgba(255,255,255,.16); background:linear-gradient(145deg,#303039,#1f2025); box-shadow:0 24px 70px rgba(0,0,0,.35); animation:enter .7s cubic-bezier(.2,.8,.2,1) both; }
.frame::after { content:""; position:absolute; inset:14%; border:1px solid rgba(255,255,255,.09); }
.frame-one { left:12%; top:18%; }.frame-two { right:10%; top:34%; animation-delay:.1s }.frame-three { left:24%; bottom:14%; animation-delay:.2s }
.timeline { position:absolute; left:9%; right:9%; bottom:7%; height:3px; display:grid; grid-template-columns:repeat(5,1fr); gap:5px; }
.timeline span { background:#494951; }.timeline span:nth-child(3) { background:#f05a28; }
@keyframes enter { from { opacity:0; transform:translateY(18px) scale(.98) } to { opacity:1; transform:none } }
@media (max-width:800px) { .auth-shell { display:block; background:#fff; }.auth-main { min-height:100svh; border:0; padding:100px 24px 44px; }.auth-visual { display:none; }.auth-brand { left:24px; top:24px; } }
@media (prefers-reduced-motion:reduce) { .frame { animation:none; } }
</style>
