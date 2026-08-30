import type { DriftedRow } from "./types.js";

export class PgDryRunError extends Error {
  public override readonly name: string = "PgDryRunError";
}

export type UnsupportedReason =
  | "not_a_single_statement"
  | "unsupported_statement"
  | "unsupported_clause"
  | "missing_where"
  | "multi_table"
  | "unresolvable_assignment"
  | "no_primary_key"
  | "unsupported_type";

/**
 * The statement cannot be previewed faithfully. Refusing is deliberate: an
 * approximate diff is worse than no diff, because it manufactures confidence.
 */
export class UnsupportedStatementError extends PgDryRunError {
  public override readonly name = "UnsupportedStatementError";
  constructor(
    public readonly reason: UnsupportedReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The predicate matched more rows than the enumeration limit.
 *
 * This is a design position, not a defect. An approval names its rows, so the
 * apply carries one tuple per row and cannot scale without bound. Past the
 * limit the operation is no longer a one-off decision a human can review; it
 * belongs in a reviewed, named migration or action.
 */
export class TooManyRowsError extends PgDryRunError {
  public override readonly name = "TooManyRowsError";
  constructor(
    public readonly rowCount: number,
    public readonly limit: number,
  ) {
    super(
      `Statement matches ${rowCount} rows, above the enumeration limit of ${limit}. ` +
        `An approval must name its rows; a change this size belongs in a reviewed migration.`,
    );
  }
}

export class ProposalExpiredError extends PgDryRunError {
  public override readonly name = "ProposalExpiredError";
  constructor(
    public readonly proposalId: string,
    public readonly expiredAt: string,
  ) {
    super(
      `Proposal ${proposalId} expired at ${expiredAt}. Re-run the preview.`,
    );
  }
}

/**
 * At least one previewed row changed before apply. Nothing was written: the
 * apply runs in a single transaction and is rolled back whole.
 */
export class StateChangedError extends PgDryRunError {
  public override readonly name = "StateChangedError";
  constructor(
    public readonly proposalId: string,
    public readonly drifted: readonly DriftedRow[],
  ) {
    super(
      `${drifted.length} of the previewed rows changed since the preview. ` +
        `Nothing was applied. Re-run the preview.`,
    );
  }
}
