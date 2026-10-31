import { SignIn } from "@clerk/nextjs";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import "../../landing.css";

export default function SignInPage() {
  return (
    <div className="nwf-landing">
      <PreLoginNav />
      <main style={{ display: "flex", justifyContent: "center", padding: "4rem 1rem", flex: 1 }}>
        <SignIn />
      </main>
      <PreLoginFooter />
    </div>
  );
}
