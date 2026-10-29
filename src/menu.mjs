// Small anchored menus share pointer dismissal, focus restoration and keyboard navigation.
const menus = new Set();
export function createMenu(trigger, menu) {
  let returnFocus = trigger;
  const items = () => [
    ...menu.querySelectorAll("button:not(:disabled):not([hidden])"),
  ];
  function close(focus = false) {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (focus) (returnFocus?.isConnected ? returnFocus : trigger).focus();
  }
  function open({ x, y, focus = trigger, last = false } = {}) {
    if (trigger.disabled) return;
    for (const other of menus) other.close();
    returnFocus = focus;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const rect = trigger.getBoundingClientRect();
    const width = menu.offsetWidth,
      height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(x ?? rect.right - width, innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y ?? (rect.bottom + height + 4 < innerHeight ? rect.bottom + 4 : rect.top - height - 4), innerHeight - height - 8))}px`;
    (last ? items().at(-1) : items()[0])?.focus();
  }
  const api = { open, close };
  menus.add(api);
  trigger.onclick = () => (menu.hidden ? open() : close(true));
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open({ last: event.key === "ArrowUp" });
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const all = items(),
      i = all.indexOf(document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? all.length - 1
          : (i + (event.key === "ArrowDown" ? 1 : -1) + all.length) %
            all.length;
    all[next]?.focus();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target) && !trigger.contains(event.target))
      close();
  });
  document.addEventListener("focusin", (event) => {
    if (!menu.contains(event.target) && !trigger.contains(event.target))
      close();
  });
  document.addEventListener(
    "wheel",
    (event) => {
      if (!menu.contains(event.target)) close();
    },
    true,
  );
  window.addEventListener("resize", () => close());
  return api;
}
