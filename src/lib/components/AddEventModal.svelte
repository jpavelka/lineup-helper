<script>
  import { createEventDispatcher } from 'svelte';
  import { doc, updateDoc } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';

  /** @type {{ id: string, name: string, number?: string|number }[]} */
  export let roster = [];
  /** @type {any[]} */
  export let history = [];
  export let gameId = '';
  export const score = { mine: 0, theirs: 0 };
  export let totalGameMs = 0;
  /** @type {{ id: string, name: string, positions: { id: string, name: string, group?: string }[] } | null} */
  export let formation = null;

  const dispatch = createEventDispatcher();

  const PAUSE_REASONS = ['Halftime', 'Injury', 'Water Break', 'End of Reg.', 'Other'];

  let eventType = 'goal'; // 'goal' | 'card' | 'pause' | 'sub'
  let goalTeam = 'mine';
  let scorer = '';
  let assist = '';
  let cardType = 'yellow';
  let cardPlayer = '';
  let pauseReason = 'Halftime';
  let swaps = [{ playerOut: '', playerIn: '' }];
  let gameMinsInput = '';
  let saving = false;
  let error = '';

  $: sortedRoster = [...roster].sort((a, b) => a.name.localeCompare(b.name));

  function formatDuration(ms) {
    if (!ms || ms < 0) return '0:00';
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function parseGameTime(str) {
    const trimmed = str.trim();
    if (!trimmed) return null;
    if (trimmed.includes(':')) {
      const [mStr, sStr] = trimmed.split(':');
      return (parseInt(mStr) || 0) * 60000 + (parseInt(sStr) || 0) * 1000;
    }
    return Math.round((parseFloat(trimmed) || 0) * 60000);
  }

  // Walk history to find the most recent lineupSnapshot at or before targetMs.
  function getLineupAtGameTime(targetMs, hist) {
    const sorted = [...hist].sort((a, b) => {
      const ams = a.gameTimeMs ?? 0, bms = b.gameTimeMs ?? 0;
      if (ams !== bms) return ams - bms;
      if (a.lineupSnapshot && !b.lineupSnapshot) return -1;
      if (!a.lineupSnapshot && b.lineupSnapshot) return 1;
      return 0;
    });
    let lineup = {};
    for (const ev of sorted) {
      if ((ev.gameTimeMs ?? 0) > targetMs) break;
      if (ev.lineupSnapshot) lineup = { ...ev.lineupSnapshot };
    }
    return lineup;
  }

  // Compute wall-clock timestamp from a target game time (ms),
  // by inverting the session timeline stored in history.
  function gameTimeToTimestamp(targetMs, hist) {
    const sorted = [...hist].sort((a, b) => a.timestamp - b.timestamp);
    let sessionStartTs = null;
    let accumulatedMs = 0;

    for (const ev of sorted) {
      if (ev.event === 'Game Started') {
        sessionStartTs = ev.timestamp;
        accumulatedMs = 0;
      } else if (ev.event === 'Game Resumed') {
        sessionStartTs = ev.timestamp;
      } else if (ev.event?.startsWith('Game Paused') || ev.event === 'Match Ended') {
        if (sessionStartTs !== null) {
          const sessionEndMs = accumulatedMs + (ev.timestamp - sessionStartTs);
          if (targetMs <= sessionEndMs) {
            return sessionStartTs + (targetMs - accumulatedMs);
          }
          accumulatedMs = sessionEndMs;
          sessionStartTs = null;
        }
      }
    }

    if (sessionStartTs !== null) {
      return sessionStartTs + (targetMs - accumulatedMs);
    }

    return Date.now();
  }

  $: targetMs = parseGameTime(gameMinsInput) ?? 0;
  $: lineupAtTime = getLineupAtGameTime(targetMs, history);
  $: onFieldIds = new Set(Object.values(lineupAtTime).filter(Boolean));
  $: onFieldPlayers = roster.filter(p => onFieldIds.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  $: benchPlayers = roster.filter(p => !onFieldIds.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));

  // Map playerId → position name for on-field players
  $: playerPositionName = (() => {
    const map = {};
    for (const [posId, playerId] of Object.entries(lineupAtTime)) {
      if (playerId) map[playerId] = formation?.positions.find(p => p.id === posId)?.name ?? null;
    }
    return map;
  })();

  // Per-row available options, excluding players already selected in other rows
  $: usedOutIds = new Set(swaps.map(s => s.playerOut).filter(Boolean));
  $: usedInIds = new Set(swaps.map(s => s.playerIn).filter(Boolean));
  $: swapOptions = swaps.map(swap => {
    // Players blocked from appearing as "on" for this row: used as out elsewhere,
    // used as in elsewhere, or the same player going off in this row.
    const blockedIn = new Set([
      ...([...usedOutIds].filter(id => id !== swap.playerOut)),
      ...([...usedInIds].filter(id => id !== swap.playerIn)),
      swap.playerOut,
    ].filter(Boolean));
    const availableIn = roster
      .filter(p => !blockedIn.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      outPlayers: onFieldPlayers.filter(p => !usedOutIds.has(p.id) || p.id === swap.playerOut),
      benchInPlayers: availableIn.filter(p => !onFieldIds.has(p.id)),
      fieldInPlayers: availableIn.filter(p => onFieldIds.has(p.id)),
    };
  });

  function addSwap() {
    swaps = [...swaps, { playerOut: '', playerIn: '' }];
  }

  function removeSwap(i) {
    swaps = swaps.filter((_, j) => j !== i);
  }

  async function save() {
    error = '';
    const targetMs = parseGameTime(gameMinsInput);
    if (targetMs === null) { error = 'Enter a game time (e.g. 35 or 35:30).'; return; }
    if (targetMs < 0) { error = 'Game time cannot be negative.'; return; }
    if (targetMs > totalGameMs + 5000) {
      error = `Game time exceeds total game length (${formatDuration(totalGameMs)}).`;
      return;
    }

    if (eventType === 'sub' && !swaps.some(s => s.playerOut)) {
      error = 'Select at least one player coming off.';
      return;
    }

    const timestamp = gameTimeToTimestamp(targetMs, history);
    const ev = { timestamp, gameTimeMs: targetMs };

    if (eventType === 'goal') {
      if (goalTeam === 'mine') {
        ev.event = 'Goal (Us)';
        ev.type = 'goal';
        if (scorer) ev.playerId = scorer;
        if (assist) ev.assistId = assist;
      } else {
        ev.event = 'Goal Conceded';
        ev.type = 'goal';
      }
    } else if (eventType === 'card') {
      ev.event = cardType === 'yellow' ? 'Yellow Card' : 'Red Card';
      ev.type = 'card';
      if (cardPlayer) ev.playerId = cardPlayer;
    } else if (eventType === 'pause') {
      ev.event = `Game Paused – ${pauseReason}`;
    } else if (eventType === 'sub') {
      const newLineup = { ...lineupAtTime };
      for (const swap of swaps) {
        if (!swap.playerOut) continue;
        const outPosId = Object.keys(lineupAtTime).find(k => lineupAtTime[k] === swap.playerOut);
        if (!outPosId) continue;
        if (swap.playerIn && onFieldIds.has(swap.playerIn)) {
          // Position swap: exchange the two players' spots
          const inPosId = Object.keys(lineupAtTime).find(k => lineupAtTime[k] === swap.playerIn);
          if (inPosId) { newLineup[outPosId] = swap.playerIn; newLineup[inPosId] = swap.playerOut; }
        } else {
          // Standard sub (or injury removal)
          newLineup[outPosId] = swap.playerIn || null;
        }
      }
      ev.event = 'Substitution';
      ev.lineupSnapshot = newLineup;
      ev.formationId = formation?.id ?? null;
      ev.formationName = formation?.name ?? null;
    }

    const newHistory = [...history, ev];

    let mine = 0, theirs = 0;
    newHistory.forEach(e => {
      if (e.event === 'Goal (Us)') mine++;
      else if (e.event === 'Goal Conceded') theirs++;
    });
    const newScore = { mine, theirs };

    saving = true;
    try {
      await updateDoc(doc(db, 'games', gameId), { history: newHistory, score: newScore });
      dispatch('saved', { history: newHistory, score: newScore });
    } catch (err) {
      console.error('Error adding event:', err);
      error = 'Failed to save. Please try again.';
    } finally {
      saving = false;
    }
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="modal-backdrop" on:click={() => dispatch('close')}>
  <div class="modal-panel" on:click|stopPropagation>
    <h3>Add Event</h3>
    <p class="hint">Total game length: {formatDuration(totalGameMs)}</p>

    <div class="form-group">
      <label for="ae-gametime">Game Time (MM:SS or minutes)</label>
      <input
        id="ae-gametime"
        type="text"
        placeholder="e.g. 35 or 35:30"
        bind:value={gameMinsInput}
        autocomplete="off"
      />
    </div>

    <div class="form-group">
      <label for="ae-type">Event Type</label>
      <select id="ae-type" bind:value={eventType}>
        <option value="goal">Goal</option>
        <option value="card">Card</option>
        <option value="sub">Substitution</option>
        <option value="pause">Pause</option>
      </select>
    </div>

    {#if eventType === 'goal'}
      <div class="form-group">
        <label for="ae-team">Team</label>
        <select id="ae-team" bind:value={goalTeam}>
          <option value="mine">Our Team</option>
          <option value="theirs">Opponent</option>
        </select>
      </div>
      {#if goalTeam === 'mine'}
        <div class="form-group">
          <label for="ae-scorer">Goal Scorer (optional)</label>
          <select id="ae-scorer" bind:value={scorer}>
            <option value="">-- None --</option>
            {#each sortedRoster as p}<option value={p.id}>{p.name}</option>{/each}
          </select>
        </div>
        <div class="form-group">
          <label for="ae-assist">Assist (optional)</label>
          <select id="ae-assist" bind:value={assist}>
            <option value="">-- None --</option>
            {#each sortedRoster as p}<option value={p.id}>{p.name}</option>{/each}
          </select>
        </div>
      {/if}
    {:else if eventType === 'card'}
      <div class="form-group">
        <label for="ae-card">Card Type</label>
        <select id="ae-card" bind:value={cardType}>
          <option value="yellow">Yellow Card</option>
          <option value="red">Red Card</option>
        </select>
      </div>
      <div class="form-group">
        <label for="ae-cardplayer">Player (optional)</label>
        <select id="ae-cardplayer" bind:value={cardPlayer}>
          <option value="">-- None --</option>
          {#each sortedRoster as p}<option value={p.id}>{p.name}</option>{/each}
        </select>
      </div>
    {:else if eventType === 'sub'}
      {#if onFieldPlayers.length === 0 && !gameMinsInput.trim()}
        <p class="sub-hint">Enter a game time above to see who was on the field.</p>
      {:else}
        <div class="swap-header">
          <span class="swap-col-label">Off</span>
          <span class="swap-arrow-spacer"></span>
          <span class="swap-col-label">On</span>
          <span class="swap-remove-spacer"></span>
        </div>
        {#each swaps as swap, i}
          <div class="swap-row">
            <select
              class="swap-select"
              bind:value={swap.playerOut}
              on:change={() => swaps = swaps}
            >
              <option value="">-- Select --</option>
              {#each swapOptions[i]?.outPlayers ?? [] as p}
                <option value={p.id}>{p.name}{playerPositionName[p.id] ? ` (${playerPositionName[p.id]})` : ''}</option>
              {/each}
            </select>
            <span class="swap-arrow">→</span>
            <select
              class="swap-select"
              bind:value={swap.playerIn}
              on:change={() => swaps = swaps}
            >
              <option value="">None</option>
              {#if (swapOptions[i]?.benchInPlayers?.length ?? 0) > 0}
                <optgroup label="From bench">
                  {#each swapOptions[i].benchInPlayers as p}
                    <option value={p.id}>{p.name}</option>
                  {/each}
                </optgroup>
              {/if}
              {#if (swapOptions[i]?.fieldInPlayers?.length ?? 0) > 0}
                <optgroup label="Swap positions with">
                  {#each swapOptions[i].fieldInPlayers as p}
                    <option value={p.id}>{p.name}{playerPositionName[p.id] ? ` (${playerPositionName[p.id]})` : ''}</option>
                  {/each}
                </optgroup>
              {/if}
            </select>
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
            <span
              class="swap-remove"
              class:hidden={swaps.length === 1}
              on:click={() => removeSwap(i)}
              title="Remove"
            >✕</span>
          </div>
        {/each}
        <button class="btn-add-swap" on:click={addSwap}>+ Add another</button>
      {/if}
    {:else if eventType === 'pause'}
      <div class="form-group">
        <span class="form-label">Pause Reason</span>
        <div class="pause-reason-list">
          {#each PAUSE_REASONS as reason}
            <button
              class="pause-reason-btn"
              class:selected={pauseReason === reason}
              on:click={() => pauseReason = reason}
            >{reason}</button>
          {/each}
        </div>
      </div>
    {/if}

    {#if error}
      <p class="error-msg">{error}</p>
    {/if}

    <div class="modal-actions">
      <button class="btn-secondary" on:click={() => dispatch('close')}>Cancel</button>
      <button class="btn-primary" on:click={save} disabled={saving}>
        {saving ? 'Saving…' : 'Add Event'}
      </button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal-panel {
    background: #1e293b; border-radius: 0.75rem; padding: 1.5rem;
    width: min(460px, 92vw); max-height: 90vh; overflow-y: auto;
    display: flex; flex-direction: column; gap: 0;
  }
  h3 { margin: 0 0 0.25rem 0; font-size: 1.1rem; color: #f8fafc; }
  .hint { margin: 0 0 1rem 0; font-size: 0.8rem; color: #64748b; }
  .sub-hint { font-size: 0.82rem; color: #64748b; margin: 0 0 1rem 0; }
  .form-group { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 1rem; }
  label, .form-label { font-size: 0.8rem; color: #94a3b8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  input, select {
    background: #0f172a; border: 1px solid #334155; border-radius: 0.4rem;
    color: #f8fafc; padding: 0.5rem 0.75rem; font-size: 0.9rem; width: 100%; box-sizing: border-box;
  }
  input:focus, select:focus { outline: none; border-color: #3b82f6; }

  /* Substitution rows */
  .swap-header {
    display: grid; grid-template-columns: 1fr 1.2rem 1fr 1.4rem;
    gap: 0.4rem; align-items: center; margin-bottom: 0.3rem;
  }
  .swap-col-label { font-size: 0.75rem; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .swap-arrow-spacer, .swap-remove-spacer { display: block; }
  .swap-row {
    display: grid; grid-template-columns: 1fr 1.2rem 1fr 1.4rem;
    gap: 0.4rem; align-items: center; margin-bottom: 0.5rem;
  }
  .swap-select { min-width: 0; }
  .swap-arrow { color: #475569; font-size: 0.9rem; text-align: center; }
  .swap-remove {
    color: #475569; font-size: 0.8rem; cursor: pointer; text-align: center;
    padding: 0.2rem; border-radius: 0.25rem;
  }
  .swap-remove:hover { color: #f87171; background: #1e293b; }
  .swap-remove.hidden { visibility: hidden; pointer-events: none; }
  .btn-add-swap {
    background: none; border: 1px dashed #334155; color: #64748b;
    border-radius: 0.4rem; padding: 0.35rem 0.75rem; font-size: 0.8rem;
    cursor: pointer; width: 100%; margin-bottom: 1rem;
  }
  .btn-add-swap:hover { border-color: #64748b; color: #94a3b8; }

  .pause-reason-list { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .pause-reason-btn {
    background: #0f172a; border: 1px solid #334155; border-radius: 0.4rem;
    color: #94a3b8; padding: 0.35rem 0.75rem; font-size: 0.8rem; cursor: pointer;
  }
  .pause-reason-btn.selected { background: #1d4ed8; border-color: #3b82f6; color: #f8fafc; }
  .pause-reason-btn:hover:not(.selected) { border-color: #64748b; color: #f8fafc; }
  .error-msg { color: #f87171; font-size: 0.82rem; margin: 0 0 0.75rem 0; }
  .modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 0.5rem; }
  .btn-primary {
    background: #1d4ed8; color: #f8fafc; border: none; border-radius: 0.4rem;
    padding: 0.5rem 1rem; font-size: 0.875rem; font-weight: 600; cursor: pointer;
  }
  .btn-primary:hover:not(:disabled) { background: #2563eb; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary {
    background: transparent; color: #94a3b8; border: 1px solid #334155;
    border-radius: 0.4rem; padding: 0.5rem 1rem; font-size: 0.875rem; cursor: pointer;
  }
  .btn-secondary:hover { border-color: #64748b; color: #f8fafc; }
</style>
