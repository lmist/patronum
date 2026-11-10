export function collectionRecovery(errorText: string | null | undefined) {
  const rejected = /instagram_http_rejection|http_rejected|ERR_HTTP_RESPONSE_CODE_FAILURE|HTTP\s+(?:403|429)|request(?:s)? rejected/i.test(errorText ?? "");
  return rejected
    ? { account: false, advice: "Instagram rejected a page request. Wait before starting a new collection with the saved post list. Your completed captures are retained." }
    : { account: true, advice: "Inspect the failed stage before retrying. Open Account only if the error identifies a login or session problem." };
}
