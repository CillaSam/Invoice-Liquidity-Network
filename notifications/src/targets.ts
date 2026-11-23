/**
 * Recipient routing shared by the processor and digest reconciliation
 * (#1282), so both agree on who should hear about an invoice event.
 *
 * Issue #476 adds submitted, payment-received and dispute-opened lifecycle
 * events. Paid events emit both the canonical `payment_received` trigger and
 * the legacy `invoice_paid` trigger so existing subscriptions keep working;
 * the dedupe key prevents a subscriber who has both from receiving two copies
 * on the same channel.
 */

import type { Invoice, ILNEventType, NotificationTrigger } from './types';

export type NotificationActor = 'freelancer' | 'lp' | 'payer';

/** All triggers that should be dispatched for each on-chain event. */
export const EVENT_TO_TRIGGERS: Record<ILNEventType, NotificationTrigger[]> = {
  submitted: ['invoice_submitted'],
  funded: ['invoice_funded'],
  paid: ['payment_received', 'invoice_paid'],
  defaulted: ['invoice_defaulted'],
  disputed: ['dispute_opened'],
};

/** Backwards-compatible single-trigger view used by older callers. */
export const EVENT_TO_TRIGGER: Record<ILNEventType, NotificationTrigger | null> = {
  submitted: 'invoice_submitted',
  funded: 'invoice_funded',
  paid: 'payment_received',
  defaulted: 'invoice_defaulted',
  disputed: 'dispute_opened',
};

export function getNotificationTargets(
  trigger: NotificationTrigger,
  invoice: Pick<Invoice, 'freelancer' | 'payer' | 'funder'>
): Array<{ recipient: string; actor: NotificationActor }> {
  switch (trigger) {
    case 'invoice_submitted':
      return [
        { recipient: invoice.freelancer, actor: 'freelancer' },
        { recipient: invoice.payer, actor: 'payer' },
      ];
    case 'invoice_funded':
      return [
        { recipient: invoice.freelancer, actor: 'freelancer' },
        { recipient: invoice.payer, actor: 'payer' },
      ];
    case 'payment_received':
    case 'invoice_paid': {
      const targets: Array<{ recipient: string; actor: NotificationActor }> = [
        { recipient: invoice.freelancer, actor: 'freelancer' },
      ];
      if (invoice.funder) {
        targets.push({ recipient: invoice.funder, actor: 'lp' });
      }
      return targets;
    }
    case 'dispute_opened': {
      const targets: Array<{ recipient: string; actor: NotificationActor }> = [
        { recipient: invoice.freelancer, actor: 'freelancer' },
        { recipient: invoice.payer, actor: 'payer' },
      ];
      if (invoice.funder) {
        targets.push({ recipient: invoice.funder, actor: 'lp' });
      }
      return targets;
    }
    case 'invoice_defaulted':
      if (!invoice.funder) {
        return [];
      }
      return [{ recipient: invoice.funder, actor: 'lp' }];
    case 'invoice_due_soon':
      if (!invoice.funder) {
        return [];
      }
      return [{ recipient: invoice.funder, actor: 'lp' }];
    case 'invoice_overdue':
      return [{ recipient: invoice.payer, actor: 'payer' }];
    default:
      return [];
  }
}
