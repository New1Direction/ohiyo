import { createContext, useContext } from "react";
import neutral from "../../../brand/kikka-chinchilla-clean.png";
import idle from "./assets/kikka/idle.webp";
import listening from "./assets/kikka/listening.webp";
import working from "./assets/kikka/working.webp";
import speaking from "./assets/kikka/speaking.webp";
import confused from "./assets/kikka/confused.webp";
import error from "./assets/kikka/error.webp";

export const KikkaMotion = createContext(true);
const images = { neutral, idle, listening, working, speaking, confused, error };

// These images only reflect UI state; they never start work or access a microphone.
export default function KikkaMascot({ state = "idle", alt = "" }: { state?: keyof typeof images; alt?: string }) {
  const motion = useContext(KikkaMotion);
  return <picture>
    <source media="(prefers-reduced-motion: reduce)" srcSet={neutral} />
    <img className="kikka-mascot-image" src={motion ? images[state] : neutral} alt={alt} width={512} height={512} />
  </picture>;
}
