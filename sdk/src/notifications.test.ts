import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ALL_NOTIFICATION_TRIGGERS,
  EVENT_TO_NOTIFICATION_TRIGGER,
  NotificationStore,
  NotificationsClient,
  NotificationTrigger,
  createInvoiceNotification,
  isValidTrigger,
} from './notifications';

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

describe('NotificationsClient', () => {
  let client: NotificationsClient;

  beforeEach(() => {
    client = new NotificationsClient('http://localhost:4001');
    fetchMock.mockReset();
  });

  it('subscribes to email', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ subscription: { id: 1, channel: 'email' } }),
    });

    const sub = await client.subscribeEmail('G123', 'test@test.com', [
      NotificationTrigger.InvoiceFunded,
    ]);

    expect(sub.id).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stellar_address: 'G123',
        channel: 'email',
        destination: 'test@test.com',
        triggers: ['invoice_funded'],
      }),
    });
  });

  it('subscribes to webhook', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ subscription: { id: 2, channel: 'webhook' } }),
    });

    const sub = await client.subscribeWebhook('G123', 'https://hook.com', [
      NotificationTrigger.DueDateWarning,
    ]);

    expect(sub.id).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stellar_address: 'G123',
        channel: 'webhook',
        destination: 'https://hook.com',
        triggers: ['invoice_due_soon'],
      }),
    });
  });

  it('unsubscribes', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await client.unsubscribe(5);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/unsubscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 5 }),
    });
  });

  it('lists subscriptions', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ subscriptions: [{ id: 1 }, { id: 2 }] }),
    });

    const subs = await client.listSubscriptions('G123');

    expect(subs).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/subscriptions/G123', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('tests a webhook', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, statusCode: 200 }),
    });

    const res = await client.testWebhook(2);

    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/test-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 2 }),
    });
  });

  it('throws when subscribeEmail fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      text: async () => 'Internal Server Error',
    });

    await expect(
      client.subscribeEmail('G123', 'test@test.com', [NotificationTrigger.InvoiceFunded])
    ).rejects.toThrow('Failed to subscribe email: Internal Server Error');
  });

  it('throws when subscribeWebhook fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      text: async () => 'Bad Request',
    });

    await expect(
      client.subscribeWebhook('G123', 'https://hook.com', [NotificationTrigger.InvoiceFunded])
    ).rejects.toThrow('Failed to subscribe webhook: Bad Request');
  });

  it('throws when unsubscribe fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      text: async () => 'Not Found',
    });

    await expect(client.unsubscribe(10)).rejects.toThrow('Failed to unsubscribe: Not Found');
  });

  it('throws when listSubscriptions fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      text: async () => 'Error',
    });

    await expect(client.listSubscriptions('G123')).rejects.toThrow(
      'Failed to list subscriptions: Error'
    );
  });

  it('throws when testWebhook fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      text: async () => 'Failed',
    });

    await expect(client.testWebhook(2)).rejects.toThrow('Failed to test webhook: Failed');
  });
});

describe('lifecycle notification triggers and content', () => {
  const expectedTriggerValues = [
    'invoice_submitted',
    'invoice_funded',
    'payment_received',
    'invoice_paid',
    'invoice_defaulted',
    'dispute_opened',
    'invoice_due_soon',
    'invoice_overdue',
  ];

  it('exposes all five required lifecycle triggers plus schedule triggers', () => {
    expect([...ALL_NOTIFICATION_TRIGGERS]).toEqual(expectedTriggerValues);
    for (const value of expectedTriggerValues) {
      expect(isValidTrigger(value)).toBe(true);
    }
    expect(isValidTrigger('invoice_unknown')).toBe(false);
  });

  it('maps every invoice lifecycle event to a trigger', () => {
    expect(EVENT_TO_NOTIFICATION_TRIGGER).toEqual({
      submitted: NotificationTrigger.InvoiceSubmitted,
      funded: NotificationTrigger.InvoiceFunded,
      paid: NotificationTrigger.PaymentReceived,
      defaulted: NotificationTrigger.InvoiceDefaulted,
      disputed: NotificationTrigger.DisputeOpened,
    });
  });

  it.each([
    ['submitted', NotificationTrigger.InvoiceSubmitted, 'submitted'],
    ['funded', NotificationTrigger.InvoiceFunded, 'funded'],
    ['paid', NotificationTrigger.PaymentReceived, 'payment received'],
    ['defaulted', NotificationTrigger.InvoiceDefaulted, 'defaulted'],
    ['disputed', NotificationTrigger.DisputeOpened, 'dispute opened'],
  ] as const)('renders useful content for %s', (type, trigger, label) => {
    const record = createInvoiceNotification({
      eventId: `evt-${type}`,
      type,
      invoice: {
        id: 42,
        amount: '10000000',
        freelancer: 'GFREELANCER',
        payer: 'GPAYER',
        funder: 'GFUNDER',
        dueDate: 1780000000,
        discountRate: 250,
      },
      txHash: '0xabc',
      timestamp: 1700000000000,
    });

    expect(record.trigger).toBe(trigger);
    expect(record.eventType).toBe(type);
    expect(record.subject).toContain('Invoice #42');
    expect(record.subject).toContain(label);
    expect(record.message).toContain('10000000 stroops');
    expect(record.message).toContain('GPAYER');
    expect(record.message).toContain('GFREELANCER');
    expect(record.message).toContain('GFUNDER');
    expect(record.message).toContain('250 bps');
    expect(record.message).toContain('Transaction: 0xabc');
    expect(record.read).toBe(false);
    expect(record.createdAt).toBe(1700000000000);
  });

  it('rejects unknown event types and invalid triggers', () => {
    expect(() =>
      createInvoiceNotification({ type: 'unknown' as any, invoice: { id: 1 } })
    ).toThrow('Unsupported invoice notification event type');
    expect(() =>
      createInvoiceNotification({
        type: 'funded',
        trigger: 'invoice_unknown' as any,
        invoice: { id: 1 },
      })
    ).toThrow('Unsupported notification trigger');
  });

  it('rejects invalid triggers before calling the API', async () => {
    const localClient = new NotificationsClient('http://localhost:4001');
    fetchMock.mockReset();

    await expect(
      localClient.subscribeEmail('G123', 'test@test.com', ['invoice_unknown' as any])
    ).rejects.toThrow('triggers must be one of');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('NotificationStore persistence', () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
  }

  it('persists records across client instances and marks them read', () => {
    const storage = memoryStorage();
    const first = new NotificationsClient('http://localhost:4001', { storage, storageKey: 'test' });
    const record = first.handleInvoiceEvent({
      type: 'disputed',
      eventId: 'evt-dispute-1',
      invoice: { id: 7 },
      metadata: { stellarAddress: 'G7' },
      timestamp: 1700000000000,
    });

    const second = new NotificationsClient('http://localhost:4001', { storage, storageKey: 'test' });
    expect(second.notifications.list()).toHaveLength(1);
    expect(second.notifications.list('G7')).toHaveLength(1);
    expect(second.notifications.list('GOTHER')).toHaveLength(0);
    expect(second.notifications.markAsRead(record.id)).toBe(true);
    expect(second.notifications.list()[0].read).toBe(true);
    expect(second.notifications.markAsRead('missing')).toBe(false);

    second.notifications.clear();
    expect(second.notifications.list()).toHaveLength(0);
  });

  it('deduplicates by event id and caps history', () => {
    const storage = memoryStorage();
    const store = new NotificationStore('test', storage, 2);

    const event = {
      type: 'funded' as const,
      eventId: 'evt-1',
      invoice: { id: 1 },
      timestamp: 1700000000000,
    };
    store.add(createInvoiceNotification(event));
    store.add(createInvoiceNotification(event));
    expect(store.list()).toHaveLength(1);

    store.add(createInvoiceNotification({ ...event, eventId: 'evt-2' }));
    store.add(createInvoiceNotification({ ...event, eventId: 'evt-3' }));
    expect(store.list()).toHaveLength(2);

    store.markAllAsRead();
    expect(store.list().every((record) => record.read)).toBe(true);
  });
});
