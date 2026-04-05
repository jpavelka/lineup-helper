const NAMED = {
  GK:  { bg: '#d97706', text: '#fff' },
  DEF: { bg: '#2563eb', text: '#fff' },
  MID: { bg: '#16a34a', text: '#fff' },
  FWD: { bg: '#dc2626', text: '#fff' },
};

const PALETTE = ['#7c3aed', '#0891b2', '#be185d', '#ea580c', '#65a30d', '#0d9488'];

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Returns { bg, text } colors for a position group name.
 * Consistent for the same name regardless of formation.
 */
export function getGroupColor(group) {
  if (!group) return { bg: '#334155', text: '#94a3b8' };
  const upper = group.toUpperCase();
  return NAMED[upper] ?? { bg: PALETTE[hash(group) % PALETTE.length], text: '#fff' };
}
