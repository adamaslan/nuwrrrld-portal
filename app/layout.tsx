import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const SITE_URL = "https://financial.nuwrrrld.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "NuWrrrld Financial — AI Signals & Portfolio Intelligence",
    template: "%s · NuWrrrld Financial",
  },
  description:
    "Daily AI-powered stock signals, portfolio health scoring, and a personal finance AI assistant. Start your 7-day free trial.",
  keywords: ["stock signals", "portfolio tracker", "AI finance assistant", "investment signals", "market analysis"],
  authors: [{ name: "NuWrrrld Financial", url: SITE_URL }],
  creator: "NuWrrrld Financial",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    siteName: "NuWrrrld Financial",
    title: "NuWrrrld Financial — AI Signals & Portfolio Intelligence",
    description: "Daily AI-powered stock signals, portfolio health scoring, and a personal finance AI assistant.",
  },
  twitter: {
    card: "summary_large_image",
    title: "NuWrrrld Financial",
    description: "AI-powered signals, portfolio intelligence, and Nu AI assistant.",
    creator: "@nuwrrrld",
  },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true } },
  alternates: { canonical: SITE_URL },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
        <body>
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify({
                "@context": "https://schema.org",
                "@type": "Organization",
                name: "NuWrrrld Financial",
                url: SITE_URL,
                description: "AI-powered financial signals and portfolio intelligence.",
                contactPoint: { "@type": "ContactPoint", email: "chillcoders@gmail.com", contactType: "customer support" },
              }),
            }}
          />
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
