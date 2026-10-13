<script>
  let { title, children } = $props();
</script>

<section class="card">
  <h2>{title}</h2>
  {@render children?.()}
</section>
