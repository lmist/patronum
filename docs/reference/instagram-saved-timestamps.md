# Instagram bookmark timestamps

Verified against an authenticated account on 2026-10-07. Instagram's internal
`IGCrossAppSavesQuery` returns `saved_time` for Instagram bookmarks. This is a
server-reported Unix timestamp in **seconds**, separate from the media's
publication timestamp.

## Verified query

| Property | Value |
| --- | --- |
| Method | `POST` |
| Endpoint | `https://b.i.instagram.com/graphql_www` |
| Friendly name | `IGCrossAppSavesQuery` |
| Client document ID | `125097014114157517169042575661` |
| Root field | `xfb_cross_app_saves_infinite_scroll` |
| Record type | `XFBFXCrossAppSavedContentData` |
| Timestamp field | `edges[].node.saved_time` |

Send the four variables used in the successful reads:

```json
{
  "after": null,
  "first": 30,
  "filters": null,
  "entrypoint": "IGD"
}
```

The request body is form-encoded, with `variables` serialized as JSON:

```python
data = {
    "method": "post",
    "pretty": "false",
    "format": "json",
    "server_timestamps": "true",
    "locale": "user",
    "purpose": "fetch",
    "fb_api_req_friendly_name": "IGCrossAppSavesQuery",
    "client_doc_id": "125097014114157517169042575661",
    "enable_canonical_naming": "true",
    "enable_canonical_variable_overrides": "true",
    "enable_canonical_naming_ambiguous_type_prefixing": "true",
    "variables": json.dumps(variables, separators=(",", ":")),
}
```

The verified native request used `X-FB-Friendly-Name` and `X-Client-Doc-Id`
matching the body, app ID `567067343352427`, native Instagram headers, and the
existing account session. Authentication stayed in memory. The native
authorization format is implemented by
[Instagrapi's session authentication](https://github.com/subzeroid/instagrapi/blob/master/instagrapi/mixins/auth.py);
the request contract is implemented by
[`private_graphql_www_request`](https://github.com/subzeroid/instagrapi/blob/master/instagrapi/mixins/graphql.py).
Never log session cookies or authorization headers.

This query operates on the **authenticated account's saves**. It does not take
an arbitrary Instagram handle. Confirm the account before collecting records.

## Reading the response

With canonical naming enabled, the root key in the live JSON was:

```text
1$xfb_cross_app_saves_infinite_scroll(after:$after,entrypoint:$entrypoint,filters:$filters,first:$first)
```

Find that connection inside `data`; do not assume the first `data` property is
the connection. Other keys can include `__typename` and `strong_id__`.

Each `edges[].node` selects these fields:

```text
author_profile_picture_url  source_app   content_url   carousel_items
title  content_id  author_name  content_type  account_type  author_id
saved_time  thumbnail_url  post_text  media_url
```

- Check `source_app`. Every validated record had the value `Instagram`.
- Use `content_url` to identify the post and extract its shortcode.
- Preserve `content_id` separately. It differed from the media `pk` returned by
  the ordinary saved feed; joining those numeric identifiers directly failed.
- Convert `saved_time` with `datetime.fromtimestamp(value, timezone.utc)` or
  `new Date(value * 1000)`. Store UTC alongside any local display time.
- Read `page_info.has_next_page` and `page_info.end_cursor`. The query accepts
  `after`; continuation was not needed in the eight-record validation.

## Evidence and validation

The operation was recovered from the signed Instagram Android
**449.0.0.52.84**, version code **385511871**, package
`com.instagram.android`. Android's official `apksig` verifier accepted the APK
signatures. Its signer certificate SHA-256 matched a fingerprint published in
[Instagram's own asset links](https://www.instagram.com/.well-known/assetlinks.json):

```text
3A:10:C5:0C:18:BA:93:75:06:C2:87:5E:90:47:BE:74:F8:FD:8B:86:FA:E2:FF:9F:EA:A5:0A:81:FC:B4:C0:14
```

The relevant APK assets were:

```text
assets/ig4a-instagram-schema_client_persist_ids.json
assets/ig4a-instagram-schema_pando_flatbuffer_data.bin
```

The registry provided the client document ID. The Pando metadata linked the
operation to the connection, the record type, and its `saved_time` field. It
also provided the variable names and the client defaults `first: 30` and
`entrypoint: "IGD"`.

## Rediscover from an APK

Run [the discovery script](../../scripts/discover-instagram-saved-query.py) on
an Instagram Android base APK or XAPK. It verifies the APK signature with
Android's `apksig`, checks that the signer appears in Instagram's live Android
asset links, extracts the client operation registry and Pando response tree,
then reports Saved queries whose selected fields contain `saved_time`. The
known document ID and query name are **not inputs** to discovery.

```bash
python3 scripts/discover-instagram-saved-query.py path/to/instagram.apk \
  --apksig-jar path/to/apksig.jar \
  --output data/research/bookmark-dates/discovered-query.json
```

This checkout has the previously verified APK and `apksig` JAR in the ignored
`data/research/bookmark-dates/native/apk/` directory. Repeating the command on
that APK found `IGCrossAppSavesQuery` and its full `saved_time` field path in
seconds. It also found a separate teen-project Saved query; the
response path and account scope distinguish them. For a newer client, supply
its APK and verify the result against a live read on the intended account.
The script does not log into Instagram or send a GraphQL request.
To inspect all selected response fields for another operation in the same
verified client, add `--inspect-query OperationName`; this exposes client
selections, not the complete server schema or authorization to use them.

Live validation established:

1. All eight returned Instagram shortcodes matched the account's ordinary Saved
   feed, with no missing or extra records.
2. `has_next_page` was false.
3. Every save timestamp was after the corresponding publication timestamp.
4. Two independent query responses returned identical save timestamps.
5. No save, unsave, collection, like, follow, or message mutations were used.

Private captures, the verified APK, extraction tools, and readable records are
under the ignored local directory `data/research/bookmark-dates/`. The resulting
records are `saved-dates.json` and `saved-dates.html`; they are not repository
fixtures.

## Limits and misleading alternatives

The verified value is the timestamp on the **current saved entry**. First-ever
save semantics across unsaving and resaving were not tested.

The ordinary saved-feed REST responses and legacy `edge_saved_media` GraphQL
operations did not expose this field in the investigated responses. Their
`taken_at`/`taken_at_timestamp` values describe publication. The timestamp
inside `organic_tracking_token.payload.server_token` changed on each fetch and
tracked response time; it was ruled out as bookmark time.

This is an undocumented internal operation. Client document IDs and response
shapes may change. If it stops working, inspect a current, verified client
registry and operation definition rather than substituting publication time.
The recovered client metadata is not proof of a complete server schema.
