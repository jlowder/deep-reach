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

// Theme logic (next-themes or a manual toggle) lands in a follow-up dispatch;
// until then the app always renders dark.
const THEME = "dark" as const;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${chakraPetch.variable} ${ibmPlexSans.variable} ${ibmPlexMono.variable} h-full antialiased ${THEME}`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
