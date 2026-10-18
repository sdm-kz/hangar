// Moves this browser's saved settings from their names before the rename (`claudeweb.*`) to
// `hangar.*` — the login token among them, so nobody is logged out by the update. Imported first by
// main.tsx: several modules read their keys as they load, and they must find the new names already
// there.
//
// Moved rather than copied, so the two can't drift apart and nothing is stored twice. The one cost is a
// rollback to a build from before the rename, which starts from defaults and asks for the password.

const OLD = "claudeweb";
const NEW = "hangar";

function migrate(storage: Storage) {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(`${OLD}.`)) keys.push(key);
  }
  for (const key of keys) {
    const target = NEW + key.slice(OLD.length);
    const value = storage.getItem(key);
    // A value already under the new name is newer: this build wrote it.
    if (value !== null && storage.getItem(target) === null) storage.setItem(target, value);
    storage.removeItem(key);
  }
}

try {
  migrate(localStorage);
  migrate(sessionStorage);
} catch {
  // Storage blocked or full: the app runs on defaults, as it would on a first visit.
}
