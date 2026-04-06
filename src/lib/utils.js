/**
 * Computes per-player position and group time from game history.
 * Returns { [playerId]: { positionMs: { [posId]: ms }, groupMs: { [group]: ms } } }
 * Walks history sorted by timestamp; at the same timestamp, lineupSnapshot events
 * are processed before lifecycle events so "Lineup Set" + "Game Started" pairs work.
 */
export function computePositionStats(history, formation) {
  if (!history || !formation) return {};
  const posMap = {};
  (formation.positions || []).forEach(p => { posMap[p.id] = p; });

  const sorted = [...history].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.lineupSnapshot && !b.lineupSnapshot) return -1;
    if (!a.lineupSnapshot && b.lineupSnapshot) return 1;
    return 0;
  });

  const stats = {};
  const ensure = (id) => { if (!stats[id]) stats[id] = { positionMs: {}, groupMs: {} }; return stats[id]; };
  let currentLineup = {};
  let isLive = false;
  let intervalStart = null;

  for (const ev of sorted) {
    if (isLive && intervalStart !== null && ev.timestamp > intervalStart) {
      const duration = ev.timestamp - intervalStart;
      Object.entries(currentLineup).forEach(([posId, playerId]) => {
        if (!playerId) return;
        const s = ensure(playerId);
        s.positionMs[posId] = (s.positionMs[posId] || 0) + duration;
        const group = posMap[posId]?.group;
        if (group) s.groupMs[group] = (s.groupMs[group] || 0) + duration;
      });
    }
    if (ev.lineupSnapshot) currentLineup = { ...ev.lineupSnapshot };
    if (ev.event === 'Game Started' || ev.event === 'Game Resumed') isLive = true;
    else if (ev.event === 'Game Paused' || ev.event === 'Match Ended') isLive = false;
    intervalStart = ev.timestamp;
  }
  return stats;
}

/**
 * Computes per-player ordered timeline segments from game history.
 * Returns { [playerId]: [{ startMs, endMs, group }] } where group=null means bench.
 */
export function computePlayerTimelines(history, formation, roster) {
  if (!history || !formation || !roster) return {};
  const posMap = {};
  (formation.positions || []).forEach(p => { posMap[p.id] = p; });

  const sorted = [...history].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.lineupSnapshot && !b.lineupSnapshot) return -1;
    if (!a.lineupSnapshot && b.lineupSnapshot) return 1;
    return 0;
  });

  const segs = {};
  roster.forEach(p => { segs[p.id] = []; });

  let currentLineup = {};
  let isLive = false;
  let prevTs = null;
  let prevGameMs = 0;

  for (const ev of sorted) {
    if (isLive && prevTs !== null && ev.timestamp > prevTs) {
      const segStart = prevGameMs;
      const segEnd = ev.gameTimeMs ?? (prevGameMs + (ev.timestamp - prevTs));
      if (segEnd > segStart) {
        const onField = new Set(Object.values(currentLineup).filter(Boolean));
        roster.forEach(p => {
          const posId = Object.keys(currentLineup).find(k => currentLineup[k] === p.id);
          const group = posId ? (posMap[posId]?.group ?? null) : null;
          segs[p.id].push({ startMs: segStart, endMs: segEnd, group: onField.has(p.id) ? group : null });
        });
      }
    }
    if (ev.lineupSnapshot) currentLineup = { ...ev.lineupSnapshot };
    if (ev.event === 'Game Started' || ev.event === 'Game Resumed') isLive = true;
    else if (ev.event === 'Game Paused' || ev.event === 'Match Ended') isLive = false;
    prevTs = ev.timestamp;
    prevGameMs = ev.gameTimeMs ?? prevGameMs;
  }
  return segs;
}

/**
 * Generates a universally unique identifier.
 * Uses the built-in `crypto.randomUUID()` if available,
 * otherwise falls back to a robust "good-enough" implementation.
 * @returns {string} A UUID string.
 */
export function generateUUID() {
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, 
          v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}