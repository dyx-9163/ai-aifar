<script setup lang="ts">
import { onMounted, ref } from 'vue';

const status = ref('Starting desktop runtime...');

onMounted(async () => {
  const health = await window.desktop.health();
  status.value = `Desktop runtime ready · v${health.version}`;
});
</script>

<template>
  <main class="shell">
    <aside class="sidebar">
      <span class="brand-mark">AI</span>
      <span class="brand-name">Private AI Desktop</span>
    </aside>
    <section class="workspace">
      <p class="eyebrow">Universal desktop client</p>
      <h1>Secure local agent workspace</h1>
      <p class="status">{{ status }}</p>
    </section>
  </main>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  background: #0f1117;
  color: #f7f7f8;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  background:
    linear-gradient(90deg, #161922 0 260px, transparent 260px),
    radial-gradient(circle at 70% 20%, rgb(46 117 182 / 18%), transparent 32%),
    #0f1117;
}

.sidebar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 22px;
  border-right: 1px solid rgb(255 255 255 / 8%);
}

.brand-mark {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 8px;
  background: #f7f7f8;
  color: #111318;
  font-weight: 700;
  font-size: 12px;
}

.brand-name {
  color: #e8e8ea;
  font-size: 14px;
  font-weight: 600;
}

.workspace {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  padding: 64px;
}

.eyebrow {
  margin: 0 0 12px;
  color: #9ca3af;
  font-size: 13px;
  letter-spacing: 0;
}

h1 {
  max-width: 720px;
  margin: 0;
  color: #ffffff;
  font-size: 42px;
  line-height: 1.08;
  letter-spacing: 0;
}

.status {
  margin: 18px 0 0;
  color: #b8c0cc;
  font-size: 15px;
}
</style>
