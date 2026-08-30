/**
 * See exactly which rows a Postgres INSERT, UPDATE or DELETE would write,
 * before it runs, then apply only the rows that were reviewed and only if none
 * of them have changed since.
 *
 * ```ts
 * const pg = createDryRunner({ url: process.env.DATABASE_URL });
 *
 * const proposal = await pg.propose(
 *   "UPDATE profiles SET status = $1 WHERE email LIKE $2",
 *   ["suspended", "%@acme.com"],
 * );
 *
 * proposal.rowCount; // 14, not the 1 you expected
 *
 * if (await yourApprovalFlow(proposal)) await pg.apply(proposal);
 * ```
 */

export type { Driver, Row, Sql } from "./driver.js";
export type { DryRunner, DryRunnerOptions } from "./dry-runner.js";
export { createDryRunner } from "./dry-runner.js";
export {
  PgDryRunError,
  ProposalExpiredError,
  StateChangedError,
  TooManyRowsError,
  type UnsupportedReason,
  UnsupportedStatementError,
} from "./errors.js";
export type { PostgresDriverOptions } from "./postgres-driver.js";
export { postgresDriver } from "./postgres-driver.js";
export type {
  ApplyPlan,
  CascadeNode,
  DriftedRow,
  FieldChange,
  Proposal,
  Receipt,
  ReferentialAction,
  RowChange,
  StatementKind,
  TableRef,
  Warning,
  WarningCode,
} from "./types.js";
