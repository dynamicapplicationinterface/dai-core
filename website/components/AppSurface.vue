<script setup lang="ts">
/**
 * The surface an application inside a container is given: the calls, and the
 * custom properties a host sets on its root.
 *
 * Rendered from the same constants the recipe teaches and the MCP server hands
 * a model, for the reason the recipe page gives — a reference that drifted
 * from what the model was told would be worse than no reference, because the
 * reader could not tell which one was true.
 */
import { API, CSS_VARS } from '../../src/recipe.js';
</script>

<template>
  <table class="surface">
    <tbody>
      <tr v-for="entry in API" :key="entry.call">
        <td><code>{{ entry.call }}</code></td>
        <td>{{ entry.does }}</td>
      </tr>
    </tbody>
  </table>

  <h2 id="the-screen">The screen</h2>
  <p>
    A host draws an application edge to edge — under a phone's status bar at the
    top and its home indicator at the bottom — and sets these on the
    application's own root element. They are zero on a screen with nothing in
    the way, which is what the fallback in each <code>var()</code> is for.
  </p>

  <table class="surface">
    <tbody>
      <tr v-for="entry in CSS_VARS" :key="entry.name">
        <td><code>{{ entry.name }}</code></td>
        <td>{{ entry.is }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.surface { width: 100%; border-collapse: collapse; font-size: 14px; display: table; }
.surface td { padding: 9px 0; border-top: 1px solid var(--vp-c-divider); vertical-align: top; }
.surface td:first-child { width: 44%; padding-right: 20px; }
.surface code { font-size: 12.5px; }
</style>
