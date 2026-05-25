import { useEffect, useRef } from "react";

var FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusableElements(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(function (element) {
    return !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true";
  });
}

function focusElement(element) {
  if (element && typeof element.focus === "function") {
    element.focus();
  }
}

export default function useFocusTrap(containerRef, options) {
  var active = Boolean(options && options.active);
  var initialFocusRef = options && options.initialFocusRef;
  var onEscape = options && options.onEscape;
  var restoreFocus = !options || options.restoreFocus !== false;
  var previousFocusRef = useRef(null);
  var onEscapeRef = useRef(onEscape);

  useEffect(function () {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(function () {
    if (!active) return undefined;
    var container = containerRef.current;
    previousFocusRef.current = document.activeElement;

    var focusTarget = initialFocusRef && initialFocusRef.current
      ? initialFocusRef.current
      : getFocusableElements(container)[0];
    window.setTimeout(function () { focusElement(focusTarget); }, 0);

    function handleKeyDown(event) {
      if (event.defaultPrevented) return;
      if (!containerRef.current) return;
      if (event.key === "Escape" && onEscapeRef.current) {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      var focusable = getFocusableElements(containerRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        focusElement(containerRef.current);
        return;
      }

      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      var current = document.activeElement;

      if (event.shiftKey && current === first) {
        event.preventDefault();
        focusElement(last);
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        focusElement(first);
      } else if (focusable.indexOf(current) === -1) {
        event.preventDefault();
        focusElement(first);
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return function () {
      document.removeEventListener("keydown", handleKeyDown, true);
      if (restoreFocus && previousFocusRef.current && document.contains(previousFocusRef.current)) {
        focusElement(previousFocusRef.current);
      }
      previousFocusRef.current = null;
    };
  }, [active, containerRef, initialFocusRef, restoreFocus]);
}
