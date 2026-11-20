// Clear per-user offline data on sign-out so a shared phone cannot show the previous user's shops or queue.
export const KEEP_ON_LOGOUT = new Set(["ff-device", "ff-lang"]);

export function sessionKeysToRemove(keys: string[], keep: Set<string> = KEEP_ON_LOGOUT) {
  return keys.filter(k => (k === "ff" || k.startsWith("ff-")) && !keep.has(k));
}

function clearLocal(keepSession: boolean) {
  if (typeof localStorage === "undefined") return;
  const keep = new Set(KEEP_ON_LOGOUT);
  if (keepSession) keep.add("ff");
  for (const k of sessionKeysToRemove([...Array(localStorage.length)].map((_, i) => localStorage.key(i)!).filter(Boolean), keep))
    localStorage.removeItem(k);
}

async function clearIdb() {
  try {
    if (typeof indexedDB === "undefined" || !indexedDB.databases) return;
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map(d => d.name ? new Promise<void>(res => { const r = indexedDB.deleteDatabase(d.name!); r.onsuccess = r.onerror = r.onblocked = () => res(); }) : Promise.resolve()));
  } catch { /* private mode / unsupported */ }
}

async function clearCachesApi() {
  try {
    if (typeof caches === "undefined") return;
    const names = await caches.keys();
    await Promise.all(names.map(n => caches.delete(n)));
  } catch { /* unsupported */ }
}

/** Synchronously clears user localStorage; IndexedDB and Cache Storage are cleared in the background. */
export function clearSessionCaches(opts: { keepSession?: boolean } = {}): Promise<void> {
  clearLocal(!!opts.keepSession);
  return Promise.all([clearIdb(), clearCachesApi()]).then(() => {});
}
