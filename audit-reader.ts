/**
 * Pure readers over a finished audit, used by the `video_analysis_audit` tool.
 *
 * Kept free of storage, tools and plugin context so the logic can be exercised
 * directly in tests: `node --experimental-strip-types scripts/check-audit-reader.mjs`.
 *
 * The contract is deliberately narrow: an audit in, plain JSON out, with every
 * list capped and every omission reported. Nothing here may drop data silently.
 */

export const SECTION_NAMES = [
  "overview",
  "video",
  "input",
  "findings",
  "scenes",
  "entities",
  "transcript",
  "chunks",
  "failures",
  "resume",
] as const;

export type SectionName = (typeof SECTION_NAMES)[number];

export interface ReadOptions {
  ref?: string;
  from_sec?: number;
  to_sec?: number;
  include_words?: boolean;
}

/** Caps that keep one bad request from flooding a model's context. */
const LIMITS = {
  findings: 200,
  scenes: 500,
  entities: 200,
  cues: 800,
  analysis: 8000,
  perspective: 4000,
  transcript_text: 8000,
  summary_out: 400,
};

type Any = Record<string, any>;

export function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return value.length > max ? `${value.slice(0, max)}…(${value.length - max} chars omitted)` : value;
}

/** True when a span intersects the requested window (inclusive, open-ended). */
export function overlaps(start: number, end: number | null, from: number | null, to: number | null): boolean {
  if (from === null && to === null) return true;
  const hi = end ?? start;
  return hi >= (from ?? -Infinity) && start <= (to ?? Infinity);
}

/** True when a point falls inside the requested window; unpointed findings only match unfiltered reads. */
export function inPoint(t: number | null | undefined, from: number | null, to: number | null): boolean {
  if (t === null || t === undefined) return from === null && to === null;
  return (from === null || t >= from) && (to === null || t <= to);
}

/** The map a caller reads first: what the run holds and how big it is. */
export function auditIndex(audit: Any) {
  const findings: Any[] = audit.overall?.findings ?? [];
  const byKind: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const f of findings) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    bySource[f.source] = (bySource[f.source] ?? 0) + 1;
  }

  const segments: Any[] = audit.segments ?? [];
  const cuesTotal = segments.reduce((n, s) => n + (s.transcript?.cues?.length ?? 0), 0);
  const wordsTotal = segments.reduce((n, s) => n + (s.transcript?.word_count ?? 0), 0);

  return {
    video: audit.video?.filename ?? null,
    status: audit.status ?? null,
    duration_sec: audit.video?.duration_sec ?? null,
    sections: {
      overview: {
        analysis_chars: audit.overall?.analysis?.length ?? 0,
        has_perspective: Boolean(audit.overall?.perspective),
      },
      findings: { count: findings.length, by_kind: byKind, by_source: bySource },
      scenes: { count: (audit.scenes ?? []).length },
      entities: {
        count: (audit.entities ?? []).length,
        typed: [...new Set((audit.entities ?? []).map((e: Any) => e.kind))],
      },
      transcript: {
        chunks_with_transcript: segments.filter((s) => s.transcript).length,
        cues: cuesTotal,
        words: wordsTotal,
        total_chars: audit.overall?.transcript?.chars ?? 0,
        engines: [...new Set(segments.map((s) => s.transcript?.engine).filter(Boolean))],
        cue_sources: [...new Set(segments.map((s) => s.transcript?.cue_source).filter(Boolean))],
      },
      chunks: {
        count: (audit.chain ?? []).length,
        failed: segments.filter((s) => s.status === "failed").length,
      },
      failures: {
        count: (audit.parsing?.failures ?? []).length,
        uncovered_ranges: (audit.parsing?.coverage?.uncovered_ranges ?? []).length,
      },
      resume: audit.audit?.resume ?? null,
    },
    audit_chars: JSON.stringify(audit).length,
  };
}

export function auditRunMeta(audit: Any, source: string, jobId: string | null) {
  return {
    source,
    job_id: jobId,
    video: audit.video?.filename ?? null,
    status: audit.status ?? null,
    schema: audit.schema_version ?? null,
    plugin: audit.plugin?.version ?? null,
    started_at: audit.audit?.started_at ?? null,
    finished_at: audit.audit?.finished_at ?? null,
    elapsed_ms: audit.audit?.elapsed_ms ?? null,
    chunks: `${audit.parsing?.chunks_completed ?? 0}/${audit.parsing?.total_chunks ?? 0}`,
    coverage_percent: audit.parsing?.coverage?.coverage_percent ?? null,
  };
}

/** Which sections a request should return. */
export function resolveSectionNames(
  detail: "index" | "full",
  sections: string[] | undefined,
  hasRef: boolean,
): SectionName[] {
  const valid = (list: string[]) => list.filter((s): s is SectionName => (SECTION_NAMES as readonly string[]).includes(s));
  if (sections?.length) return valid(sections);
  if (hasRef) return ["overview"];
  if (detail === "full") return [...SECTION_NAMES];
  return ["overview", "findings"];
}

/** Builds the requested sections. Caps are applied here and reported per section. */
export function readSections(audit: Any, names: SectionName[], opts: ReadOptions = {}) {
  const from = Number.isFinite(opts.from_sec) ? (opts.from_sec as number) : null;
  const to = Number.isFinite(opts.to_sec) ? (opts.to_sec as number) : null;
  const includeWords = opts.include_words === true;
  const out: Record<string, unknown> = {};
  const segments: Any[] = audit.segments ?? [];

  if (names.includes("overview")) {
    const findings: Any[] = audit.overall?.findings ?? [];
    const byKind: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const f of findings) {
      byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      bySource[f.source] = (bySource[f.source] ?? 0) + 1;
    }
    out.overview = {
      analysis: clip(audit.overall?.analysis, LIMITS.analysis),
      perspective: clip(audit.overall?.perspective, LIMITS.perspective),
      findings_count: audit.overall?.findings_count ?? findings.length,
      findings_by_kind: byKind,
      findings_by_source: bySource,
      entity_index: audit.overall?.entity_index ?? {},
      transcript: audit.overall?.transcript
        ? {
            chars: audit.overall.transcript.chars ?? null,
            cue_count: audit.overall.transcript.cue_count ?? null,
            segments_covered: audit.overall.transcript.segments_covered ?? null,
            text: clip(audit.overall.transcript.text, LIMITS.transcript_text),
          }
        : null,
      parsing: {
        strategy: audit.parsing?.strategy ?? null,
        total_chunks: audit.parsing?.total_chunks ?? 0,
        chunks_completed: audit.parsing?.chunks_completed ?? 0,
        chunks_failed: audit.parsing?.chunks_failed ?? 0,
        coverage_percent: audit.parsing?.coverage?.coverage_percent ?? null,
        uncovered_ranges: audit.parsing?.coverage?.uncovered_ranges ?? [],
      },
      registry: audit.registry?.status ?? null,
      api: audit.audit?.api ?? null,
      stitch: {
        mode: audit.audit?.stitch?.mode ?? null,
        used: audit.audit?.stitch?.used ?? false,
        duration_ms: audit.audit?.stitch?.duration_ms ?? 0,
      },
    };
  }

  if (names.includes("video")) out.video = audit.video ?? null;

  if (names.includes("input")) {
    out.input = {
      prompt: audit.input?.prompt ?? null,
      model: audit.input?.model ?? null,
      observation: audit.input?.observation ?? null,
      transcription: audit.input?.transcription ?? null,
      provider: audit.input?.provider ?? null,
      options: audit.input?.options ?? null,
      environment: audit.input?.environment ?? null,
    };
  }

  if (names.includes("findings")) {
    const all: Any[] = (audit.overall?.findings ?? []).filter((f) => inPoint(f.at_sec, from, to));
    const items = all.slice(0, LIMITS.findings).map((f, i) => ({
      // Heuristic findings are generated without ids; give every finding a stable
      // handle so `ref:"f7"` works for any of them.
      id: f.id ?? `f${i + 1}`,
      timestamp: f.timestamp ?? null,
      at_sec: f.at_sec ?? null,
      kind: f.kind,
      source: f.source,
      chunk_index: f.chunk_index ?? null,
      text: f.text,
    }));
    const byKind: Record<string, number> = {};
    for (const f of all) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    out.findings = {
      total: (audit.overall?.findings ?? []).length,
      matched: all.length,
      by_kind: byKind,
      omitted: Math.max(0, all.length - items.length),
      items,
    };
  }

  if (names.includes("scenes")) {
    const all = (audit.scenes ?? []).filter((s: Any) => overlaps(s.start_sec, s.end_sec, from, to));
    out.scenes = {
      total: (audit.scenes ?? []).length,
      matched: all.length,
      omitted: Math.max(0, all.length - LIMITS.scenes),
      items: all.slice(0, LIMITS.scenes),
    };
  }

  if (names.includes("entities")) {
    const all = (audit.entities ?? []).filter(
      (e: Any) =>
        (from === null && to === null) ||
        ((e.last_seen_sec ?? 0) >= (from ?? -Infinity) && (e.first_seen_sec ?? 0) <= (to ?? Infinity)),
    );
    out.entities = {
      total: (audit.entities ?? []).length,
      matched: all.length,
      omitted: Math.max(0, all.length - LIMITS.entities),
      items: all.slice(0, LIMITS.entities).map((e: Any) => ({
        id: e.id,
        kind: e.kind,
        label: e.label ?? null,
        descriptors: e.descriptors ?? [],
        aliases: e.aliases ?? [],
        appearances: (e.appearances ?? []).filter((a: Any) => overlaps(a.start_sec, a.end_sec, from, to)),
        first_seen_sec: e.first_seen_sec ?? null,
        last_seen_sec: e.last_seen_sec ?? null,
      })),
    };
  }

  if (names.includes("transcript")) {
    let used = 0;
    const rows = segments
      .filter((s) => s.transcript)
      .map((s) => {
        const cues: Any[] = (s.transcript.cues ?? []).filter((c) => overlaps(c.start_sec, c.end_sec, from, to));
        const take = cues.slice(0, Math.max(0, LIMITS.cues - used));
        used += take.length;
        return {
          chunk_index: s.chunk_index,
          time_range: s.time_range,
          offset_sec: s.offset_sec ?? 0,
          status: s.status,
          cue_count: s.transcript.cue_count ?? cues.length,
          word_count: s.transcript.word_count ?? 0,
          words_truncated: s.transcript.words_truncated ?? false,
          cue_source: s.transcript.cue_source ?? null,
          timed: s.transcript.timed ?? false,
          cues_matched: cues.length,
          cues_omitted: Math.max(0, cues.length - take.length),
          cues: take.map((c) => ({
            start_sec: c.start_sec,
            end_sec: c.end_sec,
            text: c.text,
            speaker: c.speaker ?? null,
            ...(includeWords ? { words: c.words ?? [] } : {}),
          })),
        };
      });
    out.transcript = {
      words_included: includeWords,
      cues_total: segments.reduce((n, s) => n + (s.transcript?.cues?.length ?? 0), 0),
      cues_returned: used,
      hint: includeWords ? undefined : "include_words:true adds [start, end, word] triples per cue",
      segments: rows,
    };
  }

  if (names.includes("chunks")) {
    out.chunks = (audit.chain ?? []).map((c: Any) => ({
      chunk_index: c.chunk_index,
      time_range: c.time_range,
      status: c.status,
      duration_ms: c.duration_ms,
      ffmpeg_ok: c.ffmpeg?.ok ?? null,
      api: {
        calls: c.api?.calls ?? 0,
        usage: c.api?.usage ?? null,
        error: c.api?.error ?? null,
        attempts: c.api?.attempts?.length ?? 0,
      },
      transcription: c.transcription
        ? {
            ok: c.transcription.ok,
            engine: c.transcription.engine,
            model: c.transcription.model,
            request_shape: c.transcription.request_shape ?? null,
            chars: c.transcription.chars ?? null,
            usage: c.transcription.usage ?? null,
            error: c.transcription.error ?? null,
          }
        : null,
      scenes_count: c.scenes_count ?? 0,
      entities_added: c.entities_added ?? [],
      entities_matched: c.entities_matched ?? [],
      summary_out: clip(c.summary_out, LIMITS.summary_out),
      analysis_chars: c.analysis_chars ?? 0,
    }));
  }

  if (names.includes("failures")) {
    out.failures = {
      chunks_failed: audit.parsing?.chunks_failed ?? 0,
      items: audit.parsing?.failures ?? [],
      uncovered_ranges: audit.parsing?.coverage?.uncovered_ranges ?? [],
    };
  }

  if (names.includes("resume")) out.resume = audit.audit?.resume ?? null;

  if (opts.ref) {
    const ref = String(opts.ref).trim();
    const findings: Any[] = audit.overall?.findings ?? [];
    // `f7` means the seventh finding in display order, whether or not it carries
    // an id of its own; an explicit id match wins over the positional reading.
    const byId = findings.find((f) => f.id === ref);
    const byPosition = ref.match(/^f(\d+)$/);
    const finding = byId ?? (byPosition ? findings[Number(byPosition[1]) - 1] : undefined);
    const entity = (audit.entities ?? []).find((e: Any) => e.id === ref);
    const chunkMatch = ref.match(/^chunk[:_](\d+)$/);
    if (finding) {
      const at = findings.indexOf(finding);
      out.ref = { kind: "finding", id: finding.id ?? `f${at + 1}`, item: finding };
    } else if (entity) out.ref = { kind: "entity", id: entity.id, item: entity };
    else if (chunkMatch) {
      const idx = Number(chunkMatch[1]);
      out.ref = {
        kind: "chunk",
        segment: segments.find((s) => s.chunk_index === idx) ?? null,
        chain: (audit.chain ?? []).find((c: Any) => c.chunk_index === idx) ?? null,
      };
    } else {
      out.ref = { kind: "unknown", ref, hint: "Use a finding id (f7 — 1-based order), an entity id (p3), or chunk:<n>." };
    }
  }

  return out;
}
