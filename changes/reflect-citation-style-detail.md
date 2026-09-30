---
type: Added
---
- **`reflect` takes `citation_style` and `detail`.** `citation_style: "numeric" | "wikilink"`
  (default `numeric`, today's behaviour) renders each `[n]` citation as `[[path]]` in both the
  returned answer and a `persist: true` note; the rewrite is deterministic from the evidence the
  model was shown, an `[n]` with no matching evidence is left as written and listed in the new
  `unresolved_citations` output field. `detail: "concise" | "standard" | "thorough"` (default
  `concise`, today's behaviour) sets how much the synthesis says; it is a prompt instruction only,
  with no output cap. Both can be defaulted per vault under `vaults[].reflect`
  (`citationStyle`, `detail`); precedence is call argument, then vault config, then the default.
  With both omitted the synthesis prompt is byte-identical to before.
