import packageJson from "@/package.json";

type ReleaseChannel = "alpha" | "beta" | "rc" | "stable";

const FALLBACK_VERSION = packageJson?.version ?? "0.0.0";

const CHANNEL_LABELS: Record<ReleaseChannel, string> = {
  alpha: "Alpha build",
  beta: "Beta build",
  rc: "Release candidate",
  stable: "Stable release",
};

const deriveChannel = (version: string): ReleaseChannel => {
  const match = version.match(/-(alpha|beta|rc)[.-]?/i);
  if (!match) {
    return "stable";
  }
  const channel = match[1]?.toLowerCase();
  if (channel === "alpha" || channel === "beta" || channel === "rc") {
    return channel;
  }
  return "stable";
};

export const getAppVersionInfo = () => {
  const envVersion =
    process.env.NEXT_PUBLIC_APP_VERSION ??
    process.env.APP_VERSION ??
    FALLBACK_VERSION;
  const version = envVersion?.trim() || FALLBACK_VERSION;
  const channel = deriveChannel(version);
  return {
    version,
    channel,
    channelLabel: CHANNEL_LABELS[channel],
  };
};
