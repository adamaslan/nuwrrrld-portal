import { SignUp } from "@clerk/nextjs";
import LegalConsentGate from "@/components/LegalConsentGate";

export default function SignUpPage() {
  return (
    <main style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "4rem 1rem", gap: "1.5rem" }}>
      <LegalConsentGate>
        <SignUp />
      </LegalConsentGate>
    </main>
  );
}
