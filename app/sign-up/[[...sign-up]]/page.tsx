import { SignUp } from "@clerk/nextjs";
import LegalConsentGate from "@/components/LegalConsentGate";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import "../../landing.css";

export default function SignUpPage() {
  return (
    <div className="nwf-landing">
      <PreLoginNav />
      <main className="public-auth">
        <LegalConsentGate>
          <SignUp />
        </LegalConsentGate>
      </main>
      <PreLoginFooter />
    </div>
  );
}
