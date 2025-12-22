declare module "next-pwa" {
  import type { NextConfig } from "next";

  type NextPWAOptions = {
    dest?: string;
    register?: boolean;
    skipWaiting?: boolean;
    disable?: boolean;
    cacheOnFrontEndNav?: boolean;
    reloadOnOnline?: boolean;
    workboxOptions?: Record<string, unknown>;
  };

  export default function withPWA(
    options?: NextPWAOptions
  ): (config: NextConfig) => NextConfig;
}
