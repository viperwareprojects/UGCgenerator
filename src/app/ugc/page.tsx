"use client";

/**
 * UGC Ad Studio — a simple, English-first portal on top of ClipForge.
 *
 *   1. Product   — paste a product link or upload photos
 *   2. Creative  — ad format, creator, length, aspect, quick draft vs. AI-generated video
 *   3. Script    — pick one of the AI-written variants, tweak any line
 *   4. Video     — produce (free: stock footage + AI voice; AI: storyboard grid → AI film), download
 *
 * Everything here drives ClipForge's existing HTTP API; nothing in the engine was forked.
 */

import "./ugc.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore } from "@/lib/stores/project-store";
import { resolveDefaultModelTarget, buildImageOptions, buildVideoOptions, toEditVariant } from "@/lib/gen-params";
import {
  AD_FORMATS,
  ASPECTS,
  CAPTION_STYLES,
  CREATORS,
  DURATIONS,
  FREE_VOICES,
  SHOT_TYPE_LABEL,
  type AspectRatio,
  type RenderMode,
} from "@/lib/ugc/presets";
import {
  api,
  fileUrl,
  judgePass,
  latestComposition,
  pollComposition,
  type Composition,
  type LlmConfig,
  type ProjectRow,
  type ScriptRow,
} from "@/lib/ugc/client";

type View = "create" | "library";
type StepId = 0 | 1 | 2 | 3;
const STEP_LABELS = ["Product", "Creative", "Script", "Video"];

interface PickedImage { id: string; url: string; file: File }

interface ProductState {
  source: "link" | "upload";
  link: string;
  images: PickedImage[];
  name: string;
  description: string;
  audience: string;
  offer: string;
}

interface CreativeState {
  formatId: string;
  creatorId: string;
  duration: number;
  aspect: AspectRatio;
  mode: RenderMode;
  voice: string;
  captions: string;
  music: boolean;
  cta: string;
}

type TaskStatus = "pending" | "running" | "done" | "error" | "skipped";
interface Task { id: string; label: string; status: TaskStatus; note?: string }

interface FilmPreview {
  prompt: string;
  shotCount: number;
  seconds: number;
  model: string;
  swappedFrom?: string;
  scriptSeconds: number;
  modelMaxSeconds: number;
  durationOverflow: boolean;
  referenceImages: number;
  referenceQuota?: { ok: boolean; count: number; limit?: number };
  dialogueWarnings: { index: number; seconds: number; count: number; limit: number }[];
  estimate?: { unitUsd: number; seconds: number; minUsd: number; maxUsd: number };
}

const uid = () => Math.random().toString(36).slice(2, 10);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e || "Something went wrong"));
const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 2 : 0)}`;

export default function UgcStudioPage() {
  // ---------- hydration guard (settings live in localStorage) ----------
  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  const settings = useSettingsStore();
  const llmReady = !!(settings.llm.apiKey.trim() && settings.llm.baseUrl && settings.llm.model);
  const aiReady =
    !!settings.defaultVideoModel &&
    !!settings.defaultImageModel &&
    Object.values(settings.providers).some((p) => p.enabled && p.apiKey);
  const { characters, addCharacter, updateCharacter } = useCharacterStore();

  const [view, setView] = useState<View>("create");
  const [theme, setTheme] = useTheme();
  const [showSetup, setShowSetup] = useState(false);

  // ---------- wizard state ----------
  const [step, setStep] = useState<StepId>(0);
  const [product, setProduct] = useState<ProductState>({
    source: "link", link: "", images: [], name: "", description: "", audience: "", offer: "",
  });
  const [creative, setCreative] = useState<CreativeState>({
    formatId: "testimonial", creatorId: CREATORS[0].id, duration: 30, aspect: "9:16", mode: "free",
    voice: CREATORS[0].voice, captions: "bold", music: true, cta: "",
  });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [productImages, setProductImages] = useState<string[]>([]);
  const [productTitle, setProductTitle] = useState("");
  const [scripts, setScripts] = useState<ScriptRow[]>([]);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, Record<number, string>>>({});
  const [polish, setPolish] = useState(true);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [producing, setProducing] = useState(false);
  const [preview, setPreview] = useState<FilmPreview | null>(null);
  const [overCapAck, setOverCapAck] = useState(false);
  const [result, setResult] = useState<Composition | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const format = AD_FORMATS.find((f) => f.id === creative.formatId) ?? AD_FORMATS[0];
  const creator = CREATORS.find((c) => c.id === creative.creatorId) ?? CREATORS[0];
  const currentScript = scripts.find((s) => s.id === selectedScriptId) ?? null;

  const llmConfig = useCallback((): LlmConfig => {
    const l = useSettingsStore.getState().llm;
    return { baseUrl: l.baseUrl, apiKey: l.apiKey, model: l.model, visionModel: l.visionModel };
  }, []);

  // ---------- helpers ----------
  const startTimer = () => {
    setElapsed(0);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => setElapsed((s) => s + 1), 1000);
  };
  const stopTimer = () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  useEffect(() => () => stopTimer(), []);

  const setTask = (id: string, patch: Partial<Task>) =>
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const loadScripts = async (pid: string) => {
    const rows = await api<ScriptRow[]>(`/api/project/${pid}/scripts`);
    const list = Array.isArray(rows) ? rows : [];
    setScripts(list);
    setSelectedScriptId((cur) => (cur && list.some((s) => s.id === cur) ? cur : (list.find((s) => s.selected) ?? list[0])?.id ?? null));
    return list;
  };

  const resetWizard = () => {
    product.images.forEach((i) => URL.revokeObjectURL(i.url));
    setProduct({ source: "link", link: "", images: [], name: "", description: "", audience: "", offer: "" });
    setProjectId(null); setProductImages([]); setProductTitle("");
    setScripts([]); setSelectedScriptId(null); setEdits({});
    setTasks([]); setPreview(null); setResult(null); setError(null); setProducing(false);
    setStep(0); setView("create");
  };

  // ---------- step 1: product ----------
  const productValid =
    product.source === "link"
      ? /^https?:\/\/\S+\.\S+/i.test(product.link.trim())
      : product.images.length > 0 && product.name.trim().length > 1;

  const addFiles = (files: FileList | File[]) => {
    const picked = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, 6 - product.images.length)
      .map((file) => ({ id: uid(), url: URL.createObjectURL(file), file }));
    if (picked.length) setProduct((p) => ({ ...p, images: [...p.images, ...picked] }));
  };

  // ---------- step 2 → 3: create project + write scripts ----------
  const writeScripts = async () => {
    if (!llmReady) { setShowSetup(true); return; }
    setError(null);
    try {
      let pid = projectId;
      let images = productImages;
      let title = productTitle;
      let description = product.description;

      if (!pid) {
        if (product.source === "link") {
          setBusy("Reading your product page…");
          try {
            const res = await api<{ projectId: string; product?: { title?: string; description?: string }; productImages?: string[] }>(
              "/api/ingest/product", { body: { url: product.link.trim(), createProject: true } },
            );
            pid = res.projectId;
            images = res.productImages ?? [];
            title = res.product?.title?.trim() || product.name || "Product";
            description = [res.product?.description, product.description].filter(Boolean).join("\n");
          } catch (e) {
            setBusy(null);
            setStep(0);
            setProduct((p) => ({ ...p, source: "upload" }));
            setError(`We couldn't read that page (${errMsg(e)}). Upload a few product photos and a name instead — it works just as well.`);
            return;
          }
        } else {
          setBusy("Uploading your photos…");
          title = product.name.trim();
          const proj = await api<{ id: string }>("/api/project", {
            body: { name: `UGC · ${title}`, productName: title, productCategory: "other", productDescription: product.description, productImages: [] },
          });
          pid = proj.id;
          const fd = new FormData();
          product.images.forEach((i) => fd.append("files", i.file));
          fd.append("projectId", pid);
          const up = await api<{ paths: string[] }>("/api/upload", { form: fd });
          images = up.paths;
          await api(`/api/project/${pid}`, { method: "PATCH", body: { productImages: images } });
        }
        setProjectId(pid);
        setProductImages(images);
        setProductTitle(title);
      }

      setBusy("Writing 3 script variations…");
      const requirements = [
        "Write it like genuine UGC from a real customer filming on their phone for TikTok / Instagram Reels — first person, casual, spoken (not written) English, no corporate ad-speak.",
        product.audience && `Target audience: ${product.audience}.`,
        product.offer && `Offer / call to action to mention near the end: ${product.offer}.`,
      ].filter(Boolean).join(" ");
      const character = format.usesCreator
        ? { id: creator.id, name: creator.name, appearance: creator.appearance }
        : undefined;
      await api("/api/llm/script", {
        body: {
          projectId: pid,
          productName: title,
          category: "other",
          productDescription: description,
          targetDuration: creative.duration,
          styleType: format.styleType,
          videoMode: format.videoMode,
          productImages: images,
          platforms: "tiktok,reels,shorts",
          targetAudience: product.audience || undefined,
          customRequirements: requirements,
          llmConfig: llmConfig(),
          ...(character && { character }),
        },
      });
      const list = await loadScripts(pid!);
      if (!list.length) throw new Error("The AI didn't return a script. Try again.");
      setEdits({});
      setStep(2);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  // ---------- step 3: save edits + select ----------
  const editedCount = currentScript ? Object.keys(edits[currentScript.id] ?? {}).length : 0;
  const saveScript = async () => {
    if (!projectId || !currentScript) return;
    await api(`/api/project/${projectId}/scripts`, { method: "PATCH", body: { selectedScriptId: currentScript.id } });
    const e = edits[currentScript.id];
    if (e && Object.keys(e).length) {
      await api(`/api/project/${projectId}/scripts`, {
        method: "PATCH",
        body: { scriptId: currentScript.id, shotTexts: Object.entries(e).map(([shotId, voiceover]) => ({ shotId: Number(shotId), voiceover })) },
      });
      setScripts((rows) => rows.map((s) => (s.id === currentScript.id ? { ...s, shots: s.shots.map((sh) => (e[sh.shotId] !== undefined ? { ...sh, voiceover: e[sh.shotId] } : sh)) } : s)));
      setEdits((all) => ({ ...all, [currentScript.id]: {} }));
    }
  };

  // ---------- step 4a: free quick draft ----------
  const produceFree = async () => {
    if (!projectId || !currentScript) return;
    const sid = currentScript.id;
    const doPolish = polish && editedCount === 0;
    setTasks([
      { id: "save", label: "Lock in your script", status: "pending" },
      { id: "polish", label: "Polish lines with AI script judges", status: doPolish ? "pending" : "skipped" },
      { id: "footage", label: "Match visuals (your photos + free stock footage)", status: "pending" },
      { id: "render", label: "Voiceover, captions, music & render", status: "pending" },
    ]);
    setProducing(true); setError(null); setResult(null); startTimer();
    let cur = "save";
    try {
      setTask("save", { status: "running" });
      await saveScript();
      setTask("save", { status: "done" });
      if (doPolish) {
        cur = "polish"; setTask("polish", { status: "running" });
        const n = await judgePass(projectId, sid, llmConfig());
        setTask("polish", { status: "done", note: n ? `${n} line${n > 1 ? "s" : ""} improved` : "Looks good already" });
      }
      cur = "footage"; setTask("footage", { status: "running" });
      const l = llmConfig();
      const fill = await api<{ filled?: number; total?: number }>(`/api/project/${projectId}/stock-fill`, {
        body: { scriptId: sid, source: "all", mediaType: "auto", ...(l.baseUrl && l.model ? { llmConfig: l } : {}) },
      });
      setTask("footage", { status: "done", note: fill.total ? `${fill.filled ?? 0}/${fill.total} shots` : undefined });
      cur = "render"; setTask("render", { status: "running" });
      const body: Record<string, unknown> = {
        scriptId: sid,
        freeTts: { enabled: true, voice: creative.voice },
        aspectRatio: creative.aspect,
        renderPreset: "standard",
        aigcBadgeText: "AI-generated",
        captionPreset: creative.captions === "karaoke" ? "karaoke" : creative.captions,
        ...(creative.captions === "karaoke" && { karaoke: true }),
        ...(creative.music && { freeBgm: true, bgmMood: "upbeat", bgmDuck: true }),
        ...(creative.cta.trim() && { ctaText: creative.cta.trim() }),
      };
      const { compositionId } = await api<{ compositionId?: string }>(`/api/project/${projectId}/compose`, { body });
      const comp = await pollComposition(projectId, compositionId);
      setTask("render", { status: "done" });
      setResult(comp);
    } catch (e) {
      setTask(cur, { status: "error", note: errMsg(e) });
      setError(errMsg(e));
    } finally {
      stopTimer(); setProducing(false);
    }
  };

  // ---------- step 4b: AI-generated video (preview, then confirmed spend) ----------
  const ensureCreatorCharacter = () => {
    if (!format.usesCreator) return null;
    const existing = useCharacterStore.getState().characters.find((c) => c.id === creator.id);
    if (existing) return existing;
    const c = { id: creator.id, name: creator.name, description: creator.tagline, appearance: creator.appearance, referenceImages: [] as string[] };
    addCharacter(c);
    return c;
  };

  const fetchPreview = async (sid: string): Promise<FilmPreview> => {
    const ch = format.usesCreator ? characters.find((c) => c.id === creator.id) : null;
    return api<FilmPreview>(`/api/project/${projectId}/storyboard-film`, {
      body: {
        scriptId: sid,
        dryRun: true,
        model: useSettingsStore.getState().defaultVideoModel,
        ...(format.usesCreator && { characterSheetUrl: ch?.referenceImages?.[0] ?? "planned" }),
      },
    });
  };

  const previewAi = async () => {
    if (!projectId || !currentScript) return;
    if (!aiReady) { setShowSetup(true); return; }
    const sid = currentScript.id;
    const doPolish = polish && editedCount === 0;
    setTasks([
      { id: "save", label: "Lock in your script", status: "pending" },
      { id: "polish", label: "Polish lines with AI script judges", status: doPolish ? "pending" : "skipped" },
      { id: "estimate", label: "Build the shot plan & estimate cost (free)", status: "pending" },
    ]);
    setProducing(true); setError(null); setResult(null); setPreview(null); setOverCapAck(false); startTimer();
    let cur = "save";
    try {
      setTask("save", { status: "running" });
      await saveScript();
      setTask("save", { status: "done" });
      if (doPolish) {
        cur = "polish"; setTask("polish", { status: "running" });
        const n = await judgePass(projectId, sid, llmConfig());
        setTask("polish", { status: "done", note: n ? `${n} line${n > 1 ? "s" : ""} improved` : "Looks good already" });
      }
      cur = "estimate"; setTask("estimate", { status: "running" });
      setPreview(await fetchPreview(sid));
      setTask("estimate", { status: "done" });
    } catch (e) {
      setTask(cur, { status: "error", note: errMsg(e) });
      setError(errMsg(e));
    } finally {
      stopTimer(); setProducing(false);
    }
  };

  const produceAi = async () => {
    if (!projectId || !currentScript || !preview) return;
    const sid = currentScript.id;
    setTasks((ts) => [
      ...ts.filter((t) => t.id !== "sheet" && t.id !== "grid" && t.id !== "film"),
      ...(format.usesCreator ? [{ id: "sheet", label: `Cast ${creator.name} (reference sheet)`, status: "pending" as TaskStatus }] : []),
      { id: "grid", label: "Generate storyboard keyframes", status: "pending" },
      { id: "film", label: "Generate the AI video (can take a few minutes)", status: "pending" },
    ]);
    setProducing(true); setError(null); startTimer();
    let cur = "grid";
    try {
      const fresh = await fetchPreview(sid);
      if (fresh.prompt !== preview.prompt) {
        setPreview(fresh);
        throw new Error("The script changed since the estimate — review the new estimate and confirm again.");
      }
      const s = useSettingsStore.getState();
      const [imgTarget, vidTarget] = await Promise.all([
        resolveDefaultModelTarget(s.providers, s.defaultImageModel, s.customModels, "image"),
        resolveDefaultModelTarget(s.providers, s.defaultVideoModel, s.customModels, "video"),
      ]);
      if (!imgTarget || !vidTarget) throw new Error("No image/video model is configured. Open Settings and connect your AI key.");

      let sheet: string | undefined;
      const ch = ensureCreatorCharacter();
      if (ch) {
        cur = "sheet"; setTask("sheet", { status: "running" });
        sheet = ch.referenceImages?.[0];
        if (!sheet && ch.appearance) {
          try {
            const r = await api<{ url?: string }>("/api/characters/sheet", {
              body: {
                appearance: ch.appearance, name: ch.name,
                provider: imgTarget.provider, model: imgTarget.model, apiKey: imgTarget.apiKey, baseUrl: imgTarget.baseUrl,
                options: buildImageOptions({ ...s.imageParams, aspectRatio: "1:1", count: 1 }),
              },
            });
            if (r.url) { sheet = r.url; updateCharacter(ch.id, { referenceImages: [r.url] }); }
          } catch { /* optional upgrade — identity still holds within this film */ }
        }
        setTask("sheet", { status: "done", note: sheet ? "Saved for future ads" : "Skipped" });
      }

      const productRef = productImages[0];
      cur = "grid"; setTask("grid", { status: "running" });
      await api(`/api/project/${projectId}/storyboard-grid`, {
        body: {
          scriptId: sid,
          provider: imgTarget.provider,
          model: sheet || productRef ? toEditVariant(imgTarget.model) : imgTarget.model,
          apiKey: imgTarget.apiKey, baseUrl: imgTarget.baseUrl,
          ...(sheet && { characterSheetUrl: sheet }),
          ...(productRef && { productImageUrl: productRef }),
          options: buildImageOptions({ ...s.imageParams, aspectRatio: creative.aspect, count: 1 }),
        },
      });
      setTask("grid", { status: "done" });

      cur = "film"; setTask("film", { status: "running" });
      await api(`/api/project/${projectId}/storyboard-film`, {
        body: {
          scriptId: sid,
          provider: vidTarget.provider,
          model: preview.model,
          spendCapUsd: s.spendCapUsd,
          acknowledgeOverCap: overCapAck,
          apiKey: vidTarget.apiKey, baseUrl: vidTarget.baseUrl,
          ...(sheet && { characterSheetUrl: sheet }),
          options: buildVideoOptions({ ...s.videoParams, aspectRatio: creative.aspect }),
        },
      });
      setTask("film", { status: "done" });
      setPreview(null);
      setResult(await latestComposition(projectId));
    } catch (e) {
      setTask(cur, { status: "error", note: errMsg(e) });
      setError(errMsg(e));
    } finally {
      stopTimer(); setProducing(false);
    }
  };

  // ---------- library ----------
  const openProject = async (p: ProjectRow, comp: Composition | null) => {
    setError(null);
    setProjectId(p.id);
    setProductTitle(p.productName || p.name);
    setProductImages(Array.isArray(p.productImages) ? p.productImages : []);
    setTasks([]); setPreview(null);
    setResult(comp?.status === "done" ? comp : null);
    setView("create");
    try {
      const list = await loadScripts(p.id);
      setStep(comp?.status === "done" ? 3 : list.length ? 2 : 1);
    } catch {
      setStep(1);
    }
  };

  if (!mounted) return <div className="ugc ugc-loading" data-theme={theme} />;

  const canGoScript = step >= 2 && scripts.length > 0;
  const canGoVideo = step >= 3 || !!result;

  return (
    <div className="ugc" data-theme={theme}>
      <header className="ugc-top">
        <div className="ugc-top-in">
          <button className="ugc-brand" onClick={() => setView("create")} aria-label="UGC Ad Studio home">
            <BrandMark />
            <span>UGC Ad Studio</span>
          </button>
          <nav className="ugc-nav">
            <button className={view === "create" ? "on" : ""} onClick={() => setView("create")}>Create ad</button>
            <button className={view === "library" ? "on" : ""} onClick={() => setView("library")}>My ads</button>
            <button onClick={() => setShowSetup(true)}>
              <span className={`ugc-dot ${llmReady ? (aiReady ? "ok" : "half") : "off"}`} />Settings
            </button>
            <Link href="/start" className="ugc-adv" title="Open the full ClipForge editor">Advanced</Link>
          </nav>
          <div className="ugc-top-right">
            <button className="ugc-theme" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
            <button className="ugc-btn primary sm" onClick={resetWizard}>New ad <Arrow /></button>
          </div>
        </div>
      </header>

      {view === "library" ? (
        <Library onOpen={openProject} onNew={resetWizard} />
      ) : (
        <main className="ugc-main">
          <ol className="ugc-steps" aria-label="Progress">
            {STEP_LABELS.map((label, i) => {
              const reachable = i === 0 || (i === 1 && (productValid || !!projectId)) || (i === 2 && canGoScript) || (i === 3 && canGoVideo);
              return (
                <li key={label} className={i === step ? "on" : i < step ? "done" : ""}>
                  <button disabled={!reachable || !!busy || producing} onClick={() => setStep(i as StepId)}>
                    <span className="n">{i < step ? "✓" : i + 1}</span>{label}
                  </button>
                </li>
              );
            })}
          </ol>

          {!llmReady && step < 2 && (
            <div className="ugc-banner">
              <span>Connect an AI key once to start writing scripts.</span>
              <button className="ugc-btn sm" onClick={() => setShowSetup(true)}>Connect</button>
            </div>
          )}

          {error && (
            <div className="ugc-error" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss" onClick={() => setError(null)}>×</button>
            </div>
          )}

          {step === 0 && (
            <section className="ugc-card">
              <p className="ugc-eyebrow">Step 1 of 4 · Product</p>
              <h1>What are we selling?</h1>
              <p className="ugc-sub">Paste a product page — we&apos;ll pull the name, details and photos. Or upload photos yourself.</p>

              <div className="ugc-seg" role="tablist">
                <button role="tab" aria-selected={product.source === "link"} className={product.source === "link" ? "on" : ""} onClick={() => setProduct((p) => ({ ...p, source: "link" }))} disabled={!!projectId}>🔗 Product link</button>
                <button role="tab" aria-selected={product.source === "upload"} className={product.source === "upload" ? "on" : ""} onClick={() => setProduct((p) => ({ ...p, source: "upload" }))} disabled={!!projectId}>📷 Upload photos</button>
              </div>

              {projectId ? (
                <div className="ugc-locked">
                  {productImages[0] && <img src={fileUrl(productImages[0])} alt="" />}
                  <div>
                    <strong>{productTitle || "Your product"}</strong>
                    <span>Product saved. Head to the next step, or start a new ad for a different product.</span>
                  </div>
                  <button className="ugc-btn ghost sm" onClick={resetWizard}>New product</button>
                </div>
              ) : product.source === "link" ? (
                <label className="ugc-field">
                  <span>Product page URL</span>
                  <input type="url" inputMode="url" placeholder="https://yourstore.com/products/…" value={product.link} onChange={(e) => setProduct((p) => ({ ...p, link: e.target.value }))} autoFocus />
                  <small>Shopify, Amazon, TikTok Shop and most stores with standard product tags work.</small>
                </label>
              ) : (
                <>
                  <Dropzone images={product.images} onAdd={addFiles} onRemove={(id) => setProduct((p) => {
                    const img = p.images.find((i) => i.id === id); if (img) URL.revokeObjectURL(img.url);
                    return { ...p, images: p.images.filter((i) => i.id !== id) };
                  })} />
                  <label className="ugc-field">
                    <span>Product name</span>
                    <input placeholder="e.g. CloudStep Recovery Slides" value={product.name} onChange={(e) => setProduct((p) => ({ ...p, name: e.target.value }))} />
                  </label>
                </>
              )}

              {!projectId && (
                <div className="ugc-grid2">
                  <label className="ugc-field">
                    <span>Key selling points <em>optional</em></span>
                    <textarea rows={3} placeholder="Feels like walking on clouds · 30% off this week · ships free" value={product.description} onChange={(e) => setProduct((p) => ({ ...p, description: e.target.value }))} />
                  </label>
                  <div className="ugc-stack">
                    <label className="ugc-field">
                      <span>Who is it for? <em>optional</em></span>
                      <input placeholder="Nurses and anyone on their feet all day" value={product.audience} onChange={(e) => setProduct((p) => ({ ...p, audience: e.target.value }))} />
                    </label>
                    <label className="ugc-field">
                      <span>Offer to mention <em>optional</em></span>
                      <input placeholder="Code SAVE20 for 20% off" value={product.offer} onChange={(e) => setProduct((p) => ({ ...p, offer: e.target.value }))} />
                    </label>
                  </div>
                </div>
              )}

              <div className="ugc-actions">
                <span />
                <button className="ugc-btn primary" disabled={!productValid && !projectId} onClick={() => setStep(1)}>Next: creative <Arrow /></button>
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="ugc-card">
              <p className="ugc-eyebrow">Step 2 of 4 · Creative</p>
              <h1>Pick the creative</h1>
              <p className="ugc-sub">Choose an ad angle and who&apos;s on camera. You&apos;ll review the script before anything renders.</p>

              <h3>Ad format</h3>
              <div className="ugc-tiles">
                {AD_FORMATS.map((f) => (
                  <button key={f.id} className={`ugc-tile ${creative.formatId === f.id ? "on" : ""}`} onClick={() => setCreative((c) => ({ ...c, formatId: f.id }))}>
                    <span className="e">{f.emoji}</span>
                    <strong>{f.label}</strong>
                    <span>{f.blurb}</span>
                  </button>
                ))}
              </div>

              {format.usesCreator && (
                <>
                  <h3>Creator <em>{creative.mode === "free" ? "sets the voice on quick drafts" : "appears on camera in AI videos"}</em></h3>
                  <div className="ugc-creators">
                    {CREATORS.map((c) => (
                      <button key={c.id} className={`ugc-creator ${creative.creatorId === c.id ? "on" : ""}`} onClick={() => setCreative((s) => ({ ...s, creatorId: c.id, voice: c.voice }))}>
                        {characters.find((x) => x.id === c.id)?.referenceImages?.[0] ? (
                          <img className="av" src={characters.find((x) => x.id === c.id)!.referenceImages[0]} alt="" />
                        ) : (
                          <span className="av">{c.name[0]}</span>
                        )}
                        <strong>{c.name}</strong>
                        <span>{c.tagline}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              <div className="ugc-grid2">
                <div>
                  <h3>Length</h3>
                  <div className="ugc-seg">
                    {DURATIONS.map((d) => (
                      <button key={d} className={creative.duration === d ? "on" : ""} onClick={() => setCreative((c) => ({ ...c, duration: d }))}>{d}s</button>
                    ))}
                  </div>
                </div>
                <div>
                  <h3>Shape</h3>
                  <div className="ugc-seg">
                    {ASPECTS.map((a) => (
                      <button key={a.value} title={a.hint} className={creative.aspect === a.value ? "on" : ""} onClick={() => setCreative((c) => ({ ...c, aspect: a.value }))}>{a.label}</button>
                    ))}
                  </div>
                </div>
              </div>

              <h3>How should we make it?</h3>
              <div className="ugc-modes">
                <button className={`ugc-mode ${creative.mode === "free" ? "on" : ""}`} onClick={() => setCreative((c) => ({ ...c, mode: "free" }))}>
                  <div className="h"><strong>Quick draft</strong><span className="tag free">Free · ~2 min</span></div>
                  <p>Your product photos + free stock footage, AI voiceover, captions and music. Great for testing hooks fast.</p>
                </button>
                <button className={`ugc-mode ${creative.mode === "ai" ? "on" : ""}`} onClick={() => setCreative((c) => ({ ...c, mode: "ai" }))}>
                  <div className="h"><strong>AI-generated UGC</strong><span className="tag paid">Paid · uses your AI credits</span></div>
                  <p>A fully generated video with a consistent on-camera creator speaking the script. Exact cost shown before you spend.</p>
                  {!aiReady && <small className="warn">Needs a video-capable AI key — set it up in Settings.</small>}
                </button>
              </div>

              <div className="ugc-actions">
                <button className="ugc-btn ghost" onClick={() => setStep(0)}>← Back</button>
                <button className="ugc-btn primary" disabled={!!busy} onClick={writeScripts}>
                  {busy ? <><Spinner />{busy}</> : scripts.length ? <>Rewrite scripts <Arrow /></> : <>Write my scripts <Arrow /></>}
                </button>
              </div>
              {scripts.length > 0 && !busy && (
                <p className="ugc-hint">You already have scripts for this product — <button className="ugc-link" onClick={() => setStep(2)}>keep them</button> or rewrite with the new settings.</p>
              )}
            </section>
          )}

          {step === 2 && (
            <section className="ugc-card">
              <p className="ugc-eyebrow">Step 3 of 4 · Script</p>
              <h1>Choose a script</h1>
              <p className="ugc-sub">Three angles on <strong>{productTitle}</strong>. Click any line to rewrite it in your own words.</p>

              <div className="ugc-variants">
                {scripts.slice(0, 6).map((s, i) => (
                  <button key={s.id} className={`ugc-variant ${s.id === selectedScriptId ? "on" : ""}`} onClick={() => setSelectedScriptId(s.id)}>
                    <span className="k">Option {i + 1}</span>
                    <strong>{s.title || `Variation ${i + 1}`}</strong>
                    <span className="m">{s.shots?.length ?? 0} shots · {s.totalDuration ?? s.shots?.reduce((a, b) => a + (b.duration || 0), 0)}s</span>
                    <span className="q">“{s.shots?.[0]?.voiceover}”</span>
                  </button>
                ))}
              </div>

              {currentScript && (
                <div className="ugc-shots">
                  {currentScript.shots.map((sh) => {
                    const val = edits[currentScript.id]?.[sh.shotId] ?? sh.voiceover;
                    return (
                      <div key={sh.shotId} className="ugc-shot">
                        <div className="meta">
                          <span className="pill">{SHOT_TYPE_LABEL[sh.type] ?? sh.type}</span>
                          <span className="t">{sh.duration}s</span>
                        </div>
                        <textarea
                          rows={2}
                          value={val}
                          onChange={(e) => setEdits((all) => ({ ...all, [currentScript.id]: { ...(all[currentScript.id] ?? {}), [sh.shotId]: e.target.value } }))}
                        />
                        <p className="desc">🎬 {sh.description}</p>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="ugc-actions">
                <button className="ugc-btn ghost" onClick={() => setStep(1)}>← Change creative</button>
                <button className="ugc-btn primary" disabled={!currentScript} onClick={() => { setTasks([]); setPreview(null); setResult(null); setStep(3); }}>Use this script <Arrow /></button>
              </div>
            </section>
          )}

          {step === 3 && (
            <section className="ugc-card">
              {result?.url ? (
                <div className="ugc-result">
                  <div className={`ugc-player a${creative.aspect.replace(":", "x")}`}>
                    <video src={result.url} controls playsInline autoPlay />
                  </div>
                  <div className="ugc-result-side">
                    <p className="ugc-eyebrow">Done</p>
                    <h1>Your ad is ready</h1>
                    <p className="ugc-sub">{productTitle}{currentScript?.title ? ` — ${currentScript.title}` : ""}</p>
                    <a className="ugc-btn primary" href={result.url} download>⬇ Download MP4</a>
                    <button className="ugc-btn" onClick={() => { setResult(null); setTasks([]); setStep(2); }}>Try another script</button>
                    <button className="ugc-btn" onClick={() => { setResult(null); setTasks([]); setStep(1); }}>Change format / creator</button>
                    <button className="ugc-btn ghost" onClick={resetWizard}>New ad for another product</button>
                    {projectId && <Link className="ugc-link small" href={`/project/${projectId}/export`}>Platform exports, covers & captions in the advanced editor ↗</Link>}
                  </div>
                </div>
              ) : (
                <>
                  <p className="ugc-eyebrow">Step 4 of 4 · Video</p>
                  <h1>{creative.mode === "free" ? "Make the quick draft" : "Make the AI video"}</h1>
                  <p className="ugc-sub">
                    {creative.mode === "free"
                      ? "Free: your photos + stock footage, AI voiceover, captions and music."
                      : `AI-generated ${format.usesCreator ? `with ${creator.name} on camera` : "product video"}. You'll see the exact cost before anything is charged.`}
                  </p>

                  {!producing && tasks.length === 0 && (
                    <div className="ugc-options">
                      {creative.mode === "free" && (
                        <>
                          <label className="ugc-field">
                            <span>Voice</span>
                            <select value={creative.voice} onChange={(e) => setCreative((c) => ({ ...c, voice: e.target.value }))}>
                              {FREE_VOICES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                            </select>
                          </label>
                          <label className="ugc-field">
                            <span>Captions</span>
                            <select value={creative.captions} onChange={(e) => setCreative((c) => ({ ...c, captions: e.target.value }))}>
                              {CAPTION_STYLES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                            </select>
                          </label>
                          <label className="ugc-field">
                            <span>End-card text <em>optional</em></span>
                            <input placeholder="Tap to shop 👇" value={creative.cta} onChange={(e) => setCreative((c) => ({ ...c, cta: e.target.value }))} />
                          </label>
                          <label className="ugc-check"><input type="checkbox" checked={creative.music} onChange={(e) => setCreative((c) => ({ ...c, music: e.target.checked }))} /> Background music</label>
                        </>
                      )}
                      <label className="ugc-check" title={editedCount ? "Off because you edited lines — your words are kept as written." : undefined}>
                        <input type="checkbox" checked={polish && editedCount === 0} disabled={editedCount > 0} onChange={(e) => setPolish(e.target.checked)} />
                        Auto-polish the script first {editedCount > 0 && <em>(off — keeping your edits)</em>}
                      </label>
                    </div>
                  )}

                  {tasks.length > 0 && (
                    <ul className="ugc-tasks">
                      {tasks.map((t) => (
                        <li key={t.id} className={t.status}>
                          <span className="ic">{t.status === "running" ? <Spinner /> : t.status === "done" ? "✓" : t.status === "error" ? "!" : t.status === "skipped" ? "–" : "·"}</span>
                          <span className="l">{t.label}{t.note && <small>{t.note}</small>}</span>
                        </li>
                      ))}
                      {producing && <li className="elapsed">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} elapsed — you can keep this tab open in the background.</li>}
                    </ul>
                  )}

                  {preview && !producing && (
                    <div className="ugc-quote">
                      <div className="row"><span>Model</span><strong>{preview.model}{preview.swappedFrom && <small> (switched from {preview.swappedFrom})</small>}</strong></div>
                      <div className="row"><span>Length</span><strong>{preview.seconds}s · {preview.shotCount} shots</strong></div>
                      <div className="row"><span>Estimated cost</span><strong className="big">{preview.estimate ? (preview.estimate.minUsd === preview.estimate.maxUsd ? usd(preview.estimate.minUsd) : `${usd(preview.estimate.minUsd)} – ${usd(preview.estimate.maxUsd)}`) : "Unknown (provider publishes no price)"}</strong></div>
                      <p className="fine">Plus one image generation for the storyboard{format.usesCreator ? " and one for the creator sheet (first use only)" : ""}. Billed by your AI provider.</p>
                      {preview.durationOverflow && <p className="warn">⚠ Your script is {preview.scriptSeconds}s but this model maxes out at {preview.modelMaxSeconds}s — it will be trimmed. Pick a shorter length for a cleaner cut.</p>}
                      {preview.referenceQuota && !preview.referenceQuota.ok && <p className="warn">⚠ Too many reference images ({preview.referenceQuota.count}/{preview.referenceQuota.limit}). Choose a script with fewer shots.</p>}
                      {preview.dialogueWarnings?.length > 0 && <p className="warn">⚠ {preview.dialogueWarnings.length} shot(s) have more words than fit in their time — consider trimming lines.</p>}
                      {preview.estimate && settings.spendCapUsd > 0 && preview.estimate.maxUsd > settings.spendCapUsd && (
                        <label className="ugc-check warn"><input type="checkbox" checked={overCapAck} onChange={(e) => setOverCapAck(e.target.checked)} /> This is above your {usd(settings.spendCapUsd)} spend cap — generate anyway</label>
                      )}
                      <details><summary>See the full prompt</summary><pre>{preview.prompt}</pre></details>
                    </div>
                  )}

                  <div className="ugc-actions">
                    <button className="ugc-btn ghost" disabled={producing} onClick={() => setStep(2)}>← Back to script</button>
                    {creative.mode === "free" ? (
                      <button className="ugc-btn primary" disabled={producing} onClick={produceFree}>
                        {producing ? <><Spinner />Rendering…</> : tasks.some((t) => t.status === "error") ? "Retry" : "🎬 Make my video"}
                      </button>
                    ) : preview ? (
                      <button className="ugc-btn primary" disabled={producing || (!!preview.estimate && settings.spendCapUsd > 0 && preview.estimate.maxUsd > settings.spendCapUsd && !overCapAck)} onClick={produceAi}>
                        {producing ? <><Spinner />Generating…</> : `Confirm & generate${preview.estimate ? ` (~${usd(preview.estimate.maxUsd)})` : ""}`}
                      </button>
                    ) : (
                      <button className="ugc-btn primary" disabled={producing} onClick={previewAi}>
                        {producing ? <><Spinner />Estimating…</> : "Get cost estimate"}
                      </button>
                    )}
                  </div>
                </>
              )}
            </section>
          )}
        </main>
      )}

      {showSetup && <SetupDialog onClose={() => setShowSetup(false)} />}
    </div>
  );
}

// ======================================================================
const THEME_KEY = "ugc-theme";
type Theme = "light" | "dark";

/** Light/dark preference: saved per browser, defaults to the system setting. */
function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>("light");
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage unavailable */ }
    const initial: Theme = saved === "dark" || saved === "light" ? saved : window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    queueMicrotask(() => setThemeState(initial));
  }, []);
  const setTheme = (t: Theme) => {
    setThemeState(t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
  };
  return [theme, setTheme];
}

function BrandMark() {
  return (
    <svg className="ugc-mark" width="28" height="28" viewBox="0 0 180 180" aria-hidden="true" focusable="false">
      <rect width="180" height="180" rx="44" fill="currentColor" />
      <path d="M58 40c0-10.6 11.5-17.3 20.7-12.1l76 46c8.9 5.4 8.9 18.8 0 24.2l-76 46C69.5 149.3 58 142.6 58 132V40Z" fill="var(--on-accent)" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg className="ugc-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function Spinner() {
  return <span className="ugc-spin" aria-hidden />;
}

function Dropzone({ images, onAdd, onRemove }: { images: PickedImage[]; onAdd: (f: FileList | File[]) => void; onRemove: (id: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div
      className={`ugc-drop ${drag ? "drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); onAdd(e.dataTransfer.files); }}
    >
      {images.map((i) => (
        <div key={i.id} className="thumb">
          <img src={i.url} alt="" />
          <button aria-label="Remove photo" onClick={() => onRemove(i.id)}>×</button>
        </div>
      ))}
      {images.length < 6 && (
        <button className="add" onClick={() => ref.current?.click()}>
          <span>＋</span>
          {images.length ? "Add more" : "Drop product photos here or click to browse"}
          <small>Up to 6 · clean shots of the product work best</small>
        </button>
      )}
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { if (e.target.files) onAdd(e.target.files); e.target.value = ""; }} />
    </div>
  );
}

function Library({ onOpen, onNew }: { onOpen: (p: ProjectRow, c: Composition | null) => void; onNew: () => void }) {
  const [rows, setRows] = useState<{ p: ProjectRow; c: Composition | null }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api<ProjectRow[]>("/api/project");
        const ts = (p: ProjectRow) => new Date(p.updatedAt ?? p.createdAt ?? 0).getTime() || 0;
        const top = (Array.isArray(list) ? list : []).sort((a, b) => ts(b) - ts(a)).slice(0, 24);
        const withComp = await Promise.all(top.map(async (p) => ({ p, c: await latestComposition(p.id) })));
        if (!cancelled) setRows(withComp);
      } catch (e) {
        if (!cancelled) setErr(errMsg(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <main className="ugc-main wide">
      <div className="ugc-libhead">
        <div>
          <p className="ugc-eyebrow">Library</p>
          <h1>My ads</h1>
        </div>
        <button className="ugc-btn primary" onClick={onNew}>New ad <Arrow /></button>
      </div>
      {err && <div className="ugc-error">{err}</div>}
      {!rows && !err && <p className="ugc-sub"><Spinner /> Loading…</p>}
      {rows && rows.length === 0 && (
        <div className="ugc-empty">
          <p>No ads yet. Paste a product link and you&apos;ll have a draft in a couple of minutes.</p>
          <button className="ugc-btn primary" onClick={onNew}>Create your first ad</button>
        </div>
      )}
      <div className="ugc-lib">
        {rows?.map(({ p, c }) => {
          const thumb = fileUrl(Array.isArray(p.productImages) ? p.productImages[0] : undefined);
          return (
            <button key={p.id} className="ugc-libcard" onClick={() => onOpen(p, c)}>
              <div className="media">
                {c?.status === "done" && c.url ? (
                  <video src={`${c.url}#t=0.5`} muted playsInline preload="metadata" onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} />
                ) : thumb ? (
                  <img src={thumb} alt="" />
                ) : (
                  <span className="ph">No preview</span>
                )}
                <span className={`badge ${c?.status === "done" ? "ok" : c?.status === "failed" ? "bad" : ""}`}>
                  {c?.status === "done" ? "Ready" : c?.status === "failed" ? "Failed" : c ? "Rendering" : "Draft"}
                </span>
              </div>
              <strong>{p.productName || p.name}</strong>
              <span>{p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : ""}</span>
            </button>
          );
        })}
      </div>
    </main>
  );
}

function SetupDialog({ onClose }: { onClose: () => void }) {
  const { llm, providers, defaultImageModel, defaultVideoModel, spendCapUsd, setSpendCapUsd, applyAtlasOneKey } = useSettingsStore();
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [msg, setMsg] = useState("");
  const connected = useMemo(() => !!llm.apiKey && !!llm.baseUrl, [llm]);
  const atlas = providers["atlas-cloud"];

  const connect = async () => {
    const k = key.trim();
    if (!k) return;
    setState("testing"); setMsg("");
    try {
      const r = await api<{ status?: string; message?: string }>("/api/ai/test-provider", { body: { name: "atlas-cloud", apiKey: k } }).catch((e) => ({ status: "unknown", message: errMsg(e) }));
      if (r.status === "invalid") { setState("error"); setMsg("That key was rejected. Double-check you copied the whole key."); return; }
      applyAtlasOneKey(k);
      setState("ok"); setMsg("Connected — scripts, images, video and voice are all set up.");
      setKey("");
    } catch (e) {
      setState("error"); setMsg(errMsg(e));
    }
  };

  return (
    <div className="ugc-modal" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ugc-modal-card">
        <button className="x" aria-label="Close" onClick={onClose}>×</button>
        <h2>Connect your AI</h2>
        <p className="ugc-sub">One <a href="https://www.atlascloud.ai" target="_blank" rel="noreferrer">Atlas Cloud</a> API key powers everything: script writing, product-photo analysis, AI images and AI video. Quick drafts only use the script model (pennies); AI videos show their cost before you confirm.</p>

        <div className="ugc-status">
          <div><span className={`ugc-dot ${connected ? "ok" : "off"}`} />Script writer <code>{connected ? llm.model : "not connected"}</code></div>
          <div><span className={`ugc-dot ${defaultVideoModel && (atlas?.apiKey || Object.values(providers).some((p) => p.enabled && p.apiKey)) ? "ok" : "off"}`} />AI video <code>{defaultVideoModel || "not set"}</code></div>
          <div><span className={`ugc-dot ${defaultImageModel ? "ok" : "off"}`} />AI images <code>{defaultImageModel || "not set"}</code></div>
        </div>

        <label className="ugc-field">
          <span>{connected ? "Replace key" : "Atlas Cloud API key"}</span>
          <div className="ugc-inline">
            <input type="password" autoComplete="off" placeholder="Paste your key" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void connect(); }} />
            <button className="ugc-btn primary" disabled={!key.trim() || state === "testing"} onClick={connect}>{state === "testing" ? <Spinner /> : "Connect"}</button>
          </div>
          {msg && <small className={state === "error" ? "bad" : "good"}>{msg}</small>}
        </label>

        <label className="ugc-field">
          <span>Spend cap per AI video (USD)</span>
          <input type="number" min={0} step={1} value={spendCapUsd} onChange={(e) => setSpendCapUsd(Number(e.target.value))} />
          <small>We&apos;ll ask for an extra confirmation above this. 0 = no cap.</small>
        </label>

        <p className="ugc-fine">Your key is saved in this browser and passed to the server only when it runs a job. Prefer OpenAI, DeepSeek, fal.ai, Replicate or a local model? Configure them in <Link href="/settings">advanced settings</Link>.</p>
        <div className="ugc-actions"><span /><button className="ugc-btn" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
