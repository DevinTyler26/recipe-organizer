import type { NextConfig } from "next";
import withPWAInit from "next-pwa";

declare const self: { location: Location };

type RuntimeCachingEntry = {
  urlPattern: RegExp | string | ((context: { url: URL; request: Request }) => boolean);
  handler: "CacheFirst" | "NetworkFirst" | "NetworkOnly" | "StaleWhileRevalidate";
  method?: "GET" | "POST" | "PUT" | "DELETE";
  options?: Record<string, unknown>;
};

const runtimeCaching: RuntimeCachingEntry[] = [
  {
    urlPattern: ({ url }: { url: URL }) =>
      url.pathname.startsWith("/_next/static/"),
    handler: "CacheFirst",
    options: {
      cacheName: "next-static-assets",
      expiration: {
        maxEntries: 64,
        maxAgeSeconds: 30 * 24 * 60 * 60,
      },
    },
  },
  {
    urlPattern: ({ request, url }: { request: Request; url: URL }) =>
      request.destination === "image" &&
      url.origin === self.location.origin,
    handler: "StaleWhileRevalidate",
    options: {
      cacheName: "image-assets",
      expiration: {
        maxEntries: 128,
        maxAgeSeconds: 7 * 24 * 60 * 60,
      },
    },
  },
  {
    urlPattern: ({ url }: { url: URL }) =>
      url.origin === self.location.origin &&
      url.pathname.startsWith("/api/shopping-list"),
    handler: "NetworkFirst",
    method: "GET",
    options: {
      cacheName: "shopping-list-api",
      networkTimeoutSeconds: 3,
      expiration: {
        maxEntries: 32,
        maxAgeSeconds: 5 * 60,
      },
    },
  },
];

const withPWA = withPWAInit({
  dest: "public",
  register: true,
  disable: process.env.NODE_ENV === "development",
  workboxOptions: {
    skipWaiting: true,
    clientsClaim: true,
    importScripts: ["sw-background-sync.js"],
    runtimeCaching,
  },
});

const nextConfig: NextConfig = {
  /* config options here */
  turbopack: {},
};

export default withPWA(nextConfig);
