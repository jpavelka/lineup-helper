<script>
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { doc, getDoc, updateDoc } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { generateUUID } from '$lib/utils.js';

  const formId = $page.params.formId;

  let formation = null;
  let loading = true;
  let saveStatus = '';

  let draggedPos = null;

  onMount(async () => {
    await loadFormation();
  });

  async function loadFormation() {
    try {
      const docSnap = await getDoc(doc(db, 'formations', formId));
      if (docSnap.exists()) {
        formation = docSnap.data();
      }
    } catch (e) {
      console.error("Error loading formation:", e);
    } finally {
      loading = false;
    }
  }

  let saveTimeout;
  function scheduleSave() {
    saveStatus = 'Saving...';
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        await updateDoc(doc(db, 'formations', formId), formation);
        saveStatus = 'All changes saved.';
        setTimeout(() => saveStatus = '', 2000);
      } catch (e) {
        saveStatus = 'Error saving.';
        console.error("Save error:", e);
      }
    }, 1000); // Debounce saves by 1 second
  }

  function startDrag(pos) {
    draggedPos = pos;
  }

  function onDrag(event) {
    if (!draggedPos) return;
    const rect = event.currentTarget.getBoundingClientRect();
    let x = ((event.clientX - rect.left) / rect.width) * 100;
    let y = ((event.clientY - rect.top) / rect.height) * 100;
    x = Math.max(0, Math.min(100, x));
    y = Math.max(0, Math.min(100, y));

    formation.positions = formation.positions.map(p => 
      p.id === draggedPos.id ? { ...p, x, y } : p
    );
  }

  function stopDrag() {
    if (draggedPos) {
      draggedPos = null;
      scheduleSave();
    }
  }

  function addPosition() {
    formation.positions = [...formation.positions, { 
      id: generateUUID(), name: 'NEW', group: 'MID', x: 50, y: 50 
    }];
    scheduleSave();
  }
</script>

<svelte:window on:pointerup={stopDrag} />

<svelte:head>
  <title>Edit Formation | {formation?.name || ''}</title>
</svelte:head>

{#if loading}
  <p class="muted">Loading Formation Editor...</p>
{:else if formation}
  <div class="formation-builder">
    <header>
      <div class="title-group">
        <a href="/formations" class="back-link">← All Formations</a>
        <input class="name-input" bind:value={formation.name} on:change={scheduleSave} />
      </div>
      <div class="controls">
        <span class="save-status">{saveStatus}</span>
        <button class="primary" on:click={addPosition}>+ Add Position</button>
      </div>
    </header>

    <div class="field-container" on:pointermove={onDrag}>
      <div class="field-lines">
        <div class="center-circle"></div>
        <div class="penalty-arc top"></div>
        <div class="penalty-arc bottom"></div>
        <div class="penalty-box top"></div>
        <div class="penalty-box bottom"></div>
        <div class="goal-box top"></div>
        <div class="goal-box bottom"></div>
      </div>

      {#each formation.positions as pos (pos.id)}
        <div 
          class="position-node"
          class:dragging={draggedPos?.id === pos.id}
          style="left: {pos.x}%; top: {pos.y}%;"
          on:pointerdown|preventDefault={() => startDrag(pos)}
        >
          <div class="node-label">{pos.name}</div>
          <div class="node-group">{pos.group}</div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .formation-builder { padding: 1rem; max-width: 800px; margin: 0 auto; color: white;}
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: 1rem;}
  .title-group { display: flex; flex-direction: column; gap: 0.25rem; }
  .back-link { color: #3b82f6; text-decoration: none; font-size: 0.9rem; }
  .name-input { background: transparent; border: none; color: white; font-size: 1.75rem; font-weight: bold; padding: 0; }
  .name-input:focus { outline: none; }
  .controls { display: flex; align-items: center; gap: 1rem; }
  .save-status { font-size: 0.85rem; color: #10b981; font-style: italic; }
  .primary { background: #2563eb; color: white; border: none; padding: 0.5rem 1rem; border-radius: 0.5rem; cursor: pointer; }

  /* Field and Node styles remain the same as before */
  .field-container { position: relative; width: 100%; max-width: 400px; margin: 0 auto; aspect-ratio: 2 / 3; background: #166534; border: 3px solid #fff; border-radius: 8px; overflow: hidden; touch-action: none; }
  .field-lines { position: absolute; inset: 0; pointer-events: none; }
  .field-lines::before { content: ''; position: absolute; top: 50%; left: 0; right: 0; height: 2px; background: white; }
  .center-circle { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 25%; aspect-ratio: 1; border: 2px solid white; border-radius: 50%; }
  .penalty-box { position: absolute; width: 50%; height: 15%; border: 2px solid white; left: 25%; }
  .penalty-box.top { top: 0; border-top: none; }
  .penalty-box.bottom { bottom: 0; border-bottom: none; }
  .goal-box { position: absolute; width: 25%; height: 5%; border: 2px solid white; left: 37.5%; }
  .goal-box.top { top: 0; border-top: none; }
  .goal-box.bottom { bottom: 0; border-bottom: none; }
  .penalty-arc { position: absolute; width: 25%; aspect-ratio: 1; border: 2px solid white; border-radius: 50%; left: 37.5%; }
  .penalty-arc.top { top: 11%; transform: translateY(-50%); clip-path: inset(74% 0 0 0); }
  .penalty-arc.bottom { bottom: 11%; transform: translateY(50%); clip-path: inset(0 0 74% 0); }
  .position-node { position: absolute; transform: translate(-50%, -50%); background: #334155; border: 2px solid #94a3b8; color: white; width: 2.5rem; height: 2.5rem; border-radius: 50%; display: flex; flex-direction: column; justify-content: center; align-items: center; cursor: grab; user-select: none; box-shadow: 0 4px 6px rgba(0,0,0,0.3); transition: transform 0.1s, box-shadow 0.1s; }
  .position-node.dragging { cursor: grabbing; transform: translate(-50%, -50%) scale(1.1); box-shadow: 0 10px 15px rgba(0,0,0,0.5); z-index: 10; border-color: #3b82f6; }
  .node-label { font-weight: bold; font-size: 0.8rem; }
  .node-group { font-size: 0.55rem; color: #cbd5e1; }
  .muted { color: #94a3b8; }
</style>