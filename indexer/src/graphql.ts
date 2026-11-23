import { createYoga, createSchema, createGraphQLError } from 'graphql-yoga';

import { GraphQLError, Kind } from 'graphql';
import type {
  ASTVisitor,
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  SelectionSetNode,
  ValidationContext,
  ValueNode,
} from 'graphql';
import {
  getDb,
  getInvoiceById,
  queryInvoicesPaginated,
  getProtocolStats,
  getLPStats,
  getFreelancerStats,
  getInvoiceHistory,
  getTopLPs,
  getEvents,
  getCursorUpdatedAt,
} from './db';
import { pubsub, LEGACY_INVOICE_CREATED, LEGACY_INVOICE_UPDATED } from './graphql/pubsub';
import type { Invoice, ILNEvent } from './types';

// ─── GraphQL schema ───────────────────────────────────────────────────────────

export const typeDefs = /* GraphQL */ `
  enum InvoiceStatus {
    Pending
    Funded
    Paid
    Defaulted
  }

  type Invoice {
    id: Int!
    freelancer: String!
    payer: String!
    amount: String!
    dueDate: Int!
    discountRate: Int!
    status: InvoiceStatus!
    funder: String
    fundedAt: Int
    createdAt: Int!
    updatedAt: Int!
  }

  type InvoiceEdge {
    node: Invoice!
    cursor: String!
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type InvoiceConnection {
    edges: [InvoiceEdge!]!
    pageInfo: PageInfo!
  }

  type Event {
    eventId: String!
    eventType: String!
    invoiceId: Int!
    ledger: Int!
    ledgerClosedAt: String!
    createdAt: Int!
  }

  type ProtocolStats {
    totalInvoices: Int!
    totalVolume: String!
    totalYield: String!
    defaultRate: Float!
  }

  type LPStats {
    deployed: String!
    yield: String!
    invoiceCount: Int!
    defaultRate: Float!
  }

  type FreelancerStats {
    submitted: Int!
    funded: Int!
    totalReceived: String!
    avgDiscount: Float!
  }

  type LPStat {
    address: String!
    yield: String!
    invoiceCount: Int!
  }

  type HealthStatus {
    status: String!
    db: String!
    lastSync: String
    uptime: Int!
  }

  type Query {
    health: HealthStatus!
    invoice(id: Int!): Invoice
    invoices(
      status: InvoiceStatus
      freelancer: String
      payer: String
      funder: String
      first: Int
      after: String
    ): InvoiceConnection!
    events(invoiceId: Int): [Event!]!
    protocolStats: ProtocolStats!
    lpStats(address: String!): LPStats!
    freelancerStats(address: String!): FreelancerStats!
    topLPs(limit: Int, period: String): [LPStat!]!
    history(address: String!, role: String): [Invoice!]!
  }

  type Subscription {
    invoiceCreated: Invoice!
    invoiceUpdated: Invoice!
  }
`;

// ─── Resolvers ────────────────────────────────────────────────────────────────

const startTime = Date.now();

const resolvers = {
  // Map snake_case DB fields to camelCase GraphQL fields
  Invoice: {
    dueDate: (i: Invoice) => i.due_date,
    discountRate: (i: Invoice) => i.discount_rate,
    fundedAt: (i: Invoice) => i.funded_at ?? null,
    createdAt: (i: Invoice) => i.created_at,
    updatedAt: (i: Invoice) => i.updated_at,
  },

  Event: {
    eventId: (e: ILNEvent) => e.event_id,
    eventType: (e: ILNEvent) => e.event_type,
    invoiceId: (e: ILNEvent) => e.invoice_id,
    ledgerClosedAt: (e: ILNEvent) => e.ledger_closed_at,
    createdAt: (e: ILNEvent) => e.created_at,
  },

  Query: {
    health: () => {
      let dbStatus: 'ok' | 'error' = 'ok';
      try {
        getDb().prepare('SELECT 1').get();
      } catch {
        dbStatus = 'error';
      }
      const lastSyncMs = getCursorUpdatedAt();
      return {
        status: dbStatus === 'ok' ? 'ok' : 'degraded',
        db: dbStatus,
        lastSync: lastSyncMs !== null ? new Date(lastSyncMs).toISOString() : null,
        uptime: Date.now() - startTime,
      };
    },

    invoice: (_: unknown, { id }: { id: number }) => {
      return getInvoiceById(id) ?? null;
    },

    invoices: (
      _: unknown,
      args: {
        status?: string;
        freelancer?: string;
        payer?: string;
        funder?: string;
        first?: number | null;
        after?: string | null;
      },
      context: GraphQLRequestContext
    ) => {
      const limit = pageSize(args.first, 'first', MAX_PAGE_SIZE, MAX_PAGE_SIZE, context);
      if (args.after !== undefined && args.after !== null && decodeInvoiceCursor(args.after) === null) {
        throw badInput('after is not a valid invoices cursor', 'after');
      }
      const { invoices, hasMore, nextCursor } = queryInvoicesPaginated(
        {
          status: args.status,
          freelancer: args.freelancer,
          payer: args.payer,
          funder: args.funder,
        },
        limit,
        args.after ?? undefined
      );

      return {
        edges: invoices.map((invoice) => ({
          node: invoice,
          cursor: Buffer.from(String(invoice.id)).toString('base64'),
        })),
        pageInfo: {
          hasNextPage: hasMore,
          endCursor: nextCursor ?? null,
        },
      };
    },

    events: (_: unknown, { invoiceId }: { invoiceId?: number | null }, context: GraphQLRequestContext) => {
      const events = getEvents(invoiceId ?? undefined);
      // Unfiltered `events` is capped at EVENTS_UNFILTERED_CAP rows by the
      // query in db.ts. Say so instead of returning a silently short list.
      if ((invoiceId === undefined || invoiceId === null) && events.length >= EVENTS_UNFILTERED_CAP) {
        const total = (getDb().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
        if (total > events.length) {
          warn(context, {
            code: 'RESULT_TRUNCATED',
            field: 'events',
            message: `events without invoiceId returns the first ${events.length} of ${total} events; filter by invoiceId or use the REST export (/v1/export/events) for the full set`,
            returned: events.length,
            total,
          });
        }
      }
      return events;
    },

    protocolStats: () => getProtocolStats(),

    lpStats: (_: unknown, { address }: { address: string }) => getLPStats(address),

    freelancerStats: (_: unknown, { address }: { address: string }) => getFreelancerStats(address),

    topLPs: (
      _: unknown,
      { limit, period }: { limit?: number | null; period?: string | null },
      context: GraphQLRequestContext
    ) => {
      const resolvedPeriod = period ?? 'all';
      if (!['all', 'week', 'month'].includes(resolvedPeriod)) {
        throw badInput('period must be all, week, or month', 'period');
      }
      return getTopLPs(pageSize(limit, 'limit', 10, MAX_PAGE_SIZE, context), resolvedPeriod);
    },

    history: (_: unknown, { address, role = 'freelancer' }: { address: string; role?: string }) => {
      if (role !== 'freelancer' && role !== 'payer' && role !== 'funder') {
        throw badInput('role must be freelancer, payer, or funder', 'role');
      }
      return getInvoiceHistory(address, role);
    },
  },

  Subscription: {
    invoiceCreated: {
      subscribe: () => pubsub.asyncIterator<Invoice>(LEGACY_INVOICE_CREATED),
      resolve: (invoice: Invoice) => invoice,
    },
    invoiceUpdated: {
      subscribe: () => pubsub.asyncIterator<Invoice>(LEGACY_INVOICE_UPDATED),
      resolve: (invoice: Invoice) => invoice,
    },
  },
};

// ─── Pagination invariants (#1444) ───────────────────────────────────────────
//
// Financial lists must never come back shorter than the caller asked for
// without saying so. The rules:
//
// - `first` / `limit` must be a positive integer; 0, negatives and other
//   values are rejected with BAD_USER_INPUT instead of reaching SQL (where a
//   negative LIMIT means "no limit" in SQLite, and 0 used to crash cursor
//   construction).
// - A value above MAX_PAGE_SIZE is served as MAX_PAGE_SIZE. For `invoices`
//   that is ordinary connection paging (`pageInfo.hasNextPage` stays true);
//   either way the response carries a PAGE_SIZE_CLAMPED warning.
// - An `after` cursor that does not decode is rejected. It used to be ignored,
//   which restarted paging from the first invoice and returned duplicates.
// - Any cap on an unpaginated list is reported as RESULT_TRUNCATED.
//
// Warnings are returned in the standard `extensions` member of the response:
// `{ "extensions": { "warnings": [{ "code", "field", "message", ... }] } }`.

export const MAX_PAGE_SIZE = 100;
/** Row cap applied by `getEvents()` when no invoiceId is given. */
export const EVENTS_UNFILTERED_CAP = 1000;

export interface GraphQLWarning {
  code: 'PAGE_SIZE_CLAMPED' | 'RESULT_TRUNCATED';
  field: string;
  message: string;
  [key: string]: unknown;
}

interface GraphQLRequestContext {
  warnings?: GraphQLWarning[];
}

function warn(context: GraphQLRequestContext | undefined, warning: GraphQLWarning): void {
  if (!context) return;
  (context.warnings ??= []).push(warning);
}

/**
 * A client-facing input error. Built with Yoga's helper so Yoga recognises it
 * and does not mask it as INTERNAL_SERVER_ERROR.
 */
function badInput(message: string, argument: string): GraphQLError {
  return createGraphQLError(message, { extensions: { code: 'BAD_USER_INPUT', argument } });
}

function pageSize(
  requested: number | null | undefined,
  argument: string,
  fallback: number,
  max: number,
  context: GraphQLRequestContext | undefined
): number {
  if (requested === undefined || requested === null) return fallback;
  if (!Number.isInteger(requested) || requested < 1) {
    throw badInput(`${argument} must be a positive integer`, argument);
  }
  if (requested > max) {
    warn(context, {
      code: 'PAGE_SIZE_CLAMPED',
      field: argument,
      message: `${argument} is capped at ${max}; ${max} results were requested from the database instead of ${requested}`,
      requested,
      served: max,
    });
    return max;
  }
  return requested;
}

/** The invoice id inside an `invoices` cursor, or null when it is not one. */
export function decodeInvoiceCursor(cursor: string): number | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cursor)) return null;
  const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
  if (!/^\d+$/.test(decoded)) return null;
  const id = Number(decoded);
  return Number.isSafeInteger(id) ? id : null;
}

// ─── Query depth and cost limits (#1444) ────────────────────────────────────
//
// Enforced as a GraphQL validation rule, so they apply to every transport the
// schema is served on (POST, GET, the WebSocket server in graphql/server.ts)
// and run before any resolver. Fragments and inline fragments are expanded.
//
// Cost model: every field costs 1. A root list field multiplies the cost of its
// selection by how many items it can return: the literal `first` / `limit`
// argument (capped at MAX_PAGE_SIZE), its default when absent, or the
// maximum when the size comes from a variable (validation cannot see variable
// values, so it assumes the worst case). A full 100-invoice page with every
// field costs about 1 400, so MAX_GRAPHQL_COST allows one such page plus the
// usual stats alongside it, and rejects multiplying pages through aliases.
//
// Depth counts nested fields: `invoices { edges { node { id } } }` is 4.
// Introspection (`__schema`, `__type`) has its own, larger depth allowance so
// GraphiQL's introspection query keeps working.

export const MAX_GRAPHQL_DEPTH = 5;
export const MAX_GRAPHQL_INTROSPECTION_DEPTH = 15;
export const MAX_GRAPHQL_COST = 2500;

/** How many items a list field can return, by argument. */
const LIST_FIELDS: Record<string, { argument?: string; fallback: number }> = {
  invoices: { argument: 'first', fallback: MAX_PAGE_SIZE },
  topLPs: { argument: 'limit', fallback: 10 },
  // Not paginated: assume a full page so they still cost something.
  events: { fallback: MAX_PAGE_SIZE },
  history: { fallback: MAX_PAGE_SIZE },
};
/** The WebSocket server's schema pages invoices with `limit` instead of `first`. */
const LIST_SIZE_ARGUMENTS = ['first', 'limit'];

function listMultiplier(field: FieldNode): number {
  const spec = LIST_FIELDS[field.name.value];
  if (!spec) return 1;
  const arg = field.arguments?.find((a) =>
    spec.argument ? a.name.value === spec.argument : LIST_SIZE_ARGUMENTS.includes(a.name.value)
  ) ?? field.arguments?.find((a) => LIST_SIZE_ARGUMENTS.includes(a.name.value));
  if (!arg) return spec.fallback;
  return sizeFromValue(arg.value, spec.fallback);
}

function sizeFromValue(value: ValueNode, fallback: number): number {
  if (value.kind === Kind.INT) {
    const n = Number(value.value);
    return Math.max(1, Math.min(n, MAX_PAGE_SIZE));
  }
  if (value.kind === Kind.NULL) return fallback;
  return MAX_PAGE_SIZE; // variable or anything else: worst case
}

interface Measure {
  cost: number;
  depth: number;
  introspectionDepth: number;
}

type FragmentLookup = (name: string) => FragmentDefinitionNode | undefined | null;

function measureSelectionSet(
  getFragment: FragmentLookup,
  selectionSet: SelectionSetNode,
  inIntrospection: boolean,
  visitingFragments: Set<string>,
  isRoot = false
): Measure {
  const total: Measure = { cost: 0, depth: 0, introspectionDepth: 0 };
  for (const selection of selectionSet.selections) {
    let child: Measure;
    if (selection.kind === Kind.FIELD) {
      child = measureField(getFragment, selection, inIntrospection, visitingFragments, isRoot);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      child = measureSelectionSet(getFragment, selection.selectionSet, inIntrospection, visitingFragments, isRoot);
    } else {
      const name = selection.name.value;
      const fragment = getFragment(name);
      // Unknown or cyclic fragments are reported by the standard rules.
      if (!fragment || visitingFragments.has(name)) continue;
      visitingFragments.add(name);
      child = measureSelectionSet(getFragment, fragment.selectionSet, inIntrospection, visitingFragments, isRoot);
      visitingFragments.delete(name);
    }
    total.cost += child.cost;
    total.depth = Math.max(total.depth, child.depth);
    total.introspectionDepth = Math.max(total.introspectionDepth, child.introspectionDepth);
  }
  return total;
}

function measureField(
  getFragment: FragmentLookup,
  field: FieldNode,
  inIntrospection: boolean,
  visitingFragments: Set<string>,
  isRoot: boolean
): Measure {
  const name = field.name.value;
  if (name === '__typename') return { cost: 0, depth: 0, introspectionDepth: 0 };
  const introspection = inIntrospection || name === '__schema' || name === '__type';
  const inner = field.selectionSet
    ? measureSelectionSet(getFragment, field.selectionSet, introspection, visitingFragments)
    : { cost: 0, depth: 0, introspectionDepth: 0 };
  // Only root Query fields are paged lists; a nested field that happens to
  // share a name (the WebSocket schema's InvoicePage.invoices) is not
  // multiplied a second time.
  const cost = 1 + (isRoot ? listMultiplier(field) : 1) * inner.cost;
  if (introspection) {
    return { cost, depth: 0, introspectionDepth: inner.introspectionDepth + 1 };
  }
  return { cost, depth: inner.depth + 1, introspectionDepth: inner.introspectionDepth };
}

/** Depth and cost of one operation, with fragments expanded. */
export function measureOperation(operation: OperationDefinitionNode, getFragment: FragmentLookup): Measure {
  return measureSelectionSet(getFragment, operation.selectionSet, false, new Set(), true);
}

/** The limit violations of one operation, as `{ message, extensions }` pairs. */
function limitViolations(
  operation: OperationDefinitionNode,
  getFragment: FragmentLookup
): Array<{ message: string; extensions: Record<string, unknown> }> {
  const { cost, depth, introspectionDepth } = measureOperation(operation, getFragment);
  const violations: Array<{ message: string; extensions: Record<string, unknown> }> = [];
  if (depth > MAX_GRAPHQL_DEPTH || introspectionDepth > MAX_GRAPHQL_INTROSPECTION_DEPTH) {
    const introspection = introspectionDepth > MAX_GRAPHQL_INTROSPECTION_DEPTH;
    const limit = introspection ? MAX_GRAPHQL_INTROSPECTION_DEPTH : MAX_GRAPHQL_DEPTH;
    violations.push({
      message: `GraphQL query is too deep (maximum depth is ${limit}).`,
      extensions: { code: 'QUERY_TOO_DEEP', depth: introspection ? introspectionDepth : depth, limit },
    });
  }
  if (cost > MAX_GRAPHQL_COST) {
    violations.push({
      message: `GraphQL query is too complex (maximum complexity is ${MAX_GRAPHQL_COST}).`,
      extensions: { code: 'QUERY_TOO_COMPLEX', cost, limit: MAX_GRAPHQL_COST },
    });
  }
  return violations;
}

/**
 * Check a parsed document against the limits without the `graphql` runtime's
 * validation machinery. Used by the WebSocket server, whose schema is built by
 * @graphql-tools and may come from a different `graphql` instance than this
 * module's (mixing them throws "from another module or realm").
 */
export function checkQueryLimits(
  document: DocumentNode,
  operationName?: string | null
): Array<{ message: string; extensions: Record<string, unknown> }> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  const operations: OperationDefinitionNode[] = [];
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
    if (definition.kind === Kind.OPERATION_DEFINITION) operations.push(definition);
  }
  const selected = operationName
    ? operations.filter((op) => op.name?.value === operationName)
    : operations;
  return selected.flatMap((op) => limitViolations(op, (name) => fragments.get(name)));
}

/**
 * Validation rule rejecting operations above the depth or cost limits. Each
 * error carries `extensions.code` (`QUERY_TOO_DEEP` / `QUERY_TOO_COMPLEX`) and
 * the measured value next to the limit.
 */
export function queryLimitsRule(context: ValidationContext): ASTVisitor {
  return {
    OperationDefinition(operation) {
      for (const violation of limitViolations(operation, (name) => context.getFragment(name))) {
        context.reportError(new GraphQLError(violation.message, { nodes: [operation], extensions: violation.extensions }));
      }
      return false;
    },
  };
}

// ─── Yoga handler factory ─────────────────────────────────────────────────────

/** Envelop plugin: adds the limits rule and returns collected warnings. */
const queryLimitsPlugin = {
  onValidate({ addValidationRule }: { addValidationRule: (rule: typeof queryLimitsRule) => void }) {
    addValidationRule(queryLimitsRule);
  },
  onExecute() {
    return {
      onExecuteDone({
        args,
        result,
        setResult,
      }: {
        args: { contextValue: GraphQLRequestContext };
        result: unknown;
        setResult: (result: unknown) => void;
      }) {
        const warnings = args.contextValue?.warnings;
        if (!warnings?.length || !result || typeof result !== 'object' || Symbol.asyncIterator in result) return;
        const executed = result as { extensions?: Record<string, unknown> };
        setResult({ ...executed, extensions: { ...executed.extensions, warnings } });
      },
    };
  },
};

/**
 * The indexer's GraphQL endpoint (Yoga). Mounted with `app.use('/graphql',
 * handler)`; it is also a Fetch handler (`handler.fetch(request)`) for tests.
 *
 * Yoga is returned directly: it handles Node requests itself. The previous
 * wrapper re-parsed POST bodies with Fetch APIs, which Express requests do not
 * have, so every HTTP request through the app hung (#1444).
 */
export function createGraphQLHandler() {
  const schema = createSchema({ typeDefs, resolvers });
  return createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    graphiql: process.env.NODE_ENV !== 'production',
    logging: false,
    // Yoga enables CORS by default and reflects any Origin with credentials.
    // No ILN service grants cross-origin reads (docs/threat-model.md TM-2.2);
    // /graphql now matches the REST API, which sends no CORS headers (#1447).
    cors: false,
    plugins: [queryLimitsPlugin],
  });
}
