import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "UGC Ad Studio · AI UGC video ads",
  description: "Turn a product link into ready-to-run UGC-style video ads.",
};

// Same type pairing as UGC Finder (sister product): Montserrat for display, Inter for UI text.
export default function UgcLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@600;700;800&display=swap"
        precedence="default"
      />
      {children}
    </>
  );
}
