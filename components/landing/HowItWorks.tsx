import { MessageCircle, Swords, Target } from "lucide-react";
import { Reveal } from "@/components/landing/Reveal";

const STEPS = [
  {
    icon: MessageCircle,
    title: "Ask about any ticker",
    body: "Type a symbol, or open a signal that's already on your feed.",
  },
  {
    icon: Swords,
    title: "Six AI analysts argue it out",
    body: "Including RISK, whose only job is to try to talk you out of it.",
  },
  {
    icon: Target,
    title: "You get one clear call",
    body: "Direction, confidence, and the exact price that would prove it wrong.",
  },
] as const;

/** Three-step, plain-language explainer. Server component; Reveal is the only client bit. */
export function HowItWorks() {
  return (
    <section id="how" className="how-it-works">
      <div className="wrap">
        <Reveal className="section-head">
          <div>
            <div className="kicker">How it works</div>
            <h2>From a ticker to a decision in three steps.</h2>
          </div>
        </Reveal>

        <div className="how-steps">
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <Reveal key={title} delay={i * 0.08} as="article" className="how-step">
              <div className="how-step-number">{i + 1}</div>
              <Icon className="how-step-icon" aria-hidden="true" size={28} />
              <h3>{title}</h3>
              <p>{body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
