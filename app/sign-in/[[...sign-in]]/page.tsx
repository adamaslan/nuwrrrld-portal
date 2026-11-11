import { SignIn } from "@clerk/nextjs";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import "../../landing.css";

export default function SignInPage() {
  return (
    <div className="nwf-landing">
      <PreLoginNav />
      <main className="public-auth">
        <SignIn />
      </main>
      <PreLoginFooter />
    </div>
  );
}
