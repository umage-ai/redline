<script>
  import Card from '$lib/Card.svelte';
  import EditZone from '$lib/EditZone.svelte';
  let n = $state(0);
</script>

<h1>SvelteKit fixture</h1>
<Card title="Counter">
  <button data-testid="card-action" onclick={() => n++}>Clicked {n}</button>
</Card>

<EditZone />
