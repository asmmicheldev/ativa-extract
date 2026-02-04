const DB_NAME = "ativas_extract_db";
const DB_VERSION = 2; // bump (mudou schema)
const STORE = "items";
const META = "meta";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      // recria store se precisar (migração simples)
      if (db.objectStoreNames.contains(STORE)) {
        db.deleteObjectStore(STORE);
      }
      const s = db.createObjectStore(STORE, { keyPath: "id" });
      s.createIndex("updatedAt", "updatedAt");
      s.createIndex("archived", "archived");
      s.createIndex("alwaysOn", "alwaysOn");

      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "key" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeName, mode = "readonly") {
  return db.transaction(storeName, mode).objectStore(storeName);
}

export async function dbGetAllItems() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function dbPutItem(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, STORE, "readwrite");
    const req = store.put(item);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function dbDeleteItem(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, STORE, "readwrite");
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetMeta(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, META);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function dbSetMeta(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, META, "readwrite");
    const req = store.put({ key, value });
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
