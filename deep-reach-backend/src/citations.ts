/**
 * Citation resolution for dirty example data.
 *
 * Citation arrays in the input hold bare numeric strings that are 1-based
 * positional indices into `report.sources` (which may be stale after the
 * source list was trimmed). Additionally, bracket markers like `[W4]` / `[D6]`
 * (matching `source.citation_key`, case-insensitive) may be embedded directly
 * in span/cell/item text — either as a single key or as a comma-separated
 * multi-key group (`[W2, W5, W17]`, a synthesis artifact of the deep-reach
 * worker, which renumbers the citations array and leaves the key group in
 * the prose: the class-B double group "[W2, W5, W17] [6,7,10]").
 *
 * Per span/cell/item:
 *   1. numeric ref n: 1 <= n <= sources.length -> resolves to that source;
 *      otherwise recorded as unresolvable (counted).
 *   2. multi-key groups: stripped from the text only when EVERY key in the
 *      group resolves to a display number (the numbers already print, so the
 *      literal keys are redundant — worker R1 mirror). A group with any
 *      unresolved key stays in the text as the sole trace of the reference.
 *   3. single-key markers: every /[WD]\d+/ occurrence is looked up by
 *      citation_key; resolved or not, ALL are stripped from the visible text
 *      (legacy behavior, unchanged).
 *   4. resolved sources are unioned + deduped; the visible label is the
 *      1-based array position of each source (sorted ascending).
 *
 * Unresolvable references never fail the build; they are aggregated into
 * human-readable warnings.
 */

/**
 * Bracket markers as they appear in dirty text: a single key (`[W4]`,
 * `[D12]`) or a comma-separated multi-key group (`[W2, W5, W17]`),
 * case-insensitive. Used where "any key group" matters (callout span-glue).
 * The strip logic in `CitationResolver.resolve` distinguishes the two shapes.
 */
export const CITATION_MARKER_RE = /\[(?:[WD]\d+(?:\s*,\s*[WD]\d+)*)\]/gi;

/** A single-key marker (the legacy shape): always stripped from text. */
const SINGLE_KEY_MARKER_RE = /\[(?:W|D)\d+\]/gi;

/** An optional leading space + a comma-separated multi-key group (2+ keys). */
const MULTI_KEY_GROUP_RE = / ?\[[WD]\d+(?:\s*,\s*[WD]\d+)+\]/gi;

/** A ref that did not resolve to a known source. */
export interface UnresolvedRef {
  ref: string;
  kind: "out-of-range" | "unknown";
  context: string;
}

export interface ResolutionResult {
  /** Text with all citation markers stripped. */
  text: string;
  /**
   * 1-based positions (into the sources array) of every source resolved
   * from either numeric refs or bracket markers, deduped, ascending.
   */
  sourcePositions: number[];
  /** Count of numeric refs pointing outside 1..sources.length. */
  outOfRange: number;
  /** Count of bracket markers with no matching citation_key. */
  unresolvedMarkers: number;
  /** Multi-key groups stripped because every key resolved (numbers print instead). */
  redundantKeyGroups: number;
  /** Keys inside a kept multi-key group that resolved to nothing. */
  unresolvedKeptKeys: number;
  /** Structured record of each unresolvable ref (for detailed diagnostics). */
  unresolved: UnresolvedRef[];
}

export interface SourceLike {
  citation_key?: string;
  id?: string;
}

export class CitationResolver {
  /** Case-insensitive citation_key -> 1-based position. */
  private readonly keyToPosition = new Map<string, number>();
  /** Case-insensitive id -> 1-based position (lenient fallback for refs). */
  private readonly idToPosition = new Map<string, number>();
  private outOfRangeCount = 0;
  private unresolvedMarkerCount = 0;
  private redundantKeyGroupCount = 0;
  private unresolvedKeptKeyCount = 0;
  private readonly unresolved: UnresolvedRef[] = [];

  private readonly total: number;

  constructor(sources: SourceLike[]) {
    this.total = sources.length;
    sources.forEach((s, i) => {
      const key = (s.citation_key ?? "").trim().toLowerCase();
      if (key && !this.keyToPosition.has(key)) this.keyToPosition.set(key, i + 1);
      const id = (s.id ?? "").trim().toLowerCase();
      if (id && !this.idToPosition.has(id)) this.idToPosition.set(id, i + 1);
    });
  }

  /** Total number of sources (bounds for numeric refs). */
  get sourceCount(): number {
    return this.total;
  }

  /**
   * Resolve one text/refs pair. `rawRefs` are the block/span `citations`
   * values (bare numeric strings in the examples; other strings are
   * attempted against citation_key / id as a lenient fallback).
   */
  resolve(text: string, rawRefs: readonly (string | number)[]): ResolutionResult {
    const n = this.sourceCount;
    const positions = new Set<number>();
    let outOfRange = 0;
    let unresolvedMarkers = 0;
    const unresolved: UnresolvedRef[] = [];

    for (const raw of rawRefs) {
      const ref = typeof raw === "number" ? String(raw) : String(raw).trim();
      if (ref === "") continue;
      const num = Number(ref);
      if (Number.isInteger(num) && num >= 1 && num <= n) {
        positions.add(num);
        continue;
      }
      // Lenient fallback: treat the ref as a citation_key or source id.
      const keyHit = this.keyToPosition.get(ref.toLowerCase());
      if (keyHit !== undefined) {
        positions.add(keyHit);
        continue;
      }
      const idHit = this.idToPosition.get(ref.toLowerCase());
      if (idHit !== undefined) {
        positions.add(idHit);
        continue;
      }
      outOfRange += 1;
      unresolved.push({ ref, kind: "out-of-range", context: text.slice(0, 60) });
    }

    // Bracket markers embedded in text, in two passes.
    //
    // Multi-key groups FIRST ([W2, W5, W17]): stripped only when EVERY key
    // resolves to a display number — the numbers already print (unioned into
    // sourcePositions below), so the literal keys are the redundant half of
    // the class-B double group. A group with any unresolved key stays in the
    // text as the sole trace of that reference (its resolved keys still
    // contribute their numbers). The optional leading space is consumed with
    // the group, same convention as the single-key strip.
    let redundantKeyGroups = 0;
    let unresolvedKeptKeys = 0;
    let stripped = text.replace(MULTI_KEY_GROUP_RE, (m) => {
      const keys = m
        .slice(m.indexOf("["), m.lastIndexOf("]") + 1)
        .slice(1, -1)
        .split(",")
        .map((k) => k.trim().toLowerCase());
      const hits = keys.map((k) => this.keyToPosition.get(k));
      for (const p of hits) if (p !== undefined) positions.add(p);
      if (hits.every((p) => p !== undefined)) {
        redundantKeyGroups += 1;
        return "";
      }
      unresolvedKeptKeys += hits.filter((p) => p === undefined).length;
      return m;
    });

    // Single-key markers ([W4] / [D12]): legacy behavior — every occurrence
    // is looked up by citation_key, and ALL are stripped from the visible
    // text, resolved or not.
    const markerHits: string[] = [];
    stripped.replace(SINGLE_KEY_MARKER_RE, (m) => {
      markerHits.push(m);
      return "";
    });
    stripped = stripped.replace(/ \[(?:W|D)\d+\]/g, "").replace(SINGLE_KEY_MARKER_RE, "");
    for (const m of markerHits) {
      const inner = m.slice(1, -1).toLowerCase();
      const pos = this.keyToPosition.get(inner);
      if (pos !== undefined) positions.add(pos);
      else {
        unresolvedMarkers += 1;
        unresolved.push({ ref: m, kind: "unknown", context: text.slice(0, 60) });
      }
    }

    this.outOfRangeCount += outOfRange;
    this.unresolvedMarkerCount += unresolvedMarkers;
    this.redundantKeyGroupCount += redundantKeyGroups;
    this.unresolvedKeptKeyCount += unresolvedKeptKeys;
    this.unresolved.push(...unresolved);

    return {
      text: stripped,
      sourcePositions: [...positions].sort((a, b) => a - b),
      outOfRange,
      unresolvedMarkers,
      redundantKeyGroups,
      unresolvedKeptKeys,
      unresolved,
    };
  }

  /** Aggregate human-readable warnings; empty when nothing was unresolvable. */
  warnings(): string[] {
    const out: string[] = [];
    if (this.outOfRangeCount > 0) {
      out.push(
        `${this.outOfRangeCount} unresolvable citation references ` +
          `(numeric index out of range for ${this.sourceCount} sources)`,
      );
    }
    if (this.unresolvedMarkerCount > 0) {
      out.push(
        `${this.unresolvedMarkerCount} citation marker(s) without a matching source citation_key (stripped)`,
      );
    }
    if (this.redundantKeyGroupCount > 0) {
      out.push(
        `citations: removed ${this.redundantKeyGroupCount} redundant key group(s) (numbers already cited)`,
      );
    }
    if (this.unresolvedKeptKeyCount > 0) {
      out.push(
        `${this.unresolvedKeptKeyCount} citation key(s) in a multi-key group ` +
          `without a matching source citation_key (kept in text as the only trace)`,
      );
    }
    return out;
  }

  getUnresolved(): readonly UnresolvedRef[] {
    return this.unresolved;
  }
}

/** True when the (marker-stripped) text still has visible, non-punctuation content. */
export function hasVisibleContent(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  // Must contain a letter or a digit. Pure punctuation/whitespace remnants
  // (e.g. "." left after stripping "[W4] [D14].") are treated as empty.
  return /[\p{L}\p{N}]/u.test(t);
}

/**
 * Render the inline citation label + anchor for a set of 1-based source
 * positions. Sorted ascending, comma-joined: `[2,3]` or `[2]`.
 */
export function citationSup(positions: readonly number[]): string {
  if (positions.length === 0) return "";
  const label = `[${[...positions].sort((a, b) => a - b).join(",")}]`;
  const href = `#src-${positions[0]}`;
  return `<span class="cite"><a href="${href}">${label}</a></span>`;
}
