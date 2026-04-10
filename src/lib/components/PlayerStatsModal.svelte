<script>
  import { createEventDispatcher } from 'svelte';
  import { getGroupColor } from '$lib/groupColors.js';

  /** @type {{ id: string, name: string, number?: string|number }} */
  export let player;
  export let activeMs = 0;
  export let benchMs = 0;
  /** @type {{ positionMs: Record<string,number>, groupMs: Record<string,number> }} */
  export let positionStats = { positionMs: {}, groupMs: {} };
  /** @type {{ startMs: number, endMs: number, group: string|null }[]} */
  export let timelineSegments = [];
  export let totalGameMs = 0;
  /** @type {{ positions: { id: string, name: string, group?: string }[] } | null} */
  export let formation = null;

  const dispatch = createEventDispatcher();

  let barMode = 'timeline'; // 'grouped' | 'timeline'

  function formatDuration(ms) {
    if (!ms) return '0:00';
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  $: posEntries = Object.entries(positionStats.positionMs || {}).sort((a, b) => b[1] - a[1]);
  $: groupEntries = Object.entries(positionStats.groupMs || {}).sort((a, b) => b[1] - a[1]);

  $: barTotal = activeMs + benchMs;
  $: groupedSegments = barTotal > 0
    ? [...groupEntries, ...(benchMs > 0 ? [[null, benchMs]] : [])].filter(([, ms]) => ms > 0)
    : [];
  $: hasTimeline = timelineSegments.length > 0 && totalGameMs > 0;
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="modal-backdrop" on:click={() => dispatch('close')}>
  <div class="modal-panel" on:click|stopPropagation>
    <h2 class="stats-modal-title">#{player.number} {player.name}</h2>

    <div class="stats-row stats-total">
      <span class="stats-label">Total Field Time</span>
      <span class="stats-value active-color">{formatDuration(activeMs)}</span>
    </div>

    {#if groupedSegments.length > 0 || hasTimeline}
      {#if hasTimeline}
        <div class="bar-mode-toggle">
          <button class:active={barMode === 'timeline'} on:click={() => barMode = 'timeline'}>Timeline</button>
          <button class:active={barMode === 'grouped'} on:click={() => barMode = 'grouped'}>Grouped</button>
        </div>
      {/if}
      <div class="color-bar">
        {#if barMode === 'timeline' && hasTimeline}
          {#each timelineSegments as seg}
            <div class="bar-seg" style="width:{((seg.endMs - seg.startMs) / totalGameMs * 100).toFixed(2)}%;background:{getGroupColor(seg.group).bg};" title="{seg.group ?? 'Bench'}: {formatDuration(seg.endMs - seg.startMs)}"></div>
          {/each}
        {:else}
          {#each groupedSegments as [group, ms]}
            <div class="bar-seg" style="width:{(ms / barTotal * 100).toFixed(2)}%;background:{getGroupColor(group).bg};" title="{group ?? 'Bench'}: {formatDuration(ms)}"></div>
          {/each}
        {/if}
      </div>
    {/if}

    {#if posEntries.length > 0}
      <div class="stats-section-heading">By Position</div>
      {#each posEntries as [posId, ms]}
        {@const pos = formation?.positions.find(p => p.id === posId)}
        {@const color = getGroupColor(pos?.group)}
        <div class="stats-row">
          <span class="stats-pos-badge" style="background: {color.bg}; color: {color.text};">{pos?.name ?? posId}</span>
          <span class="stats-value">{formatDuration(ms)}</span>
        </div>
      {/each}
    {/if}

    {#if groupEntries.length > 0}
      <div class="stats-section-heading">By Position Group</div>
      {#each groupEntries as [group, ms]}
        {@const color = getGroupColor(group)}
        <div class="stats-row">
          <span class="stats-group-chip" style="background: {color.bg}; color: {color.text};">{group}</span>
          <span class="stats-value">{formatDuration(ms)}</span>
        </div>
      {/each}
    {/if}

    {#if posEntries.length === 0}
      <p class="stats-empty">No field time recorded yet.</p>
    {/if}

    <div class="modal-actions">
      <button class="btn-primary" on:click={() => dispatch('close')}>Close</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.8);
    display: flex; justify-content: center; align-items: center; z-index: 200; padding: 1rem;
  }
  .modal-panel {
    background: #111827; padding: 1.5rem; border-radius: 1rem;
    border: 1px solid #334155; width: 100%; max-width: 380px; max-height: 90vh; overflow-y: auto;
  }
  .stats-modal-title { margin: 0 0 1.25rem 0; font-size: 1.1rem; color: #f8fafc; border: none; padding: 0; }
  .stats-total { margin-bottom: 0.75rem; padding-bottom: 0.75rem; border-bottom: 1px solid #1e293b; }
  .stats-section-heading { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; font-weight: 700; margin: 0.75rem 0 0.35rem; }
  .stats-row { display: flex; justify-content: space-between; align-items: center; padding: 0.2rem 0; }
  .stats-label { color: #94a3b8; font-size: 0.9rem; }
  .stats-value { font-family: monospace; font-weight: 700; color: #cbd5e1; font-size: 0.9rem; }
  .active-color { color: #34d399; }
  .bar-mode-toggle { display: flex; background: #0f172a; border-radius: 0.4rem; padding: 0.15rem; margin-top: 0.5rem; align-self: flex-start; }
  .bar-mode-toggle button { background: transparent; border: none; color: #64748b; padding: 0.2rem 0.5rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.72rem; font-weight: 600; }
  .bar-mode-toggle button.active { background: #334155; color: #f8fafc; }
  .color-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: #0f172a; margin: 0.4rem 0 0.75rem; }
  .bar-seg { flex-shrink: 0; height: 100%; }
  .stats-pos-badge { font-size: 0.75rem; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 0.3rem; }
  .stats-group-chip { font-size: 0.8rem; font-weight: 600; padding: 0.15rem 0.6rem; border-radius: 1rem; }
  .stats-empty { color: #475569; font-size: 0.9rem; margin: 1rem 0; }
  .modal-actions { display: flex; justify-content: flex-end; margin-top: 1rem; }
  button { border: none; padding: 0.6rem 1.2rem; border-radius: 0.5rem; cursor: pointer; font-weight: 600; color: white; }
  .btn-primary { background: #2563eb; }
</style>
