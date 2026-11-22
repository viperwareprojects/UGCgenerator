/**
 * Thin browser-side client for the ClipForge HTTP API, used by the /ugc portal.
 * Every call sends Accept-Language: en so API errors come back in English.
 */

import type { Shot } from "@/lib/db/schema";

export interface ScriptRow {
  id: string;
  projectId: string;
  styleType: string;
  title: string | null;
  totalDuration: number | null;
  shots: Shot[];
  selected: boolean | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  productName: string | null;
  productDescription?: string | null;
  productImages?: string[] | null;
  status: string;
  updatedAt: string | null;
  createdAt?: string | null;
}

export interface Composition {
  id: string;
  status: "pending" | "processing" | "done" | "failed" | string;
  url?: string | null;
  createdAt?: string | null;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
}

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(message: string, status: number, data: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Accept-Language": "en" };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, signal: opts.signal });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = (typeof data.error === "string" && data.error) || (typeof data.raw === "string" && data.raw.slice(0, 200)) || `Request failed (HTTP ${res.status})`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll one composition to a terminal state (server-side render timeout is 600s). */
export async function pollComposition(projectId: string, compositionId: string | undefined, onTick?: () => void): Promise<Composition> {
  const q = compositionId ? `?compositionId=${encodeURIComponent(compositionId)}` : "";
  const deadline = Date.now() + 11 * 60 * 1000;
  for (;;) {
    const { composition } = await api<{ composition: Composition | null }>(`/api/project/${projectId}/compose${q}`);
    if (composition?.status === "done") return composition;
    if (composition?.status === "failed") throw new Error("Rendering failed. Try again, or pick a different script.");
    if (Date.now() > deadline) throw new Error("Rendering is taking unusually long. Check “My ads” in a few minutes.");
    onTick?.();
    await sleep(2500);
  }
}

export async function latestComposition(projectId: string): Promise<Composition | null> {
  try {
    const { composition } = await api<{ composition: Composition | null }>(`/api/project/${projectId}/compose`);
    return composition;
  } catch {
    return null;
  }
}

/** URL for a file stored by ClipForge (product images are saved as local data paths). */
export function fileUrl(p: string | undefined | null): string | undefined {
  if (!p) return undefined;
  if (/^(https?:|blob:|data:|\/)/.test(p)) return p;
  const norm = p.replace(/\\/g, "/");
  const idx = norm.indexOf("/uploads/");
  if (idx >= 0) return `/api/files/${norm.slice(idx + "/uploads/".length)}`;
  return undefined;
}

interface JudgeRow { shotId: number; voiceover?: string; description?: string; tier?: string }

/**
 * Judge pass (same as ClipForge's hands-off chains): narrow LLM judges critique the lines and
 * length-preserving rewrites are applied in place. Best-effort — returns number of rewritten shots.
 */
export async function judgePass(projectId: string, scriptId: string, llmConfig: LlmConfig): Promise<number> {
  try {
    const report = await api<{ rewrites?: JudgeRow[]; descriptionRewrites?: JudgeRow[] }>(`/api/project/${projectId}/script-judge`, {
      body: { scriptId, llmConfig: { baseUrl: llmConfig.baseUrl, apiKey: llmConfig.apiKey, model: llmConfig.model } },
    });
    const gated = (rows?: JudgeRow[]) => (Array.isArray(rows) ? rows.filter((r) => r.tier !== "taste") : []);
    const byShot = new Map<number, { shotId: number; voiceover?: string; description?: string }>();
    for (const r of gated(report.rewrites)) if (r.voiceover) byShot.set(r.shotId, { shotId: r.shotId, voiceover: r.voiceover });
    for (const r of gated(report.descriptionRewrites)) {
      if (r.description) byShot.set(r.shotId, { ...(byShot.get(r.shotId) ?? { shotId: r.shotId }), description: r.description });
    }
    if (!byShot.size) return 0;
    await api(`/api/project/${projectId}/scripts`, { method: "PATCH", body: { scriptId, shotTexts: [...byShot.values()] } });
    return byShot.size;
  } catch {
    return 0;
  }
}
