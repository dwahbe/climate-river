// lib/domSelectorCompat.ts
//
// jsdom 22 (pinned — see CLAUDE.md gotchas) uses nwsapi as its selector
// engine, which throws SyntaxError on selectors it can't parse — notably
// Defuddle's `header:not(:has(p + p)):not(:has(img))`. Defuddle joins ~150
// cleanup selectors into one group, so the whole querySelectorAll throws,
// its top-level catch kicks in, and it returns the entire serialized <body>
// (site chrome and all) instead of the extracted article.
//
// installSelectorCompat patches a jsdom window so that when a selector group
// fails to parse, each comma-separated branch is retried individually and
// only the unparseable branches are skipped.

export interface SelectorCompatWindow {
  Document: { prototype: Document };
  DocumentFragment: { prototype: DocumentFragment };
  Element: { prototype: Element };
}

const DOCUMENT_POSITION_FOLLOWING = 4;

// Selector parseability depends only on the string, not the document, so
// known-bad branches can be cached across windows and calls.
const unparseableBranches = new Set<string>();
const splitCache = new Map<string, string[]>();

/**
 * Split a selector group on top-level commas, respecting parens, brackets,
 * quotes, and escapes (e.g. `div:not(a, b)` stays one branch).
 */
export function splitSelectorList(selector: string): string[] {
  const cached = splitCache.get(selector);
  if (cached) return cached;

  const branches: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "\\") {
      current += ch + (selector[i + 1] ?? "");
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(" || ch === "[") {
      depth++;
    } else if (ch === ")" || ch === "]") {
      depth--;
    } else if (ch === "," && depth === 0) {
      if (current.trim()) branches.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) branches.push(current.trim());

  splitCache.set(selector, branches);
  return branches;
}

function isSelectorSyntaxError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "SyntaxError"
  );
}

function documentOrder(a: Element, b: Element): number {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

type QueryAll = (this: ParentNode, selectors: string) => NodeListOf<Element>;
type QueryOne = (this: ParentNode, selectors: string) => Element | null;

function collectBranchMatches(
  root: ParentNode,
  originalAll: QueryAll,
  selector: string,
): Element[] {
  const seen = new Set<Element>();
  for (const branch of splitSelectorList(selector)) {
    if (unparseableBranches.has(branch)) continue;
    let matches: NodeListOf<Element>;
    try {
      matches = originalAll.call(root, branch);
    } catch {
      unparseableBranches.add(branch);
      continue;
    }
    for (const el of Array.from(matches)) seen.add(el);
  }
  return Array.from(seen).sort(documentOrder);
}

function patchParentNode(proto: Document | DocumentFragment | Element): void {
  const originalAll = proto.querySelectorAll as QueryAll;
  const originalOne = proto.querySelector as QueryOne;

  const compatAll = function (this: ParentNode, selectors: string) {
    try {
      return originalAll.call(this, selectors);
    } catch (error) {
      if (!isSelectorSyntaxError(error)) throw error;
      // Callers iterate the result; an Element[] is interchangeable here
      return collectBranchMatches(this, originalAll, selectors);
    }
  };
  const compatOne = function (this: ParentNode, selectors: string) {
    try {
      return originalOne.call(this, selectors);
    } catch (error) {
      if (!isSelectorSyntaxError(error)) throw error;
      return collectBranchMatches(this, originalAll, selectors)[0] ?? null;
    }
  };

  proto.querySelectorAll = compatAll as typeof proto.querySelectorAll;
  proto.querySelector = compatOne as typeof proto.querySelector;
}

function patchElement(proto: Element): void {
  const originalMatches = proto.matches;
  const originalClosest = proto.closest;

  const compatMatches = function (this: Element, selectors: string) {
    try {
      return originalMatches.call(this, selectors);
    } catch (error) {
      if (!isSelectorSyntaxError(error)) throw error;
      return splitSelectorList(selectors).some((branch) => {
        if (unparseableBranches.has(branch)) return false;
        try {
          return originalMatches.call(this, branch);
        } catch {
          unparseableBranches.add(branch);
          return false;
        }
      });
    }
  };
  const compatClosest = function (this: Element, selectors: string) {
    try {
      return originalClosest.call(this, selectors);
    } catch (error) {
      if (!isSelectorSyntaxError(error)) throw error;
      if (this.matches(selectors)) return this;
      let el = this.parentElement;
      while (el) {
        if (el.matches(selectors)) return el;
        el = el.parentElement;
      }
      return null;
    }
  };

  proto.matches = compatMatches as typeof proto.matches;
  proto.closest = compatClosest as typeof proto.closest;
}

/**
 * Make a jsdom window's selector APIs tolerate selector groups with branches
 * nwsapi can't parse. Patch each JSDOM instance before handing it to Defuddle.
 */
export function installSelectorCompat(window: SelectorCompatWindow): void {
  patchParentNode(window.Document.prototype);
  patchParentNode(window.DocumentFragment.prototype);
  patchParentNode(window.Element.prototype);
  patchElement(window.Element.prototype);
}
