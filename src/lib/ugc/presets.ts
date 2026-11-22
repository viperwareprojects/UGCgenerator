/**
 * UGC Ad Studio presets — the beginner-facing vocabulary of the /ugc portal.
 *
 * Each "ad format" maps onto ClipForge's engine vocabulary (script styleType + videoMode),
 * and each "creator" is an English persona that becomes a ClipForge presenter (Character)
 * the first time it is used, so its generated reference sheet is reused across ads.
 */

export type AspectRatio = "9:16" | "1:1" | "16:9";
export type RenderMode = "free" | "ai";

export interface AdFormat {
  id: string;
  label: string;
  blurb: string;
  emoji: string;
  /** ClipForge script style */
  styleType: string;
  /** ClipForge video mode */
  videoMode: "live_presenter" | "product_closeup" | "graphic_montage";
  /** True when an on-camera creator is part of the format */
  usesCreator: boolean;
}

export const AD_FORMATS: AdFormat[] = [
  {
    id: "testimonial",
    label: "Creator testimonial",
    blurb: "A real-feeling creator talks to camera about why they love it.",
    emoji: "🎙️",
    styleType: "talking_head",
    videoMode: "live_presenter",
    usesCreator: true,
  },
  {
    id: "problem_solution",
    label: "Problem → solution",
    blurb: "Hook on a pain point, then show the product fixing it.",
    emoji: "💡",
    styleType: "pain_point",
    videoMode: "live_presenter",
    usesCreator: true,
  },
  {
    id: "unboxing",
    label: "Unboxing / first look",
    blurb: "Open the box, first impressions, the 'wait, this is nice' moment.",
    emoji: "📦",
    styleType: "unboxing",
    videoMode: "live_presenter",
    usesCreator: true,
  },
  {
    id: "skeptic",
    label: "Skeptic turned fan",
    blurb: "'I didn't believe the hype…' — a reversal that ends in a convert.",
    emoji: "🔄",
    styleType: "reversal",
    videoMode: "live_presenter",
    usesCreator: true,
  },
  {
    id: "comparison",
    label: "Before / after",
    blurb: "Side-by-side: life without it vs. with it.",
    emoji: "⚖️",
    styleType: "comparison",
    videoMode: "product_closeup",
    usesCreator: false,
  },
  {
    id: "showcase",
    label: "Product showcase",
    blurb: "No person — punchy product shots, captions and voiceover.",
    emoji: "✨",
    styleType: "auto",
    videoMode: "product_closeup",
    usesCreator: false,
  },
];

export interface Creator {
  id: string;
  name: string;
  tagline: string;
  gender: "female" | "male";
  /** English appearance anchor fed into image/video prompts */
  appearance: string;
  /** Free Edge TTS voice that fits the persona (used on the free path) */
  voice: string;
  /** Avatar gradient for the picker */
  hue: number;
}

/**
 * Ordinary-person archetypes, deliberately varied in age/look so batches don't converge
 * on one face. Each appearance bakes in a small lived-in detail (ClipForge's realism rule).
 */
export const CREATORS: Creator[] = [
  {
    id: "ugc_maya",
    name: "Maya",
    tagline: "Late-20s, warm, chatty best-friend energy",
    gender: "female",
    appearance:
      "28-year-old woman, friendly approachable face, loose messy bun with stray strands, minimal everyday makeup, natural un-retouched skin, oversized cream knit sweater, a hair tie on her left wrist",
    voice: "en-US-AriaNeural",
    hue: 330,
  },
  {
    id: "ugc_jordan",
    name: "Jordan",
    tagline: "Early-30s, practical, 'let me show you' explainer",
    gender: "male",
    appearance:
      "32-year-old man, short neat hair and light stubble, kind ordinary face, natural skin texture, plain heather-grey t-shirt, a pen clipped to the collar",
    voice: "en-US-GuyNeural",
    hue: 210,
  },
  {
    id: "ugc_priya",
    name: "Priya",
    tagline: "Mid-30s, busy professional, ingredient-checker",
    gender: "female",
    appearance:
      "35-year-old South Asian woman, shoulder-length dark hair, approachable composed look, light makeup, natural skin texture, simple white button-up with one sleeve rolled up",
    voice: "en-US-AriaNeural",
    hue: 25,
  },
  {
    id: "ugc_dee",
    name: "Dee",
    tagline: "Early-20s, Gen-Z, big honest reactions",
    gender: "female",
    appearance:
      "22-year-old Black woman, natural curly hair in a high puff, thin gold hoop earrings, playful expressive face, natural skin, oversized graphic tee, wired earbuds hanging around her neck",
    voice: "en-US-AriaNeural",
    hue: 280,
  },
  {
    id: "ugc_sam",
    name: "Sam",
    tagline: "Late-30s parent, value-for-money, no-nonsense",
    gender: "male",
    appearance:
      "38-year-old dad, short hair slightly greying at the temples, easygoing friendly face, natural skin texture, navy hoodie, a small kid's sticker stuck on the sleeve",
    voice: "en-US-GuyNeural",
    hue: 160,
  },
  {
    id: "ugc_ellie",
    name: "Ellie",
    tagline: "British, 40s, calm and trustworthy reviewer",
    gender: "female",
    appearance:
      "44-year-old British woman, chin-length wavy hair, warm laugh lines, light natural makeup, real skin texture, soft blue cardigan, reading glasses pushed up on her head",
    voice: "en-GB-SoniaNeural",
    hue: 50,
  },
];

export const DURATIONS = [15, 30, 45] as const;

export const ASPECTS: { value: AspectRatio; label: string; hint: string }[] = [
  { value: "9:16", label: "Vertical 9:16", hint: "TikTok · Reels · Shorts" },
  { value: "1:1", label: "Square 1:1", hint: "Feed ads" },
  { value: "16:9", label: "Wide 16:9", hint: "YouTube · web" },
];

export const FREE_VOICES = [
  { value: "en-US-AriaNeural", label: "Aria — US, female" },
  { value: "en-US-GuyNeural", label: "Guy — US, male" },
  { value: "en-GB-SoniaNeural", label: "Sonia — UK, female" },
  { value: "es-ES-ElviraNeural", label: "Elvira — Spanish, female" },
  { value: "fr-FR-DeniseNeural", label: "Denise — French, female" },
  { value: "de-DE-KatjaNeural", label: "Katja — German, female" },
];

export const CAPTION_STYLES = [
  { value: "bold", label: "Bold" },
  { value: "karaoke", label: "Word-by-word" },
  { value: "standard", label: "Standard" },
  { value: "minimal", label: "Minimal" },
] as const;

export const SHOT_TYPE_LABEL: Record<string, string> = {
  hook: "Hook",
  pain_point: "Problem",
  product_reveal: "Reveal",
  demo: "Demo",
  social_proof: "Proof",
  cta: "Call to action",
};
