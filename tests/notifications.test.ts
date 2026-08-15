// @vitest-environment jsdom
// File: tests/notifications.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isCardCompletedEvent,
  shouldAlertOnCompletion,
  completionAlert,
  fireBrowserNotification,
  requestNotificationPermission,
} from '../src/web/notifications.js';
import type { Event } from '../src/web/types.js';

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt_1',
    project_id: 'proj_1',
    entity_type: 'card',
    entity_id: 'card_1',
    action: 'completed',
    actor_id: 'agent_1',
    actor_name: 'scout',
    payload: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const COMPLETED_PAYLOAD = {
  card_key: 'MUS-45',
  card_title: 'Alert the human when a card lands in a terminal (Done) lane',
  to_column_name: 'Done',
};

describe('isCardCompletedEvent', () => {
  it('is true for a card completed event', () => {
    expect(isCardCompletedEvent(makeEvent())).toBe(true);
  });

  it('is false for a card moved event', () => {
    expect(isCardCompletedEvent(makeEvent({ action: 'moved' }))).toBe(false);
  });

  it('is false for a non-card completed event', () => {
    expect(isCardCompletedEvent(makeEvent({ entity_type: 'document' }))).toBe(false);
  });

  it('is false for null / undefined', () => {
    expect(isCardCompletedEvent(null)).toBe(false);
    expect(isCardCompletedEvent(undefined)).toBe(false);
  });
});

describe('shouldAlertOnCompletion', () => {
  it('alerts when another principal completed the card', () => {
    expect(shouldAlertOnCompletion(makeEvent({ actor_id: 'agent_1' }), 'user_1')).toBe(true);
  });

  it('suppresses a completion the operator caused themselves', () => {
    expect(shouldAlertOnCompletion(makeEvent({ actor_id: 'user_1' }), 'user_1')).toBe(false);
  });

  it('suppresses an open-mode self move (both sides unidentifed)', () => {
    expect(shouldAlertOnCompletion(makeEvent({ actor_id: null }), null)).toBe(false);
  });

  it('ignores non-completion events even from another actor', () => {
    expect(shouldAlertOnCompletion(makeEvent({ action: 'moved' }), 'user_1')).toBe(false);
  });
});

describe('completionAlert', () => {
  it('builds heading and detail from card key, title, actor and lane', () => {
    const alert = completionAlert(makeEvent({ payload: COMPLETED_PAYLOAD }), 'scout');
    expect(alert.heading).toBe('MUS-45: “Alert the human when a card lands in a terminal (Done) lane”');
    expect(alert.detail).toBe('scout moved it to Done');
  });

  it('falls back to generic copy when the payload is missing', () => {
    const alert = completionAlert(makeEvent({ payload: null }), null);
    expect(alert.heading).toBe('“a card”');
    expect(alert.detail).toBe('Someone moved it to Done');
  });

  it('omits the key when the payload has no card_key', () => {
    const alert = completionAlert(makeEvent({ payload: { card_title: 'Ship it' } }), null);
    expect(alert.heading).toBe('“Ship it”');
  });

  it('defaults the lane to Done when the payload omits it', () => {
    const alert = completionAlert(makeEvent({ payload: { card_key: 'MUS-1', card_title: 'x' } }), null);
    expect(alert.detail).toBe('Someone moved it to Done');
  });

  it('truncates long titles so the banner stays compact', () => {
    const longTitle = 'x'.repeat(200);
    const alert = completionAlert(makeEvent({ payload: { card_key: 'MUS-9', card_title: longTitle } }), null);
    expect(alert.heading).toContain('…');
    expect(alert.heading).not.toContain(longTitle);
    expect(alert.heading.length).toBeLessThan(100);
  });
});

describe('fireBrowserNotification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is a no-op when the Notification API is absent', () => {
    vi.stubGlobal('Notification', undefined);
    expect(() => fireBrowserNotification('t', 'b')).not.toThrow();
  });

  it('is a no-op when permission has not been granted', () => {
    vi.stubGlobal('Notification', { permission: 'denied' });
    expect(() => fireBrowserNotification('t', 'b')).not.toThrow();
  });

  it('creates a notification when granted, focusing and closing on click', () => {
    const closeSpy = vi.fn();
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {});

    class MockNotification {
      static permission: NotificationPermission = 'granted';
      static created: MockNotification | null = null;
      title: string;
      options: NotificationOptions;
      onclick: (() => void) | null = null;
      close = closeSpy;
      constructor(title: string, options: NotificationOptions) {
        this.title = title;
        this.options = options;
        MockNotification.created = this;
      }
    }
    vi.stubGlobal('Notification', MockNotification);

    fireBrowserNotification('Card completed', 'MUS-45: “x” — scout moved it to Done');

    const note = MockNotification.created;
    expect(note).not.toBeNull();
    expect(note!.title).toBe('Card completed');
    expect(note!.options.body).toBe('MUS-45: “x” — scout moved it to Done');
    expect(note!.onclick).toBeTypeOf('function');

    note!.onclick!();
    expect(focusSpy).toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
  });
});

describe('requestNotificationPermission', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns unsupported when the Notification API is absent', async () => {
    vi.stubGlobal('Notification', undefined);
    await expect(requestNotificationPermission()).resolves.toBe('unsupported');
  });

  it('returns the existing permission when already decided', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    await expect(requestNotificationPermission()).resolves.toBe('granted');

    vi.stubGlobal('Notification', { permission: 'denied' });
    await expect(requestNotificationPermission()).resolves.toBe('denied');
  });

  it('asks for permission when still default', async () => {
    const request = vi.fn(async () => 'granted' as NotificationPermission);
    vi.stubGlobal('Notification', { permission: 'default', request });
    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(request).toHaveBeenCalled();
  });

  it('falls back to the current permission if request() throws', async () => {
    const request = vi.fn(async () => {
      throw new Error('prompt blocked');
    });
    vi.stubGlobal('Notification', { permission: 'default', request });
    await expect(requestNotificationPermission()).resolves.toBe('default');
  });
});
