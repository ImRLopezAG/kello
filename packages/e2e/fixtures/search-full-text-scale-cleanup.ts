// Private resource protocol shared by the scale fixture and its offline fault proof.
type PrimaryFailure = { error: unknown } | undefined;
type CleanupOperation = () => Promise<void>;

function report(errors: unknown[], primary: PrimaryFailure, message: string) {
  if (errors.length)
    throw new AggregateError(
      primary ? [primary.error, ...errors] : errors,
      message,
      primary ? { cause: primary.error } : undefined,
    );
}

export async function cleanupScaleFixture(
  connections: readonly { close: () => Promise<void> }[],
  ownedCleanup: readonly CleanupOperation[],
  primary: PrimaryFailure,
) {
  const errors: unknown[] = [];
  // Defer invocation so even a synchronous close failure cannot prevent another
  // close from starting. DDL must wait for every actual close to settle.
  const closures = connections.map((connection) => Promise.resolve().then(() => connection.close()));
  for (const result of await Promise.allSettled(closures)) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  for (const operation of ownedCleanup) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  report(errors, primary, "U5 scale fixture cleanup failed");
}

export async function cleanupScaleTransaction(
  rollback: CleanupOperation | undefined,
  release: (destroy: boolean) => void,
  primary: PrimaryFailure,
  pending?: Promise<unknown>,
) {
  const errors: unknown[] = [];
  let destroy = false;
  try {
    await rollback?.();
  } catch (error) {
    destroy = true;
    errors.push(error);
  }
  try {
    release(destroy);
  } catch (error) {
    errors.push(error);
  }
  // Release/destroy before draining the request blocked by this transaction.
  // A failed release must still leave this function owning request settlement.
  try {
    await pending;
  } catch (error) {
    errors.push(error);
  }
  report(errors, primary, "U5 scale rollback/release failed");
}
