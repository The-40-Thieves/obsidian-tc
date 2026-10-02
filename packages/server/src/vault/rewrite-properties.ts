// Link rewriting inside a note's frontmatter PROPERTIES (rename propagation, Obsidian parity).
// A rewritten target is a new YAML value, so it is written per the scalar's own quoting style
// (double: JSON escapes, single: doubled quote, plain: unchanged unless that would change the
// meaning, then double-quoted; block scalars hold literal text) and PROVEN: the block is re-parsed
// and must differ from the original only by the intended string. A property that cannot be proven
// is left byte-identical and reported, never half-applied. Everything outside the rewritten scalar
// ranges (other keys, comments, spacing) is source text, copied verbatim.
import YAML, { type Document, isMap, isNode, isScalar, type Scalar } from "yaml";
import type { LinkKind } from "./links";

export type TargetMapper = (target: string, kind: LinkKind) => string | null;
/** The body rewriter (fence-aware, link-syntax aware), passed in so this file stays acyclic. */
export type TextRewriter = (text: string, map: TargetMapper) => { text: string; count: number };

export interface PropertyRewriteWarning {
  /** The top-level property left unchanged; absent for a whole-block problem. */
  property?: string;
  message: string;
}

export interface PropertyRewrite {
  text: string;
  count: number;
  warnings: PropertyRewriteWarning[];
}

const LINKISH = /\[\[|\]\(/;

/** One token per node, in document order: enough to prove two parses differ only where intended. */
function signature(doc: Document): { tokens: string[]; index: Map<Scalar, number> } {
  const tokens: string[] = [];
  const index = new Map<Scalar, number>();
  YAML.visit(doc, {
    Scalar(_k, node) {
      index.set(node, tokens.length);
      tokens.push(scalarToken(node, node.value));
    },
    Map: (_k, node) => void tokens.push(`m:${node.items.length}`),
    Seq: (_k, node) => void tokens.push(`q:${node.items.length}`),
    Alias: (_k, node) => void tokens.push(`a:${node.source}`),
  });
  return { tokens, index };
}

const scalarToken = (node: Scalar, value: unknown): string =>
  `s:${typeof value}:${String(value)}:${node.anchor ?? ""}:${node.tag ?? ""}`;

interface Edit {
  start: number;
  end: number;
  text: string;
  at: number;
  token: string;
  count: number;
}

/** Rewrite the links in the string properties of `yamlText` (the text between the `---` lines).
 *  Returns null when it is not valid YAML: the caller decides what to do with a broken block. */
export function rewriteFrontmatterProperties(
  yamlText: string,
  map: TargetMapper,
  rewriteText: TextRewriter,
): PropertyRewrite | null {
  const doc = YAML.parseDocument(yamlText);
  if (doc.errors.length > 0) return null;
  const warnings: PropertyRewriteWarning[] = [];
  if (!isMap(doc.contents)) return { text: yamlText, count: 0, warnings };
  const base = signature(doc);
  // A block scalar is rewritten as source text but proven against its value; the mapper is the
  // caller's (it may count calls), so the value pass replays what the source pass answered.
  const memo = new Map<string, string | null>();
  const recording: TargetMapper = (t, k) => {
    const r = map(t, k);
    memo.set(`${k}\0${t}`, r);
    return r;
  };
  const replay: TargetMapper = (t, k) => memo.get(`${k}\0${t}`) ?? null;

  const proves = (head: string, at: number, token: string): boolean => {
    const d = YAML.parseDocument(head);
    if (d.errors.length > 0) return false;
    const { tokens } = signature(d);
    return (
      tokens.length === base.tokens.length &&
      tokens.every((t, i) => t === (i === at ? token : base.tokens[i]))
    );
  };

  const edits: Edit[] = [];
  for (const pair of doc.contents.items) {
    if (!isNode(pair.value)) continue;
    const property = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const mine: Edit[] = [];
    let refused = false;
    YAML.visit(pair.value, {
      Scalar(key, node) {
        const range = node.range;
        const at = base.index.get(node);
        if (key === "key" || typeof node.value !== "string" || !range || at === undefined) return;
        if (!LINKISH.test(node.value) || refused) return;
        const block = node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED";
        let value: string;
        let count: number;
        let candidates: string[];
        if (block) {
          const r = rewriteText(yamlText.slice(range[0], range[1]), recording);
          value = rewriteText(node.value, replay).text;
          count = r.count;
          candidates = [r.text];
        } else {
          const r = rewriteText(node.value, map);
          value = r.text;
          count = r.count;
          const double = JSON.stringify(value);
          const oneLine = !value.includes("\n");
          candidates =
            node.type === "QUOTE_DOUBLE"
              ? [double]
              : node.type === "QUOTE_SINGLE"
                ? [...(oneLine ? [`'${value.replaceAll("'", "''")}'`] : []), double]
                : [...(oneLine ? [value] : []), double];
        }
        if (count === 0) return;
        const token = scalarToken(node, value);
        const ok = candidates.find((c) =>
          proves(yamlText.slice(0, range[0]) + c + yamlText.slice(range[1]), at, token),
        );
        if (ok === undefined) refused = true;
        else mine.push({ start: range[0], end: range[1], text: ok, at, token, count });
      },
    });
    if (refused)
      warnings.push({
        property,
        message: `property "${property}" not rewritten: the new link target cannot be written as a valid YAML value there, so the property was left unchanged`,
      });
    else edits.push(...mine);
  }
  if (edits.length === 0) return { text: yamlText, count: 0, warnings };

  let out = yamlText;
  for (const e of [...edits].sort((a, b) => b.start - a.start))
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  const expected = base.tokens.slice();
  for (const e of edits) expected[e.at] = e.token;
  const final = YAML.parseDocument(out);
  const got = signature(final).tokens;
  if (
    final.errors.length > 0 ||
    got.length !== expected.length ||
    got.some((t, i) => t !== expected[i])
  )
    return {
      text: yamlText,
      count: 0,
      warnings: [
        ...warnings,
        { message: "frontmatter links not rewritten: the combined edit did not re-parse cleanly" },
      ],
    };
  return { text: out, count: edits.reduce((n, e) => n + e.count, 0), warnings };
}
