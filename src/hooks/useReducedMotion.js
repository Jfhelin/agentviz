import { useEffect, useState } from "react";

export default function useReducedMotion() {
  var [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(function () {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    var media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(media.matches);

    function handleChange(event) {
      setPrefersReducedMotion(event.matches);
    }

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return function () { media.removeEventListener("change", handleChange); };
    }

    media.addListener(handleChange);
    return function () { media.removeListener(handleChange); };
  }, []);

  return prefersReducedMotion;
}
