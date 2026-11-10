/**
 * Stable Stagehand instruction strings for Instagram auth.
 * Keep wording fixed so local/server cache keys hit across runs.
 * Secrets go in `variables` (%name%), never interpolated into the string.
 *
 * @see https://docs.stagehand.dev/v3/best-practices/caching
 * @see https://docs.stagehand.dev/v3/best-practices/prompting-best-practices
 */
import { layout } from "../paths.js";

/** Local action cache directory (workflow-scoped). */
export const INSTAGRAM_AUTH_CACHE_DIR = layout.authCache;

// --- Login form (single action per act; label-anchored) ---

export const ACT_TYPE_USERNAME =
  "type %username% into the username, phone number, or email input field";

export const ACT_TYPE_PASSWORD =
  "type %password% into the password input field";

export const ACT_CLICK_LOGIN =
  "click the Log in button on the Instagram login form";

export const OBSERVE_LOGIN_FORM =
  "Find the username, phone number or email text input, the password text input, and the Log in button on the login form";

// --- TOTP / 2FA ---

export const ACT_TYPE_TOTP = "type %totp_code% into the Code input field";

export const ACT_CLICK_TOTP_SUBMIT =
  "click the Continue or Submit button to verify the authentication code";

export const ACT_CLICK_AUTH_APP =
  "click the Authentication app or Authenticator app option";

export const OBSERVE_TOTP_CODE_FIELD =
  "Find the Code input field for the 6-digit authentication code";

export const OBSERVE_TOTP_SUBMIT =
  "Find the Continue or Submit button on the two-factor authentication page";

// --- Email security checkpoint ---

export const OBSERVE_CHECKPOINT_EMAIL_OPTION =
  "Find the option that sends a security code to the account email address";

export const ACT_CLICK_CHECKPOINT_EMAIL_OPTION =
  "click the email option for receiving the security code";

export const OBSERVE_CHECKPOINT_SEND_CODE =
  "Find the Send code, Continue, or Next button that requests the email security code";

export const ACT_CLICK_CHECKPOINT_SEND_CODE =
  "click the Send code, Continue, or Next button to request the email security code";

export const OBSERVE_CHECKPOINT_CODE_FIELD =
  "Find the input for the 6-digit security code sent by email";

export const ACT_TYPE_EMAIL_CODE =
  "type %email_code% into the 6-digit security code input";

export const ACT_CLICK_EMAIL_CODE_SUBMIT =
  "click the Continue, Confirm, or Submit button to verify the emailed security code";

export const OBSERVE_CHECKPOINT_RESEND_CODE =
  "Find the Resend code or Send another code button for the email security code";

export const ACT_CLICK_CHECKPOINT_RESEND_CODE =
  "click the Resend code or Send another code button for the email security code";

// --- Optional UI ---

export const OBSERVE_COOKIE_ACCEPT =
  "Find the Allow all cookies or Accept cookies button on a cookie consent banner";

export const OBSERVE_POST_LOGIN_DISMISS =
  "Find the Not Now button, Save info button, or Close button on a dialog about saving login or notifications";

// --- Variable maps (real helpers — unit-tested) ---

export function usernameVariables(username: string): {
  variables: { username: string };
} {
  return { variables: { username } };
}

export function passwordVariables(password: string): {
  variables: { password: string };
} {
  return { variables: { password } };
}

export function totpVariables(totp_code: string): {
  variables: { totp_code: string };
} {
  return { variables: { totp_code } };
}

export function emailCodeVariables(email_code: string): {
  variables: { email_code: string };
} {
  return { variables: { email_code } };
}

/** Assert instruction never embeds a secret value (for static/unit checks). */
export function instructionContainsSecret(
  instruction: string,
  secret: string,
): boolean {
  if (!secret) return false;
  return instruction.includes(secret);
}
