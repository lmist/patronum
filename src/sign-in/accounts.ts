/**
 * Single Instagram account loaded from environment variables.
 * Multi-account accounts.json support has been removed.
 */

export type Account = {
  user: string;
  pass: string;
  /** Optional — omit if the account has no authenticator 2FA. */
  totp_secret?: string;
  email?: string;
  "email-pass"?: string;
};

/**
 * Load the sole configured Instagram account from env:
 *   IG_USER / INSTAGRAM_USER
 *   IG_PASS / INSTAGRAM_PASS / IG_PASSWORD
 *   IG_TOTP_SECRET / INSTAGRAM_TOTP_SECRET (optional)
 */
/**
 * No account is configured. It is a sign-in failure (exit 3), not a transient
 * one: retrying cannot help until .env names an account.
 */
export class MissingCredentialsError extends Error {
  readonly code = "auth" as const;
  readonly state = "missing-credentials" as const;
  constructor() {
    super("Instagram credentials missing. Set IG_USER and IG_PASS in .env");
    this.name = "MissingCredentialsError";
  }
}

export function getAccount(): Account {
  const user =
    process.env.IG_USER?.trim() ||
    process.env.INSTAGRAM_USER?.trim() ||
    "";
  const pass =
    process.env.IG_PASS?.trim() ||
    process.env.INSTAGRAM_PASS?.trim() ||
    process.env.IG_PASSWORD?.trim() ||
    "";
  const totp_secret =
    process.env.IG_TOTP_SECRET?.trim() ||
    process.env.INSTAGRAM_TOTP_SECRET?.trim() ||
    undefined;

  if (!user || !pass) {
    throw new MissingCredentialsError();
  }

  return {
    user,
    pass,
    ...(totp_secret ? { totp_secret } : {}),
  };
}
