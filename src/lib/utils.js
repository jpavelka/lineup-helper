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