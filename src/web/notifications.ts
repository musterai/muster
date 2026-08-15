// File: src/web/notifications.ts
// MUS-45: alert the human operator when a card lands in a terminal (Done) lane.
// Pure helpers so the alert decision and notification text stay unit-testable
// outside the React tree.
import { Event } from './types.js';

export interface CompletionAlert {
  heading: string;
  detail: string;
}

const MAX_TITLE_CHARS = 80;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1).trimEnd() + '…';
}

/** True when the event is a card reaching a terminal (Done) lane. */
export function isCardCompletedEvent(event: Event | null | undefined): event is Event {
  return !!event && event.entity_type === 'card' && event.action === 'completed';
}

/**
 * The operator should not be alerted about a completion they caused
 * themselves — they just did it. When neither side has an identity
 * (open mode, no claimed local user), a self-move is also suppressed:
 * both actor and current user resolve to null.
 */
export function shouldAlertOnCompletion(
  event: Event,
  currentUserId: string | null | undefined,
): boolean {
  return isCardCompletedEvent(event) && event.actor_id !== currentUserId;
}

/** Build the banner / notification copy from the `completed` event payload. */
export function completionAlert(
  event: Event,
  actorName: string | null | undefined,
): CompletionAlert {
  const payload = (event.payload || {}) as {
    card_key?: string;
    card_title?: string;
    to_column_name?: string;
  };
  const title = payload.card_title ? truncate(payload.card_title, MAX_TITLE_CHARS) : 'a card';
  const lane = payload.to_column_name || 'Done';
  const who = actorName || 'Someone';
  const heading = payload.card_key
    ? `${payload.card_key}: “${title}”`
    : `“${title}”`;
  return {
    heading,
    detail: `${who} moved it to ${lane}`,
  };
}

/** Fire an OS-level browser notification when permission is already granted. */
export function fireBrowserNotification(title: string, body: string): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    const note = new Notification(title, { body });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    // Some mobile webviews throw on Notification construction — the
    // in-app banner already covers the alert.
  }
}

/**
 * Ask for notification permission (must be called from a user gesture to
 * reliably prompt). Returns the resulting permission, or 'unsupported'
 * where the Notification API does not exist.
 */
export async function requestNotificationPermission(): Promise<'granted' | 'denied' | 'default' | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  const api = Notification as unknown as {
    request?: () => Promise<NotificationPermission>;
    requestPermission?: () => Promise<NotificationPermission>;
  };
  try {
    if (typeof api.request === 'function') return await api.request();
    if (typeof api.requestPermission === 'function') return await api.requestPermission();
  } catch {
    // Some browsers/webviews throw on prompt — fall back to the current state.
  }
  return Notification.permission;
}
