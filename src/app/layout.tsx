import type { Metadata } from "next";
import { Bai_Jamjuree, IBM_Plex_Mono, IBM_Plex_Sans_Thai } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// Plex Sans Thai reads cleanly at 13-14px in both scripts and carries the
// engineered tone of the rest of the interface.
const plexThai = IBM_Plex_Sans_Thai({
  variable: "--font-plex-thai",
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600"],
});

// Bai Jamjuree's squared terminals read like instrument engraving — used only
// for headings, hour numerals, and the small caps labels.
const jamjuree = Bai_Jamjuree({
  variable: "--font-jamjuree",
  subsets: ["thai", "latin"],
  weight: ["500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "รายงานงาน",
  description: "เลือกช่วงวัน สร้างรายงานจาก commit แล้วส่งขึ้น workload",
};

// Applied before first paint so a saved theme never flashes the other one.
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("workload-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="th"
      className={`${plexThai.variable} ${jamjuree.variable} ${plexMono.variable} h-full antialiased`}
      // The bootstrap script below stamps data-theme before React hydrates, so
      // this element legitimately differs from the server markup.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      {/* Browser extensions (ColorZilla's cz-shortcut-listen, Grammarly, …)
          inject attributes into <body> before hydration. Suppressing here
          covers this element only — real mismatches inside the app still warn. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
