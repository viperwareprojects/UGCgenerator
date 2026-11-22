import { redirect } from "next/navigation";

// Home page goes straight to the UGC Ad Studio — the simplified portal for making ad videos.
// The original ClipForge workspace is still available at /start ("Advanced editor").
export default function HomePage() {
  redirect("/ugc");
}
