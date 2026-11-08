// Identity IDs are generated with crypto.randomUUID on first profile creation.
// Derive the random character from that persistent ID so every device sees the
// same portrait, including after a nickname edit or a server restart.
export function characterFor(person) {
  const suffix = /[a-f0-9]{8}$/i.exec(person?.id || '')?.[0];
  const index = suffix ? parseInt(suffix, 16) % 10 : 0;
  return `/avatars3d/character-${String(index + 1).padStart(2, '0')}.png`;
}
