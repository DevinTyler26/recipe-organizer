const SHOPPING_LIST_QUEUE_MESSAGE = "SHOPPING_LIST_QUEUE_UPDATE";
const SHOPPING_LIST_SYNC_COMPLETE_MESSAGE = "SHOPPING_LIST_SYNC_COMPLETED";
const SHOPPING_LIST_SYNC_TAG = "shopping-list-offline-sync";
const SHOPPING_LIST_QUEUE_CACHE = "shopping-list-offline-queue";
const SHOPPING_LIST_QUEUE_REQUEST = "/__shopping-list-offline-queue";
const SHOPPING_LIST_BATCH_ENDPOINT = "/api/shopping-list/batch";

self.addEventListener("message", (event) => {
  if (event.data?.type !== SHOPPING_LIST_QUEUE_MESSAGE) {
    return;
  }
  const mutations = Array.isArray(event.data.payload?.mutations)
    ? event.data.payload.mutations
    : [];
  event.waitUntil(storeShoppingListQueue(mutations));
});

self.addEventListener("sync", (event) => {
  if (event.tag === SHOPPING_LIST_SYNC_TAG) {
    event.waitUntil(flushShoppingListQueue());
  }
});

async function storeShoppingListQueue(mutations) {
  const cache = await caches.open(SHOPPING_LIST_QUEUE_CACHE);
  if (!mutations.length) {
    await cache.delete(SHOPPING_LIST_QUEUE_REQUEST);
    return;
  }
  const response = new Response(JSON.stringify(mutations), {
    headers: { "Content-Type": "application/json" },
  });
  await cache.put(SHOPPING_LIST_QUEUE_REQUEST, response);
}

async function flushShoppingListQueue() {
  const cache = await caches.open(SHOPPING_LIST_QUEUE_CACHE);
  const stored = await cache.match(SHOPPING_LIST_QUEUE_REQUEST);
  if (!stored) {
    return;
  }
  const mutations = await stored.json();
  if (!Array.isArray(mutations) || !mutations.length) {
    await cache.delete(SHOPPING_LIST_QUEUE_REQUEST);
    return;
  }
  const response = await fetch(SHOPPING_LIST_BATCH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operations: mutations }),
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error("Shopping list background sync failed");
  }
  await cache.delete(SHOPPING_LIST_QUEUE_REQUEST);
  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  clients.forEach((client) => {
    client.postMessage({
      type: SHOPPING_LIST_SYNC_COMPLETE_MESSAGE,
      payload: { mutationCount: mutations.length },
    });
  });
}
