import { computed, ref, type Ref } from 'vue';
import { canHandOff, handOff } from '../../src/handoff.js';

/**
 * The reactive wrapper around `src/handoff.ts`.
 *
 * The decision itself lives in the library, framework-free, because it is the
 * part worth testing and every host that hands somebody a file needs it. What
 * is here is only the part Vue requires.
 */
export function useFileHandoff(file: Ref<File | null>, title: Ref<string> | string) {
  const shareError = ref('');

  const canShareFile = computed(() =>
    canHandOff(typeof navigator === 'undefined' ? undefined : navigator, file.value),
  );

  async function share(): Promise<void> {
    const value = file.value;
    if (!value) return;
    const result = await handOff(
      navigator,
      value,
      typeof title === 'string' ? title : title.value,
    );
    shareError.value = result.error ?? '';
  }

  return { canShareFile, share, shareError };
}
