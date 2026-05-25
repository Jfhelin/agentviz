import { useEffect, useState } from "react";

export var BREAKPOINTS = {
  compact: 760,
  narrow: 1040,
};

function getViewportWidth() {
  if (typeof window === "undefined") return 1200;
  return window.innerWidth || 1200;
}

function getBreakpoint(width) {
  if (width <= BREAKPOINTS.compact) return "compact";
  if (width <= BREAKPOINTS.narrow) return "narrow";
  return "wide";
}

export default function useBreakpoint() {
  var [width, setWidth] = useState(getViewportWidth);

  useEffect(function () {
    if (typeof window === "undefined") return undefined;
    var frame = null;

    function handleResize() {
      if (frame != null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(function () {
        frame = null;
        setWidth(getViewportWidth());
      });
    }

    window.addEventListener("resize", handleResize);
    return function () {
      if (frame != null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  var name = getBreakpoint(width);
  return {
    name: name,
    width: width,
    isCompact: name === "compact",
    isNarrow: name === "compact" || name === "narrow",
    isWide: name === "wide",
  };
}
