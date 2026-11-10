// Remove credentials before output reaches disk or the dashboard.
export function redact(text: string): string {
  let safe = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 4 && /(?:KEY|PASS|SECRET|TOKEN|COOKIE)/i.test(key)) safe = safe.split(value).join("[redacted]");
  }
  return safe.replace(/((?:password|passwd|sessionid|ds_user_id|access_token|api_key|totp|verification.code)["\']?\s*[=:]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[\w.\-]+/gi, "$1[redacted]")
    .replace(/((?:security|verification|authenticator|email|login|totp)\s+code\s+(?:is\s+)?)[0-9]{4,8}\b/gi, "$1[redacted]");
}
