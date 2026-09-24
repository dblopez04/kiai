/** An error whose message is meant for the user as-is: printed or shown without a stack trace. */
export class UserError extends Error {
  override name = "UserError";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
