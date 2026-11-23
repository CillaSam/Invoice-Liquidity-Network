import { describe, it, expect, vi } from 'vitest';
import {
  EVENT_TO_TRIGGERS,
  EVENT_TO_TRIGGER,
  getNotificationTargets,
} from '../src/targets';
import { TemplateEngine } from '../src/template-engine';
import { NotificationService } from '../src/service';
import type {
  EmailClient,
  HttpClient,
  SubscriptionStore,
  ProcessedEventStore,
} from '../src/service';
import type { InvoiceEvent, Subscription } from '../src/types';

const FREELANCER = 'GFREELANCER';
const PAYER = 'GPAYER';
const FUNDER = 'GFUNDER';
const invoice = {
  freelancer: FREELANCER,
  payer: PAYER,
  funder: FUNDER,
};

describe('issue #476 lifecycle notification routing', () => {
  it('maps all five lifecycle events to notification triggers', () => {
    expect(EVENT_TO_TRIGGERS).toEqual({
      submitted: ['invoice_submitted'],
      funded: ['invoice_funded'],
      paid: ['payment_received', 'invoice_paid'],
      defaulted: ['invoice_defaulted'],
      disputed: ['dispute_opened'],
    });
    expect(EVENT_TO_TRIGGER.disputed).toBe('dispute_opened');
  });

  it('routes submitted and dispute events to every relevant actor', () => {
    expect(getNotificationTargets('invoice_submitted', invoice)).toEqual([
      { recipient: FREELANCER, actor: 'freelancer' },
      { recipient: PAYER, actor: 'payer' },
    ]);
    expect(getNotificationTargets('dispute_opened', invoice)).toEqual([
      { recipient: FREELANCER, actor: 'freelancer' },
      { recipient: PAYER, actor: 'payer' },
      { recipient: FUNDER, actor: 'lp' },
    ]);
  });

  it('treats payment_received and legacy invoice_paid identically', () => {
    expect(getNotificationTargets('payment_received', invoice)).toEqual(
      getNotificationTargets('invoice_paid', invoice)
    );
  });

  it('renders useful default content for all new lifecycle templates', () => {
    const engine = new TemplateEngine();
    const context = {
      invoiceId: 42,
      amount: '10000000',
      payer: PAYER,
      freelancer: FREELANCER,
      funder: FUNDER,
      dueDate: '2026-12-01T00:00:00.000Z',
      discountRate: 250,
      paidAt: '2026-11-23T00:00:00.000Z',
    };

    for (const [id, expected] of [
      ['invoice_submitted', 'Invoice #42 has been submitted'],
      ['payment_received', 'Payment received for invoice #42'],
      ['dispute_opened', 'Dispute opened for invoice #42'],
    ] as const) {
      const rendered = engine.render(id, context as any, 'none');
      expect(rendered.success).toBe(true);
      expect(rendered.subject).toBe(expected);
      expect(rendered.body).toContain('10000000');
      expect(rendered.body).toContain(FREELANCER);
      expect(rendered.body).toContain(PAYER);
    }
  });
});

describe('issue #476 service delivery for new lifecycle events', () => {
  function serviceFor(event: InvoiceEvent, subs: Subscription[]) {
    const email: EmailClient = { send: vi.fn().mockResolvedValue(undefined) };
    const http: HttpClient = { post: vi.fn().mockResolvedValue({ status: 200 }) };
    const store: SubscriptionStore = {
      getByAddress: vi.fn().mockImplementation(async (address: string) =>
        subs.filter((sub) => sub.address === address)
      ),
      updateSubscription: vi.fn().mockResolvedValue(undefined),
    };
    const processed: ProcessedEventStore = {
      hasProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
    };
    const service = new NotificationService(email, http, store, processed, () => 1700000000000);
    return { service, email };
  }

  function sub(address: string, role: Subscription['role']): Subscription {
    return {
      id: `sub-${role}`,
      address,
      role,
      channel: 'email',
      email: `${role}@example.com`,
      webhookStatus: 'active',
      active: true,
    };
  }

  const baseEvent: InvoiceEvent = {
    eventId: 'evt-lifecycle',
    type: 'submitted',
    invoiceId: 42,
    freelancer: FREELANCER,
    payer: PAYER,
    funder: FUNDER,
    amount: '10000000',
    dueDate: 1780000000,
    discountRate: 250,
  };

  it('notifies the payer when an invoice is submitted', async () => {
    const { service, email } = serviceFor(baseEvent, [sub(PAYER, 'payer')]);
    await service.handleEvent(baseEvent);
    expect(email.send).toHaveBeenCalledOnce();
    expect(email.send.mock.calls[0][1]).toContain('submitted');
  });

  it('notifies the freelancer of a payment, including payment_received events', async () => {
    const event = { ...baseEvent, type: 'payment_received' };
    const { service, email } = serviceFor(event, [sub(FREELANCER, 'freelancer')]);
    await service.handleEvent(event);
    expect(email.send).toHaveBeenCalledOnce();
    expect(email.send.mock.calls[0][1]).toContain('Payment');
  });

  it('notifies all actors when a dispute is opened', async () => {
    const event = { ...baseEvent, type: 'disputed' };
    const subscriptions = [
      sub(FREELANCER, 'freelancer'),
      sub(PAYER, 'payer'),
      sub(FUNDER, 'lp'),
    ];
    const { service, email } = serviceFor(event, subscriptions);
    await service.handleEvent(event);
    expect(email.send).toHaveBeenCalledTimes(3);
  });
});
