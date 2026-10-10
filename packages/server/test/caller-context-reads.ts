// Which keys of `CallerContext` does the dispatch pipeline READ? Answered from the type checker,
// not from a regex over `ctx.<key>`: a regex misses `const { roots } = ctx`, `ctx["roots"]`, and
// any read through a helper whose parameter is `CallerContext` (or a `Pick` of it), which is how a
// policy input can be read by dispatch while the offload table calls it "dropped".
//
// The checker is `typescript@7`'s native API (`typescript/unstable/sync`, which drives the bundled
// tsgo): there is no classic `ts.createProgram` on this pin. A read is any member access whose
// property symbol is declared inside `interface CallerContext`, whatever the expression's static
// type is spelled as (`CallerContext`, `CallerContext | undefined`, `Pick<CallerContext, ...>`).
import { join } from "node:path";
import {
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isIdentifier,
  isInterfaceDeclaration,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { API, type NodeHandle, type Project } from "typescript/unstable/sync";

export interface Read {
  key: string;
  file: string;
  form: "property" | "element" | "destructure" | "assignment-destructure";
}

/** A key the scan cannot name: the read may be of ANY key, so it is reported, never skipped. */
export const UNNAMED_READS = ["*dynamic*", "*rest*"] as const;

export interface CallerContextScan {
  /** Every file scanned: the roots plus each helper module reached through a call that takes a CallerContext. */
  files: string[];
  reads: Read[];
}

const sourceFileOf = (node: Node): SourceFile | undefined => {
  let n: Node | undefined = node;
  while (n && n.kind !== SyntaxKind.SourceFile) n = n.parent;
  return n as SourceFile | undefined;
};

/** Open the server project once; the scan reuses it for the real files and for the fixture. */
export function openProject(packageDir: string): { project: Project; close: () => void } {
  const api = new API({ cwd: packageDir });
  const configFile = join(packageDir, "tsconfig.json");
  const snapshot = api.updateSnapshot({ openProject: configFile });
  const project = snapshot.getProject(configFile) ?? snapshot.getProjects()[0];
  if (!project) throw new Error("tsconfig project did not load");
  return { project, close: () => api.close() };
}

/**
 * Scan `roots`, then every helper module they call with a CallerContext argument, to a fixpoint.
 * `within` bounds the helper walk to the repo's own source (never node_modules or lib files).
 */
export function scanCallerContextReads(
  project: Project,
  roots: readonly string[],
  within: string,
): CallerContextScan {
  const checker = project.checker;
  type T = ReturnType<typeof checker.getTypeAtLocation>;
  const declaredInCallerContext = (sym: { declarations: readonly NodeHandle[] } | undefined) =>
    (sym?.declarations ?? []).some((d) => {
      const owner = d.resolve(project)?.parent;
      return !!owner && isInterfaceDeclaration(owner) && owner.name.text === "CallerContext";
    });
  const nonNullable = (type: T): T => (type ? (checker.getNonNullableType(type) ?? type) : type);
  const isCallerContextKey = (type: T, key: string): boolean =>
    !!type && declaredInCallerContext(checker.getPropertyOfType(nonNullable(type) as never, key));
  /** Is this value a CallerContext (or a slice of one)? For reads whose key is not a literal. */
  const isCallerContextValue = (type: T): boolean =>
    !!type &&
    checker.getPropertiesOfType(nonNullable(type) as never).some((p) => declaredInCallerContext(p));
  const literalKey = (n: Node): string | undefined =>
    isStringLiteral(n) || isNoSubstitutionTemplateLiteral(n) ? n.text : undefined;
  const nameText = (n: Node | undefined): string | undefined =>
    n && (isIdentifier(n) ? n.text : literalKey(n));

  const reads: Read[] = [];
  const scanned = new Set<string>();
  const queue = [...roots];
  const mentionsCallerContext = (node: Node): boolean => {
    const sig = checker.getResolvedSignature(node);
    if (!sig) return false;
    return sig.getParameters().some((p) => {
      const t = checker.getTypeOfSymbol(p);
      return !!t && /\bCallerContext\b/.test(checker.typeToString(t));
    });
  };

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (scanned.has(file)) continue;
    scanned.add(file);
    const sf = project.program.getSourceFile(file);
    if (!sf) throw new Error(`not part of the project: ${file}`);
    const add = (key: string, form: Read["form"]) => reads.push({ key, file, form });
    const visit = (node: Node): void => {
      if (isPropertyAccessExpression(node)) {
        const parent = node.parent;
        const isWrite =
          parent !== undefined &&
          isBinaryExpression(parent) &&
          parent.operatorToken.kind === SyntaxKind.EqualsToken &&
          parent.left.pos === node.pos &&
          parent.left.end === node.end;
        const isDelete = parent !== undefined && isDeleteExpression(parent);
        const key = node.name.text;
        if (
          !isWrite &&
          !isDelete &&
          isCallerContextKey(checker.getTypeAtLocation(node.expression), key)
        )
          add(key, "property");
      } else if (isElementAccessExpression(node)) {
        const type = checker.getTypeAtLocation(node.expression);
        const key = literalKey(node.argumentExpression);
        if (key !== undefined) {
          if (isCallerContextKey(type, key)) add(key, "element");
        } else if (isCallerContextValue(type)) {
          add("*dynamic*", "element");
        }
      } else if (isObjectBindingPattern(node)) {
        const type = checker.getTypeAtLocation(node);
        for (const el of node.elements) {
          if (!isBindingElement(el)) continue;
          if (el.dotDotDotToken) {
            if (isCallerContextValue(type)) add("*rest*", "destructure");
            continue;
          }
          const key = nameText(el.propertyName) ?? nameText(el.name);
          if (key !== undefined && isCallerContextKey(type, key)) add(key, "destructure");
        }
      } else if (
        isBinaryExpression(node) &&
        node.operatorToken.kind === SyntaxKind.EqualsToken &&
        isObjectLiteralExpression(node.left)
      ) {
        const type = checker.getTypeAtLocation(node.right);
        for (const p of node.left.properties) {
          const key =
            isShorthandPropertyAssignment(p) || isPropertyAssignment(p)
              ? nameText(p.name)
              : undefined;
          if (key !== undefined && isCallerContextKey(type, key))
            add(key, "assignment-destructure");
        }
      } else if (isCallExpression(node) && mentionsCallerContext(node)) {
        const decl = checker.getResolvedSignature(node)?.declaration?.resolve(project);
        const declFile = decl && sourceFileOf(decl)?.fileName;
        if (declFile?.startsWith(within) && !declFile.includes("/node_modules/"))
          queue.push(declFile);
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return { files: [...scanned], reads };
}

/** The reads whose key the offload table calls `dropped`: dispatch reads them, so they must not be. */
export function droppedButRead(
  reads: readonly Read[],
  table: Readonly<Record<string, { how: string } | undefined>>,
): string[] {
  return [
    ...new Set(reads.filter((r) => table[r.key]?.how === "dropped").map((r) => r.key)),
  ].sort();
}
