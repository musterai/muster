# Collection pagination contract

Muster collection reads use bounded, cursor-based pagination. This applies to
cards and card search, boards, agents, documents, activity, knowledge bases,
knowledge facts/entities, and knowledge search through REST and MCP.

## Request

- `limit` is optional, defaults to `50` (`20` for search), and must be an
  integer from `1` through `100`. Negative, fractional, repeated, non-numeric,
  and larger values are rejected with a structured validation error.
- `cursor` is optional. It is an opaque, URL-safe value returned by the
  immediately preceding page. Clients must not parse, edit, retain forever,
  or reuse it with different filters or a different collection.
- A malformed cursor, a cursor bound to other filters, or an unsupported
  cursor version returns `400 VALIDATION_ERROR` with
  `details.code = "INVALID_CURSOR"`.

## Response

REST and MCP return the same envelope:

```json
{
  "items": [],
  "page": {
    "limit": 50,
    "has_more": false,
    "next_cursor": null
  }
}
```

Knowledge search preserves its two result categories and adds the same page
metadata beside `facts` and `entities`. Board detail keeps its historical
`cards` array for UI compatibility, but the array is one bounded page and its
metadata is named `card_page`; callers continue through `list_cards` or the
REST card-list route.

All orders use an immutable ID tie-breaker. Keyset predicates prevent a newly
inserted row at the front of a descending feed from duplicating rows already
seen. A row whose ordering field changes while a traversal is in progress may
move between pages; clients that require a snapshot must restart after a
mutation.

## Summary and detail representations

Collection rows intentionally omit large untrusted bodies:

- card lists/search omit `description`;
- document lists omit Markdown `content`;
- knowledge fact lists/search omit fact `content`.

Use `get_card`, `get_document`, and `get_gained_knowledge` (or the equivalent
REST detail endpoint) for a selected resource. The SPA follows pages
automatically and loads detail bodies through those authorized endpoints.

## Migration notes

Before this contract, REST and MCP returned raw arrays and some routes had no
limit. Consumers must read `items` plus `page` and pass `next_cursor` unchanged.
For board detail, read `card_page`; existing `cards` rendering remains valid for
the first page. Do not emulate pagination with offsets: the server intentionally
does not expose them.

The operational response budget is at most 100 summary rows per collection
page. For the isolated SQLite CI fixture (105 cards with maximum-size-like
descriptions), a 100-card summary page must serialize below 100 KB and complete
the service query in under 250 ms. The schema migration adds composite indexes
aligned with each cursor order, avoiding offset scans as workspaces grow.
