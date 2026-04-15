/**
 * Relative time and duration formatting utilities.
 */

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "2h 14m", "45s", "3d 2h"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return "0s";

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Format a timestamp as a relative time string.
 * Examples: "3m ago", "2h ago", "just now"
 */
export function formatRelativeTime(timestamp: string | Date | undefined | null): string {
  if (!timestamp) return "—";
  const date = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) return "just now";
  if (diffMs < 60_000) return "just now";

  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return `${minutes}m ago`;
}

/**
 * Format uptime from seconds to a human-readable string.
 */
export function formatUptime(seconds: number): string {
  return formatDuration(seconds * 1000);
}

/**
 * Format bytes to a human-readable string.
 * Examples: "4.2 GB", "512 MB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, exp);
  return `${value.toFixed(exp > 0 ? 1 : 0)} ${units[exp]}`;
}
