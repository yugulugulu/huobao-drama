<template>
  <NuxtPage />
  <Toaster position="top-right" :duration="2600" rich-colors />
</template>

<script setup lang="ts">
import { Toaster } from 'vue-sonner'
</script>

<style>
@import url('./assets/admin.css');
</style>
