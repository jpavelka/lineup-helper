<script>
  import { createEventDispatcher } from 'svelte';
  import { doc, updateDoc } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';

  /** @type {any[]} */
  export let history = [];
  /** @type {{ id: string, name: string, number?: string|number }[]} */
  export let roster = [];
  /** @type {string|null} */
  export let gameId = null;
  export let allowEditing = false;
  /** @type {{ positions: { id: string, name: string }[] } | null} */
  export let formation = null;

  const dispatch = createEventDispatcher();

  let editingEvent = null;
  let editScorer = '';
  let editAssist = '';
  let editPlayer = '';
  let editTimestampStr = '';
  let editPauseReason = '';

  const PAUSE_REASONS = ['Halftime', 'Injury', 'Water Break', 'End of Reg.', 'Other'];

  function isPauseEvent(ev) {
    return ev?.event?.startsWith('Game Paused');
  }

  function parsePauseReason(eventName) {
    const match = eventName.match(/^Game Paused – (.+)$/);
    return match ? match[1] : '';
  }
  let expandedTimestamp = null;

  function toggleExpand(ev) {
    expandedTimestamp = expandedTimestamp === ev.timestamp ? null : ev.timestamp;
  }

  // Recalculate game times from wall-clock timestamps, then sort by game clock.
  // This ensures pause/resume times are consistent even if stored gameTimeMs were
  // corrupted by a previous bug where 'Game Paused – X' events weren't matched.
  $: sortedHistory = recalculateGameTimes([...history]).sort((a, b) =>
    (a.gameTimeMs ?? a.timestamp) - (b.gameTimeMs ?? b.timestamp)
  );

  // Enrich substitution events with entering/leaving player IDs, and goal events with running score
  $: enrichedHistory = (() => {
    let prevLineup = {};
    let mine = 0, theirs = 0;
    return sortedHistory.map(ev => {
      let enriched = ev;
      if (ev.lineupSnapshot) {
        const enters = [];
        const leaves = [];
        const allPositions = new Set([
          ...Object.keys(ev.lineupSnapshot),
          ...Object.keys(prevLineup)
        ]);
        allPositions.forEach(posId => {
          const prev = prevLineup[posId] ?? null;
          const curr = ev.lineupSnapshot[posId] ?? null;
          if (prev !== curr) {
            if (curr) enters.push({ playerId: curr, positionId: posId });
            if (prev) leaves.push({ playerId: prev, positionId: posId });
          }
        });
        prevLineup = { ...ev.lineupSnapshot };
        enriched = { ...enriched, enters, leaves };
      }
      if (ev.event === 'Goal (Us)') {
        mine += 1;
        enriched = { ...enriched, scoreAfter: { mine, theirs } };
      } else if (ev.event === 'Goal Conceded') {
        theirs += 1;
        enriched = { ...enriched, scoreAfter: { mine, theirs } };
      }
      return enriched;
    });
  })();

  function getPlayerName(playerId) {
    if (!playerId) return '';
    const player = roster.find(p => p.id === playerId);
    return player ? player.name : 'Unknown';
  }

  function getPositionName(positionId) {
    if (!formation || !positionId) return null;
    return formation.positions?.find(p => p.id === positionId)?.name ?? null;
  }

  let showClockTime = false;

  function formatDuration(ms) {
    if (!ms && ms !== 0) return '0:00';
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function formatClockTime(ts) {
    if (!ts) return '--:--';
    const d = new Date(ts);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function isEditable(ev) {
    return allowEditing;
  }

  function timestampToTimeStr(ts) {
    const d = new Date(ts);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const ss = d.getSeconds().toString().padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function timeStrToTimestamp(str, originalTs) {
    const d = new Date(originalTs);
    const parts = str.split(':').map(Number);
    d.setHours(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, 0);
    return d.getTime();
  }

  // Recompute gameTimeMs for all events based on their timestamps and the
  // session lifecycle (Game Started / Game Resumed / Game Paused / Match Ended).
  function recalculateGameTimes(history) {
    const sorted = [...history].sort((a, b) => a.timestamp - b.timestamp);
    let sessionStartTs = null;
    let accumulatedMs = 0;
    return sorted.map(ev => {
      if (ev.event === 'Game Started') {
        sessionStartTs = ev.timestamp;
        accumulatedMs = 0;
        return { ...ev, gameTimeMs: 0 };
      } else if (ev.event === 'Game Resumed') {
        sessionStartTs = ev.timestamp;
        // accumulatedMs was set by the preceding Pause event
        return { ...ev, gameTimeMs: accumulatedMs };
      } else if (isPauseEvent(ev) || ev.event === 'Match Ended') {
        if (sessionStartTs !== null) {
          accumulatedMs = accumulatedMs + (ev.timestamp - sessionStartTs);
          sessionStartTs = null;
          return { ...ev, gameTimeMs: accumulatedMs };
        }
        return ev;
      } else {
        if (sessionStartTs !== null) {
          return { ...ev, gameTimeMs: accumulatedMs + (ev.timestamp - sessionStartTs) };
        }
        return ev;
      }
    });
  }

  function adjustTimestamp(deltaSecs) {
    const current = timeStrToTimestamp(editTimestampStr, editingEvent.timestamp);
    editTimestampStr = timestampToTimeStr(current + deltaSecs * 1000);
  }

  function openEdit(ev) {
    if (!isEditable(ev)) return;
    editingEvent = { ...ev };
    editScorer = ev.playerId || '';
    editAssist = ev.assistId || '';
    editPlayer = ev.playerId || '';
    editTimestampStr = timestampToTimeStr(ev.timestamp);
    editPauseReason = isPauseEvent(ev) ? (parsePauseReason(ev.event) || 'Halftime') : '';
  }

  function hasPlayerFields(ev) {
    return ev.event === 'Goal (Us)' || ev.event === 'Yellow Card' || ev.event === 'Red Card';
  }

  async function saveEdit() {
    const idx = history.findIndex(e => e.timestamp === editingEvent.timestamp);
    if (idx === -1) { editingEvent = null; return; }

    const newTimestamp = timeStrToTimestamp(editTimestampStr, editingEvent.timestamp);
    let updated = [...history];
    let patch = { timestamp: newTimestamp };

    if (editingEvent.event === 'Goal (Us)') {
      patch.playerId = editScorer || null;
      patch.assistId = editAssist || null;
    } else if (editingEvent.event === 'Yellow Card' || editingEvent.event === 'Red Card') {
      patch.playerId = editPlayer || null;
    } else if (isPauseEvent(editingEvent)) {
      patch.event = `Game Paused – ${editPauseReason}`;
    }

    updated[idx] = { ...updated[idx], ...patch };
    updated = recalculateGameTimes(updated);

    try {
      await updateDoc(doc(db, 'games', gameId), { history: updated });
      dispatch('updated', updated);
    } catch (err) {
      console.error('Error saving event edit:', err);
    }
    editingEvent = null;
  }
</script>

<div class="timeline-header">
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="time-mode-toggle">
    <button class:active={!showClockTime} on:click={() => showClockTime = false}>Game</button>
    <button class:active={showClockTime} on:click={() => showClockTime = true}>Clock</button>
  </div>
</div>

<div class="timeline">
  {#each enrichedHistory as ev}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    {@const expanded = expandedTimestamp === ev.timestamp}
    <div
      class="timeline-item"
      class:ev-goal={ev.event === 'Goal (Us)'}
      class:ev-conceded={ev.event === 'Goal Conceded'}
      class:ev-red={ev.event === 'Red Card'}
      class:ev-yellow={ev.event === 'Yellow Card'}
      class:expanded
      on:click={() => toggleExpand(ev)}
    >
      <div class="time-marker">{showClockTime ? formatClockTime(ev.timestamp) : formatDuration(ev.gameTimeMs)}</div>
      <div class="event-content">
        <strong
          class="event-title"
          class:text-green={ev.event === 'Goal (Us)'}
          class:text-red={ev.event === 'Goal Conceded' || ev.event === 'Red Card'}
          class:text-yellow={ev.event === 'Yellow Card'}
        >{ev.event}{#if ev.scoreAfter}: <span class="score-inline">{ev.scoreAfter.mine}–{ev.scoreAfter.theirs}</span>{/if}</strong>

        {#if expanded}
          {#if ev.playerId && ev.event !== 'Substitution' && ev.event !== 'Lineup Applied'}
            <div class="event-player">{getPlayerName(ev.playerId)}</div>
          {/if}

          {#if ev.assistId}
            <div class="event-detail text-muted">Assist: {getPlayerName(ev.assistId)}</div>
          {/if}

          {#if ev.enters?.length || ev.leaves?.length}
            <div class="sub-details">
              {#each ev.enters as sub}
                {@const posName = getPositionName(sub.positionId)}
                <span class="sub-enter">↑ {getPlayerName(sub.playerId)}{#if posName}&nbsp;<span class="sub-pos">({posName})</span>{/if}</span>
              {/each}
              {#each ev.leaves as sub}
                {@const posName = getPositionName(sub.positionId)}
                <span class="sub-leave">↓ {getPlayerName(sub.playerId)}{#if posName}&nbsp;<span class="sub-pos">({posName})</span>{/if}</span>
              {/each}
            </div>
          {/if}

          {#if allowEditing}
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
            <span class="edit-btn" on:click|stopPropagation={() => openEdit(ev)}>Edit</span>
          {/if}
        {/if}
      </div>
    </div>
  {/each}

  {#if enrichedHistory.length === 0}
    <p class="empty-msg">No events recorded yet.</p>
  {/if}
</div>

{#if editingEvent}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => editingEvent = null}>
    <div class="modal-panel" on:click|stopPropagation>
      <h3>Edit: {editingEvent.event}</h3>
      <div class="form-group">
        <label for="edit-timestamp">Event Time</label>
        <input id="edit-timestamp" type="time" step="1" bind:value={editTimestampStr} />
        <div class="time-adjust-btns">
          <button class="btn-adjust" on:click={() => adjustTimestamp(-60)}>-1:00</button>
          <button class="btn-adjust" on:click={() => adjustTimestamp(-15)}>-0:15</button>
          <button class="btn-adjust" on:click={() => adjustTimestamp(15)}>+0:15</button>
          <button class="btn-adjust" on:click={() => adjustTimestamp(60)}>+1:00</button>
        </div>
      </div>
      {#if isPauseEvent(editingEvent)}
        <div class="form-group">
          <span class="form-label">Pause Reason</span>
          <div class="pause-reason-list">
            {#each PAUSE_REASONS as reason}
              <button
                class="pause-reason-btn"
                class:selected={editPauseReason === reason}
                on:click={() => editPauseReason = reason}
              >{reason}</button>
            {/each}
          </div>
        </div>
      {/if}
      {#if hasPlayerFields(editingEvent)}
        {#if editingEvent.event === 'Goal (Us)'}
          <div class="form-group">
            <label for="edit-scorer">Goal Scorer</label>
            <select id="edit-scorer" bind:value={editScorer}>
              <option value="">-- None --</option>
              {#each roster as p}<option value={p.id}>{p.name}</option>{/each}
            </select>
          </div>
          <div class="form-group">
            <label for="edit-assist">Assist</label>
            <select id="edit-assist" bind:value={editAssist}>
              <option value="">-- None --</option>
              {#each roster as p}<option value={p.id}>{p.name}</option>{/each}
            </select>
          </div>
        {:else}
          <div class="form-group">
            <label for="edit-player">Player</label>
            <select id="edit-player" bind:value={editPlayer}>
              <option value="">-- None --</option>
              {#each roster as p}<option value={p.id}>{p.name}</option>{/each}
            </select>
          </div>
        {/if}
      {/if}
      <div class="modal-actions">
        <button class="btn-secondary" on:click={() => editingEvent = null}>Cancel</button>
        <button class="btn-primary" on:click={saveEdit}>Save</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .timeline-header { display: flex; justify-content: flex-end; margin-bottom: 0.5rem; }
  .time-mode-toggle { display: flex; background: #1e293b; border-radius: 0.4rem; padding: 0.15rem; }
  .time-mode-toggle button { background: transparent; border: none; color: #64748b; padding: 0.2rem 0.6rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.75rem; font-weight: 600; }
  .time-mode-toggle button.active { background: #334155; color: #f8fafc; }
  .timeline { display: flex; flex-direction: column; gap: 0.75rem; }

  .timeline-item {
    display: flex; gap: 1rem; background: #0f172a; padding: 0.75rem;
    border-radius: 0.75rem; border-left: 4px solid #3b82f6;
  }
  .timeline-item { cursor: pointer; }
  .timeline-item:hover { background: #1a2744; }
  .timeline-item.expanded { background: #1a2744; }
  .timeline-item.ev-goal  { border-left-color: #10b981; }
  .timeline-item.ev-conceded { border-left-color: #ef4444; }
  .timeline-item.ev-red   { border-left-color: #ef4444; }
  .timeline-item.ev-yellow { border-left-color: #facc15; }

  .time-marker {
    font-family: monospace; font-weight: bold; color: #cbd5e1;
    background: #1e293b; padding: 0.25rem 0.5rem; border-radius: 0.25rem;
    height: fit-content; white-space: nowrap; flex-shrink: 0;
  }
  .event-content { display: flex; flex-direction: column; gap: 0.15rem; flex: 1; }
  .event-title { font-size: 0.95rem; }
  .event-player { color: #f8fafc; font-weight: 500; font-size: 0.9rem; }
  .event-detail { font-size: 0.85rem; }
  .text-green { color: #34d399; }
  .text-red   { color: #ef4444; }
  .text-yellow { color: #facc15; }
  .text-muted { color: #94a3b8; }

  .sub-details { display: flex; flex-direction: column; gap: 0.15rem; margin-top: 0.1rem; }
  .sub-enter { color: #34d399; font-size: 0.85rem; font-weight: 500; }
  .sub-leave { color: #f87171; font-size: 0.85rem; font-weight: 500; }
  .sub-pos { font-weight: 400; opacity: 0.75; }

  .score-inline { font-family: monospace; font-weight: 700; opacity: 0.85; }
  .edit-btn { display: inline-block; margin-top: 0.35rem; font-size: 0.72rem; font-weight: 600; color: #60a5fa; cursor: pointer; }
  .edit-btn:hover { text-decoration: underline; }
  .empty-msg { color: #475569; text-align: center; padding: 1.5rem 0; margin: 0; font-size: 0.9rem; }

  /* Modal */
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.8);
    display: flex; justify-content: center; align-items: center; z-index: 200; padding: 1rem;
  }
  .modal-panel {
    background: #111827; padding: 1.5rem; border-radius: 1rem;
    border: 1px solid #334155; width: 100%; max-width: 380px;
  }
  .modal-panel h3 { margin: 0 0 1rem 0; color: #e2e8f0; }
  .form-group { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
  .form-group label { color: #cbd5e1; font-size: 0.9rem; }
  .form-label { color: #cbd5e1; font-size: 0.9rem; }
  .form-group select, .form-group input[type="time"] {
    background: #0f172a; border: 1px solid #334155; color: white;
    padding: 0.75rem; border-radius: 0.5rem; font-size: 1rem; outline: none;
    font-family: monospace;
  }
  .form-group input[type="time"]:focus { border-color: #3b82f6; }
  .time-adjust-btns { display: flex; gap: 0.4rem; }
  .btn-adjust { background: #1e293b; border: 1px solid #334155; color: #cbd5e1; font-size: 0.8rem; padding: 0.3rem 0.6rem; border-radius: 0.4rem; cursor: pointer; font-family: monospace; flex: 1; }
  .btn-adjust:hover { background: #334155; }
  .pause-reason-list { display: flex; flex-direction: column; gap: 0.4rem; }
  .pause-reason-btn { background: #1e293b; border: 1px solid #334155; color: #cbd5e1; padding: 0.55rem 0.75rem; border-radius: 0.4rem; cursor: pointer; font-size: 0.9rem; text-align: left; font-weight: 400; }
  .pause-reason-btn:hover { background: #334155; }
  .pause-reason-btn.selected { border-color: #3b82f6; background: rgba(59,130,246,0.15); color: #f8fafc; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 1rem; margin-top: 1rem; }
  button { border: none; padding: 0.6rem 1.2rem; border-radius: 0.5rem; cursor: pointer; font-weight: 600; color: white; }
  .btn-primary { background: #2563eb; }
  .btn-secondary { background: #334155; }
</style>
