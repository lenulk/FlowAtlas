# Reuse immutable source path and hash-format checks

Decision date:6October2026,round67. Extend the existing immutable file digest optimization with private, scope-specific path/hash-format results. Keep the snapshot backend and all persistence/acknowledgement policy unchanged.

## Evidence and motivation

Round66's corrected synthetic64-file workload showed substantial save validation time. Inspection found that every retained graph/save scans the same captured frozen source map for path/hash-format checks. Before the repair, a deterministic regression observed three scans for three saves; mutable/accessor/custom-prototype guards already passed. This identifies repeated work independently of timing and does not establish the cause of historical shutdown losses.

The paired local comparison loads exact5ab910d store bytes, verifies unchanged dependencies and supplies identical captured fixture objects to baseline/candidate in five alternating pairs. With64 synthetic source hashes, validation median213.155→40.801ms and total35-save median418.062→259.741ms. With1hash, total median156.249→159.963ms: no overall improvement in that smaller case. These are isolated synthetic save measurements with met=null, not HTTP/SDK or real-app performance acceptance.

## Rules

- Cache only frozen plain/null-prototype maps whose own properties are string data. Accessors, mutable maps and custom prototypes are rescanned. This reuses the existing digest eligibility predicate.
- Cache the existing path/hash-format issue list by file-map identity and tool/project scope in a WeakMap. Project paths and tool-root paths have different rules; a project-only map must still be rejected when reused as a tool snapshot.
- The current graph, source declarations, project ID, file count bounds and claimed digest remain validated for every save/load. Do not cache whole graph validity or accept a changed scalar claim from a prior successful save.
- Invalid immutable path results may be reused, but cannot become acceptance. Issue arrays are private and frozen; callers receive the same diagnostics through the existing save/load behavior.
- Source maps from parsed persisted JSON remain mutable and receive fresh checks. New captured versions have new map identities; the cache makes no claim about actual project registration or permissions beyond the unchanged format rules.

The optimization does not change public API, schema, JSON bytes, limits, timing opt-in, queue capacity, batching, shutdown/upload deadlines, fsync or atomic replacement. Graph mutations and rejected saves must still preserve previously stored bytes. Scope/digest/project-ID/mutable/accessor/prototype negative regressions and76baseline equivalence cases cover these properties. Runtime source serving and SDK/browser verification remain required.

## Risks and rollback

The cache relies on the documented eligibility rule; broadening eligibility to accessors/prototypes would be a separate unsafe change. Scope keys must remain explicit if path policies grow. The WeakMap does not keep otherwise unused source snapshots alive.

Rollback by restoring the inline path/hash loop and removing the path cache. No data migration is needed; existing digest caching can remain. Ordinary performance, stable capture, CLI readiness, sustained load and business-app pilot/user trials are separate open gates. A passing store microbenchmark does not close them.
