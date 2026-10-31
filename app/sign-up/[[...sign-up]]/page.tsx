import { SignUp } from "@clerk/nextjs";
import LegalConsentGate from "@/components/LegalConsentGate";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import "../../landing.css";

export default function SignUpPage() {
  return (
    <div className="nwf-landing">
      <PreLoginNav />
      <main style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "4rem 1rem", gap: "1.5rem", flex: 1 }}>
        <LegalConsentGate>
          <SignUp />
        </LegalConsentGate>
      </main>
      <PreLoginFooter />
    </div>
  );
}
