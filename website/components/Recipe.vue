<script setup lang="ts">
/**
 * Publishes the recipe the MCP server gives a model, so a person working with
 * an assistant that has no MCP connection can hand over the same instructions.
 *
 * Rendered from the shared source rather than restated in markdown: a page that
 * drifted from the tool description would be worse than no page, because the
 * reader would have no way of knowing which one the model was following.
 */
import { ref } from 'vue';
import { API, RECIPE, RECIPE_AS_PROMPT } from '../../src/recipe.js';

const copied = ref(false);

async function copy(): Promise<void> {
  await navigator.clipboard.writeText(RECIPE_AS_PROMPT);
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}
</script>

<template>
  <div class="recipe">
    <div class="bar">
      <button @click="copy">{{ copied ? 'Copied' : 'Copy the recipe' }}</button>
      <span class="hint">Paste it into ChatGPT, Claude or Gemini, then say what you want.</span>
    </div>

    <pre><code>{{ RECIPE }}</code></pre>

    <h2>The storage API</h2>
    <table class="api">
      <tbody>
        <tr v-for="entry in API" :key="entry.call">
          <td><code>{{ entry.call }}</code></td>
          <td>{{ entry.does }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.recipe { margin: 24px 0; }
.bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.hint { font-size: 13px; color: var(--vp-c-text-2); }
button {
  padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 14px;
  color: var(--vp-c-white); background: var(--vp-c-brand-1); border: 1px solid var(--vp-c-brand-1);
}
pre {
  max-height: 460px; overflow: auto; padding: 16px; border-radius: 10px;
  background: var(--vp-c-bg-alt); border: 1px solid var(--vp-c-divider);
  font-size: 12.5px; line-height: 1.55; white-space: pre-wrap;
}
.api { width: 100%; border-collapse: collapse; font-size: 14px; }
.api td { padding: 9px 0; border-top: 1px solid var(--vp-c-divider); vertical-align: top; }
.api td:first-child { width: 44%; padding-right: 20px; }
.api code { font-size: 12.5px; white-space: nowrap; }
</style>
