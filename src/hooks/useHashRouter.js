import { useEffect } from "react";

// Hash-based routing: #/ = landing, #/session = session view
// Usage: useHashRouter({ hasSession, onNavigateToLanding, enabled })

export default function useHashRouter({ hasSession, onNavigateToLanding, enabled }) {
  var isEnabled = enabled !== false;

  // Push the right hash whenever hasSession changes
  useEffect(function () {
    if (!isEnabled) return;
    var current = window.location.hash;
    if (hasSession) {
      if (current !== "#/session") {
        window.history.pushState(null, "", "#/session");
      }
    } else {
      if (current !== "#/" && current !== "#" && current !== "") {
        window.history.replaceState(null, "", "#/");
      }
    }
  }, [hasSession, isEnabled]);

  // Handle browser back/forward
  useEffect(function () {
    if (!isEnabled) return;
    function onPopState() {
      var hash = window.location.hash;
      if (hash === "#/" || hash === "#" || hash === "") {
        onNavigateToLanding();
      }
    }
    window.addEventListener("popstate", onPopState);
    return function () { window.removeEventListener("popstate", onPopState); };
  }, [isEnabled, onNavigateToLanding]);
}
