// The shape every OAuth check answers in: the value the check produced, or the error response to
// send. A handler returns `outcome.response` on failure and reads the named fields on success.
export type Checked<T extends object> = ({ ok: true } & T) | { ok: false; response: Response };

/** The failure half of a `Checked`. */
export function fail(response: Response): { ok: false; response: Response } {
  return { ok: false, response };
}
