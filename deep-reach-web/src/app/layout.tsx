import type { Metadata } from "next";
import { Chakra_Petch, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

// next/font/google self-hosts these at build time; the generated CSS already
// uses font-display: swap (the default), so no `display` option is needed.
const chakraPetch = Chakra_Petch({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-chakra-petch",
});

const ibmPlexSans = IBM_Plex_Sans({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-ibm-plex-sans",
});

const ibmPlexMono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
});

export const metadata: Metadata = {
  title: "Deep Reach",
  description:
    "Multi-agent deep research: queued runs, live progress, and retrieval-augmented reports.",
};

// Runs before first paint: apply the stored theme (default "ink") so the page
// never flashes the wrong palette. Mirrors src/lib/theme.tsx — keep the two
// reads in sync.
const themeScript =
  '(function(){var t="ink";try{var s=localStorage.getItem("deep-reach-theme");' +
  't=s==="paper"?"paper":"ink";}catch(e){}' +
  'document.documentElement.dataset.theme=t;})();';

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${chakraPetch.variable} ${ibmPlexSans.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
