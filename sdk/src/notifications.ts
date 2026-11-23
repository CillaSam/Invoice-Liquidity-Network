/**
 * Notification triggers supported by the ILN notification service.
 *
 * `InvoiceSettled` is retained as a backwards-compatible alias for the
 * `invoice_paid` wire value. `PaymentReceived` is the lifecycle-facing name
 * for a received payment and uses the dedicated `payment_received` wire value.
 */
export enum NotificationTrigger {
  InvoiceSubmitted = 'invoice_submitted',
  InvoiceFunded = 'invoice_funded',
  PaymentReceived = 'payment_received',
  InvoiceSettled = 'invoice_paid',
  InvoiceDefaulted = 'invoice_defaulted',
  DisputeOpened = 'dispute_opened',
  DueDateWarning = 'invoice_due_soon',
  InvoiceOverdue = 'invoice_overdue',
}

/** Every trigger value accepted by the current notification service. */
export const ALL_NOTIFICATION_TRIGGERS: readonly NotificationTrigger[] = Object.freeze(
  Object.values(NotificationTrigger)
);

/** Type guard for values received from JSON/API boundaries. */
export function isValidTrigger(value: unknown): value is NotificationTrigger {
  return typeof value === 'string' && ALL_NOTIFICATION_TRIGGERS.includes(value as NotificationTrigger);
}

/** Supported notification delivery channels. */
export type SubscriptionChannel = 'email' | 'webhook' | 'sms' | 'websocket';

/**
 * Invoice lifecycle events that produce a notification.
 *
 * `disputed` is the normalised notification-service event name for the
 * on-chain `invoice_disputed` event.
 */
export type InvoiceNotificationEventType =
  | 'submitted'
  | 'funded'
  | 'paid'
  | 'defaulted'
  | 'disputed';

/**
 * Minimal, strongly typed invoice snapshot carried by a notification event.
 * Amounts stay strings because Soroban i128 values can exceed Number.MAX_SAFE_INTEGER.
 */
export interface NotificationInvoice {
  id: number;
  amount?: string;
  freelancer?: string;
  payer?: string;
  funder?: string | null;
  dueDate?: number;
  discountRate?: number;
  status?: string;
}

/** A lifecycle event passed to {@link NotificationsClient.handleInvoiceEvent}. */
export interface InvoiceNotificationEvent {
  eventId?: string;
  type: InvoiceNotificationEventType;
  invoice: NotificationInvoice;
  /** Explicit trigger override; otherwise derived from `type`. */
  trigger?: NotificationTrigger;
  txHash?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

/** A rendered, persisted notification record. */
export interface InvoiceNotificationRecord {
  id: string;
  eventId?: string;
  trigger: NotificationTrigger;
  eventType: InvoiceNotificationEventType;
  invoiceId: number;
  subject: string;
  message: string;
  read: boolean;
  createdAt: number;
  txHash?: string;
  metadata?: Record<string, unknown>;
}

/** Canonical event -> trigger mapping used by SDK consumers and docs. */
export const EVENT_TO_NOTIFICATION_TRIGGER: Readonly<
  Record<InvoiceNotificationEventType, NotificationTrigger>
> = Object.freeze({
  submitted: NotificationTrigger.InvoiceSubmitted,
  funded: NotificationTrigger.InvoiceFunded,
  paid: NotificationTrigger.PaymentReceived,
  defaulted: NotificationTrigger.InvoiceDefaulted,
  disputed: NotificationTrigger.DisputeOpened,
});

const EVENT_LABELS: Readonly<Record<InvoiceNotificationEventType, string>> = Object.freeze({
  submitted: 'submitted',
  funded: 'funded',
  paid: 'payment received',
  defaulted: 'defaulted',
  disputed: 'dispute opened',
});

function formatAmount(amount?: string): string {
  if (!amount) return 'an unspecified amount';
  return `${amount} stroops`;
}

function formatDueDate(dueDate?: number): string {
  if (!dueDate || !Number.isFinite(dueDate)) return 'the scheduled due date';
  return new Date(dueDate * 1000).toISOString();
}

function nextAction(type: InvoiceNotificationEventType): string {
  switch (type) {
    case 'submitted':
      return 'No action is required yet; wait for funding.';
    case 'funded':
      return 'The freelancer can begin work and the payer should prepare payment.';
    case 'paid':
      return 'No payment action remains; verify the settlement in your transaction history.';
    case 'defaulted':
      return 'The liquidity provider may claim default under the invoice terms.';
    case 'disputed':
      return 'Review the dispute and submit evidence before the response deadline.';
  }
}

/**
 * Build useful, human-readable notification content for every lifecycle event.
 * The function is pure so the same event always produces the same content.
 */
export function createInvoiceNotification(
  event: InvoiceNotificationEvent
): InvoiceNotificationRecord {
  if (!event || !event.invoice || !Number.isSafeInteger(event.invoice.id)) {
    throw new Error('A notification event with a valid invoice id is required');
  }
  if (!EVENT_LABELS[event.type]) {
    throw new Error(`Unsupported invoice notification event type: ${String(event.type)}`);
  }

  const trigger = event.trigger ?? EVENT_TO_NOTIFICATION_TRIGGER[event.type];
  if (!isValidTrigger(trigger)) {
    throw new Error(`Unsupported notification trigger: ${String(trigger)}`);
  }

  const invoice = event.invoice;
  const amount = formatAmount(invoice.amount);
  const subject = `Invoice #${invoice.id} ${EVENT_LABELS[event.type]}`;
  const details = [
    `Invoice #${invoice.id} has ${EVENT_LABELS[event.type]}.`,
    `Amount: ${amount}.`,
    invoice.payer ? `Payer: ${invoice.payer}.` : undefined,
    invoice.freelancer ? `Freelancer: ${invoice.freelancer}.` : undefined,
    invoice.funder ? `Funder: ${invoice.funder}.` : undefined,
    `Due date: ${formatDueDate(invoice.dueDate)}.`,
    invoice.discountRate !== undefined ? `Discount rate: ${invoice.discountRate} bps.` : undefined,
    event.txHash ? `Transaction: ${event.txHash}.` : undefined,
    nextAction(event.type),
  ]
    .filter((line): line is string => Boolean(line))
    .join(' ');

  return {
    id: event.eventId ?? `${trigger}:${invoice.id}:${event.timestamp ?? 0}`,
    eventId: event.eventId,
    trigger,
    eventType: event.type,
    invoiceId: invoice.id,
    subject,
    message: details,
    read: false,
    createdAt: event.timestamp ?? Date.now(),
    txHash: event.txHash,
    metadata: event.metadata,
  };
}

/** Minimal synchronous storage contract, compatible with localStorage. */
export interface NotificationStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function resolveDefaultStorage(): NotificationStorageAdapter | undefined {
  try {
    const candidate = (globalThis as { localStorage?: NotificationStorageAdapter }).localStorage;
    if (
      candidate &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function' &&
      typeof candidate.removeItem === 'function'
    ) {
      return candidate;
    }
  } catch {
    // localStorage is unavailable in Node/SSR; fall back to memory.
  }
  return undefined;
}

function createMemoryStorage(): NotificationStorageAdapter {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

/**
 * Persists notification records with event-id deduplication and a bounded
 * history, following the SDK's existing storage-adapter pattern.
 */
export class NotificationStore {
  private readonly storage: NotificationStorageAdapter;

  constructor(
    private readonly storageKey = 'iln_notifications',
    storage: NotificationStorageAdapter = resolveDefaultStorage() ?? createMemoryStorage(),
    private readonly maxRecords = 200
  ) {
    this.storage = storage;
  }

  private read(): InvoiceNotificationRecord[] {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as InvoiceNotificationRecord[]) : [];
    } catch {
      return [];
    }
  }

  private write(records: InvoiceNotificationRecord[]): void {
    this.storage.setItem(this.storageKey, JSON.stringify(records.slice(0, this.maxRecords)));
  }

  add(record: InvoiceNotificationRecord): InvoiceNotificationRecord {
    const records = this.read();
    if (record.eventId && records.some((item) => item.eventId === record.eventId)) {
      const existing = records.find((item) => item.eventId === record.eventId)!;
      return existing;
    }
    this.write([record, ...records]);
    return record;
  }

  list(address?: string): InvoiceNotificationRecord[] {
    const records = this.read();
    if (!address) return records;
    return records.filter(
      (record) =>
        record.metadata?.address === address ||
        record.metadata?.recipientAddress === address ||
        record.metadata?.stellarAddress === address
    );
  }

  markAsRead(id: string): boolean {
    const records = this.read();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return false;
    records[index] = { ...records[index], read: true };
    this.write(records);
    return true;
  }

  markAllAsRead(): void {
    this.write(this.read().map((record) => ({ ...record, read: true })));
  }

  clear(): void {
    this.storage.removeItem(this.storageKey);
  }
}

export interface NotificationsClientOptions {
  storage?: NotificationStorageAdapter;
  storageKey?: string;
  maxRecords?: number;
}

/**
 * A subscription record. `id` is numeric because that is the wire format
 * returned by `POST /subscribe`; `created_at` is a Unix timestamp in seconds.
 */
export interface Subscription {
  id: number;
  stellar_address: string;
  channel: SubscriptionChannel;
  destination: string;
  triggers: NotificationTrigger[];
  created_at: number;
}

/**
 * Client for managing ILN notification subscriptions and rendering/persisting
 * lifecycle notifications locally.
 *
 * @example
 * ```ts
 * const client = new NotificationsClient("https://api.iln.network");
 *
 * await client.subscribeEmail("GABC...", "user@example.com", [
 *   NotificationTrigger.InvoiceSubmitted,
 *   NotificationTrigger.InvoiceFunded,
 *   NotificationTrigger.PaymentReceived,
 *   NotificationTrigger.DisputeOpened,
 *   NotificationTrigger.InvoiceDefaulted,
 * ]);
 *
 * const record = client.handleInvoiceEvent({
 *   type: 'disputed',
 *   invoice: { id: 42, amount: '10000000', payer: 'GPAYER...' },
 * });
 * console.log(record.subject, record.message);
 * ```
 */
export class NotificationsClient {
  private readonly baseUrl: string;
  /** Locally persisted lifecycle notifications. */
  public readonly notifications: NotificationStore;

  /**
   * @param baseUrl - The base URL of the ILN notifications API.
   * @param options - Optional local notification persistence settings.
   */
  constructor(baseUrl: string, options: NotificationsClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.notifications = new NotificationStore(
      options.storageKey ?? 'iln_notifications',
      options.storage ?? resolveDefaultStorage() ?? createMemoryStorage(),
      options.maxRecords ?? 200
    );
  }

  /** Render and persist a notification for one invoice lifecycle event. */
  handleInvoiceEvent(event: InvoiceNotificationEvent): InvoiceNotificationRecord {
    return this.notifications.add(createInvoiceNotification(event));
  }

  /**
   * Subscribe to email notifications for a Stellar address.
   *
   * @param address - The Stellar address to monitor.
   * @param email - The email address to send notifications to.
   * @param triggers - The events that should trigger email notifications.
   * @returns The created subscription record.
   */
  async subscribeEmail(
    address: string,
    email: string,
    triggers: NotificationTrigger[]
  ): Promise<Subscription> {
    this.assertTriggers(triggers);
    const response = await fetch(`${this.baseUrl}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stellar_address: address,
        channel: 'email',
        destination: email,
        triggers,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to subscribe email: ${await response.text()}`);
    }

    const data = await response.json();
    return data.subscription;
  }

  /**
   * Subscribe to webhook notifications for a Stellar address.
   *
   * @param address - The Stellar address to monitor.
   * @param url - The webhook URL to receive POST requests.
   * @param triggers - The events that should trigger webhook calls.
   * @returns The created subscription record.
   */
  async subscribeWebhook(
    address: string,
    url: string,
    triggers: NotificationTrigger[]
  ): Promise<Subscription> {
    this.assertTriggers(triggers);
    const response = await fetch(`${this.baseUrl}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stellar_address: address,
        channel: 'webhook',
        destination: url,
        triggers,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to subscribe webhook: ${await response.text()}`);
    }

    const data = await response.json();
    return data.subscription;
  }

  /** Remove a subscription by id. */
  async unsubscribe(subscriptionId: number): Promise<void> {
    const response = await fetch(`${this.baseUrl}/unsubscribe`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: subscriptionId }),
    });

    if (!response.ok) {
      throw new Error(`Failed to unsubscribe: ${await response.text()}`);
    }
  }

  /** List active subscriptions for a Stellar address. */
  async listSubscriptions(address: string): Promise<Subscription[]> {
    const response = await fetch(`${this.baseUrl}/subscriptions/${encodeURIComponent(address)}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to list subscriptions: ${await response.text()}`);
    }

    const data = await response.json();
    return data.subscriptions;
  }

  /** Send a synthetic event to a webhook subscription. */
  async testWebhook(subscriptionId: number): Promise<{ success: boolean; statusCode: number }> {
    const response = await fetch(`${this.baseUrl}/test-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: subscriptionId }),
    });

    if (!response.ok) {
      throw new Error(`Failed to test webhook: ${await response.text()}`);
    }

    return await response.json();
  }

  private assertTriggers(triggers: NotificationTrigger[]): void {
    if (!Array.isArray(triggers) || triggers.some((trigger) => !isValidTrigger(trigger))) {
      throw new Error(`triggers must be one of: ${ALL_NOTIFICATION_TRIGGERS.join(', ')}`);
    }
  }
}
