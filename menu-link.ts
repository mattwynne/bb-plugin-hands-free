// BB 0.43 does not expose a thread-actions-menu slot. This narrowly scoped
// content script adds an entry beside the host's "Copy thread link" action.
// Fail closed if the host changes its markup: never guess which thread to open.
export function mountThreadMenuLink(signal: AbortSignal): () => void {
  let observer: MutationObserver | null = null;
  let timer: number | null = null;
  let candidateId: string | null = null;

  function stopWatching() {
    observer?.disconnect();
    observer = null;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  function threadIdAt(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    // The row's overlay anchor bears BB's stable shortcut attribute. The …
    // trigger is a sibling, so walk only as far as the first unambiguous row.
    let element: Element | null = target;
    for (let depth = 0; element && depth < 6; depth++, element = element.parentElement) {
      if (element.hasAttribute("data-sidebar-thread-id")) {
        return element.getAttribute("data-sidebar-thread-id") || null;
      }
      const anchors = element.querySelectorAll("a[data-sidebar-thread-id]");
      if (anchors.length === 1) return anchors[0]?.getAttribute("data-sidebar-thread-id") || null;
      if (anchors.length > 1) return null;
    }
    return null;
  }

  function inject() {
    if (!candidateId || signal.aborted) return;
    const items = document.querySelectorAll<HTMLElement>('[role="menuitem"], button');
    const copy = Array.from(items).find((item) => item.textContent?.trim() === "Copy thread link");
    if (!copy || !copy.parentElement) return;
    // Host menu rerenders can retain this item; never add duplicates.
    if (copy.parentElement.querySelector('[data-voice-drive-menu-item]')) { stopWatching(); return; }
    const id = candidateId;
    const link = document.createElement("button");
    link.type = "button";
    link.className = copy.className;
    link.textContent = "🎙 Enter hands-free mode";
    link.dataset.voiceDriveMenuItem = "";
    if (copy.getAttribute("role") === "menuitem") link.setAttribute("role", "menuitem");
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (signal.aborted) return;
      // A full navigation is intentional: the SDK offers no router hook from
      // a content script, and manually pushing history would leave stale UI.
      window.location.assign(`/plugins/voice-drive/drive/${encodeURIComponent(id)}`);
    }, { signal });
    copy.after(link);
    stopWatching();
  }

  function watch(target: EventTarget | null) {
    const id = threadIdAt(target);
    if (!id) return;
    candidateId = id;
    stopWatching();
    observer = new MutationObserver(inject);
    observer.observe(document.body, { childList: true, subtree: true });
    inject();
    // A normal row tap is not a menu open. Do not watch the whole app forever.
    if (observer) timer = window.setTimeout(stopWatching, 2000);
  }
  document.addEventListener("pointerdown", (event) => watch(event.target), { capture: true, signal });
  document.addEventListener("contextmenu", (event) => watch(event.target), { capture: true, signal });
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest('[aria-label="Thread actions"]')) watch(event.target);
  }, { capture: true, signal });
  signal.addEventListener("abort", stopWatching, { once: true });
  return () => {
    stopWatching();
    document.querySelectorAll('[data-voice-drive-menu-item]').forEach((item) => item.remove());
  };
}
