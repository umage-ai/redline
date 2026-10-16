<script setup>
defineProps({ title: String });
</script>

<template>
  <section class="card">
    <h2>{{ title }}</h2>
    <slot />
  </section>
</template>
