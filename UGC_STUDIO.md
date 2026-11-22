# UGC Ad Studio

A simple, English-first portal on top of ClipForge for making AI UGC-style video ads.
It lives at **`/ugc`**, and the home page redirects there. The full ClipForge editor is still
available at `/start` (the **Advanced ↗** link in the header).

## Run it

```bash
pnpm install
pnpm dev          # http://localhost:3000 → opens the studio
```

Or self-host with the bundled `Dockerfile` (no Node/FFmpeg needed on the host).

Open **Settings** in the studio and paste one [Atlas Cloud](https://www.atlascloud.ai) API key.
That key covers script writing, product-photo analysis, AI images and AI video. If you want other
providers (OpenAI, DeepSeek, fal.ai, Replicate, Ollama, …), set them up under `/settings`.

## Flow

1. **Product**: paste a product URL (it imports the title, description and photos), or upload photos and enter a name.
   Optional: selling points, target audience, and an offer for the script to mention.
2. **Creative**: pick an ad format (testimonial, problem → solution, unboxing, skeptic → fan, before/after,
   product showcase), a creator persona, the length (15/30/45s), the aspect ratio, and a render mode:
   - **Quick draft (free)**: your photos plus free stock footage, an Edge TTS voiceover, captions and music. Takes about 2 minutes.
   - **AI-generated UGC (paid)**: generates a storyboard keyframe grid, then a single reference-to-video
     film with a consistent on-camera creator. A free cost estimate is shown first, and nothing is billed until you confirm.
3. **Script**: the app writes 3 variations. Pick one and edit any line inline.
4. **Video**: watch the progress checklist, then preview and download the MP4. You can try another script
   or another format for the same product.

**My ads** lists every project with its latest render.

## Where the code is

| Path | What |
|---|---|
| `src/app/ugc/page.tsx` | The wizard, the library and the settings dialog |
| `src/app/ugc/ugc.css` | Standalone styles, scoped under `.ugc` (light and dark) |
| `src/lib/ugc/presets.ts` | Ad formats → engine style/video mode; creator personas; voices |
| `src/lib/ugc/client.ts` | Small API client (polling, judge pass, file URLs) |
| `src/components/app-shell.tsx` | Skips the ClipForge sidebar on `/ugc`; adds a sidebar link back |

The studio only calls ClipForge's existing HTTP API (`/api/ingest/product`, `/api/llm/script`,
`/api/project/:id/{scripts,script-judge,stock-fill,compose,storyboard-grid,storyboard-film}`,
`/api/characters/sheet`). The engine itself was not changed.

## Notes before hosting publicly

- There's **no login**. Anyone who can reach the server can create projects and see the library.
  Put it behind auth (for example a reverse proxy with basic auth or SSO) before exposing it.
- ClipForge is **AGPL-3.0**. If you offer it as a network service, you must make your modified
  source available to its users.
- Free voiceovers use Microsoft Edge TTS over a WebSocket. If outbound WebSockets are blocked,
  renders still finish but come out silent.
