const STORAGE_KEY = "recipe-organizer-offline-request-queue";

type OfflineRequest = {
  id: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | null;
  createdAt: number;
};

export type QueueableRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
};

export type QueueResult = {
  queued: boolean;
  response?: Response;
};

const isClient = () => typeof window !== "undefined";

const readQueue = (): OfflineRequest[] => {
  if (!isClient()) {
    return [];
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return [];
    }
    const parsed = JSON.parse(stored) as OfflineRequest[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry) => Boolean(entry && entry.id && entry.url));
  } catch (error) {
    console.warn("Failed to read offline queue", error);
    return [];
  }
};

const writeQueue = (entries: OfflineRequest[]) => {
  if (!isClient()) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    console.warn("Failed to persist offline queue", error);
  }
};

const createId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `queued-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const shouldDeferToQueue = () =>
  isClient() && typeof navigator !== "undefined" && navigator.onLine === false;

const normalizeRequest = (request: QueueableRequest): OfflineRequest => ({
  id: createId(),
  url: request.url,
  method: request.method ?? "GET",
  headers: request.headers,
  body: request.body ?? null,
  createdAt: Date.now(),
});

const enqueueRequest = (request: QueueableRequest) => {
  const normalized = normalizeRequest(request);
  const existing = readQueue();
  writeQueue([...existing, normalized]);
};

const isOfflineError = (error: unknown) => {
  if (shouldDeferToQueue()) {
    return true;
  }
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  return error instanceof TypeError;
};

let flushInFlight: Promise<void> | null = null;

export const sendOrQueueRequest = async (
  request: QueueableRequest
): Promise<QueueResult> => {
  const normalizedRequest: QueueableRequest = {
    ...request,
    method: request.method ?? "GET",
  };

  if (shouldDeferToQueue()) {
    enqueueRequest(normalizedRequest);
    return { queued: true };
  }

  try {
    const response = await fetch(normalizedRequest.url, {
      method: normalizedRequest.method,
      headers: normalizedRequest.headers,
      body: normalizedRequest.body ?? undefined,
    });
    return { queued: false, response };
  } catch (error) {
    if (isOfflineError(error)) {
      enqueueRequest(normalizedRequest);
      return { queued: true };
    }
    throw error;
  }
};

export const flushOfflineQueue = async () => {
  if (!isClient()) {
    return;
  }
  if (flushInFlight) {
    return flushInFlight;
  }
  if (shouldDeferToQueue()) {
    return;
  }
  const pending = readQueue();
  if (!pending.length) {
    return;
  }
  flushInFlight = (async () => {
    const remaining: OfflineRequest[] = [];
    for (let index = 0; index < pending.length; index += 1) {
      const entry = pending[index];
      if (shouldDeferToQueue()) {
        remaining.push(...pending.slice(index));
        break;
      }
      try {
        const response = await fetch(entry.url, {
          method: entry.method,
          headers: entry.headers,
          body: entry.body ?? undefined,
        });
        if (!response.ok) {
          remaining.push(entry);
        }
      } catch (error) {
        if (!isOfflineError(error)) {
          console.error("Queued request failed", error);
        }
        remaining.push(entry);
      }
    }
    writeQueue(remaining);
  })()
    .catch((error) => {
      console.error("Failed to flush offline queue", error);
    })
    .finally(() => {
      flushInFlight = null;
    });
  return flushInFlight;
};

export const hasQueuedRequests = () => readQueue().length > 0;
