<script setup>
import { ref } from 'vue';
import Card from './Card.vue';
import EditZone from './EditZone.vue';

const n = ref(0);
</script>

<template>
  <main>
    <h1>Vue fixture</h1>
    <Card title="Counter">
      <button data-testid="card-action" @click="n++">Clicked {{ n }}</button>
    </Card>
    <EditZone />
  </main>
</template>
