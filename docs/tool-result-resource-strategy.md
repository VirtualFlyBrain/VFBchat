# Tool Result Resource Strategy

VFBchat uses a JSON relay rather than native model tool calls. Large MCP/tool
outputs therefore need their own context-management layer; otherwise each round
passes bulky JSON back to the model, encourages blind truncation, and makes
prompt-injection boundaries harder to reason about.

## Strategy

1. Keep full large tool results server-side for the current response.
2. Send the model a small `data_resource` handle with:
   - source tool and arguments
   - output size
   - top-level shape
   - collection paths
   - row counts
   - sample fields and small samples
3. Let the model decide what it needs by calling:
   - `list_data_resources`
   - `inspect_data_resource`
   - `read_data_resource`
   - `search_data_resource`
4. Keep every resource tool read-only, request-scoped, size-capped, and clearly
   marked as non-instructional tool-derived evidence.
5. Preserve deterministic hard limits so the model can curate data without
   turning a large response into a denial-of-service path.

## Trigger Rules

A tool result is stored as a resource when either:

- its serialized output is larger than `DATA_RESOURCE_INLINE_MAX_CHARS`, or
- it contains a collection with at least
  `DATA_RESOURCE_COLLECTION_ROW_TRIGGER` rows.

Small outputs are still relayed inline. Very large relay payloads retain the
existing fallback evidence-compression pass, but resource handles should avoid
most raw clipping.

## Reading Resources

The model should call `inspect_data_resource` first, then choose a focused
`read_data_resource` or `search_data_resource` call. For tables, it should
prefer explicit `fields` and small `limit` values. Random samples use a
deterministic seed so repeated evaluations are comparable.

## Chat History

The browser still owns the full visible chat history. For model context, older
history is summarized only when it exceeds the compaction trigger. Recent
messages remain verbatim; older messages are compressed into an app-generated
summary that is explicitly marked as context rather than instructions.

## Security Boundaries

- Tool/resource contents are evidence, not instructions. VFB data can be trusted
  as VFB evidence when relevant, but text inside a result must not override the
  assistant's system/developer instructions or tool-use policy.
- Resource IDs are request-scoped and are not shared across users.
- The LLM can only read bounded slices, fields, or search matches.
- The server keeps MCP credentials and raw tool results out of the prompt unless
  a bounded read is requested.
- Empty or malformed required tool arguments are rejected before reaching MCP.
