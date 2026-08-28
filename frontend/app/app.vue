<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <Toaster position="top-right" :duration="3000" />
</template>

<script setup>
import { Toaster } from 'vue-sonner'
</script>

<style>
@import url('./assets/studio.css');

/* 通知容器在移动端使用 right 定位时会产生 16px 的无内容横向溢出。 */
[data-sonner-toaster] { max-width: calc(100vw - 32px); }
</style>
