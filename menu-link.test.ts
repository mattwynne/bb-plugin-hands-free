// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mountThreadMenuLink } from "./menu-link";

const controllers: AbortController[] = [];
afterEach(() => {
  controllers.forEach((controller) => controller.abort());
  controllers.length = 0;
  document.body.replaceChildren();
});
function mount() {
  const controller = new AbortController();
  controllers.push(controller);
  return mountThreadMenuLink(controller.signal);
}
function row(id: string) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `<a data-sidebar-thread-id="${id}"></a><button aria-label="Thread actions">…</button>`;
  document.body.append(wrapper);
  return wrapper.querySelector("button")!;
}
function menu() {
  const popup = document.createElement("div");
  popup.innerHTML = '<div role="menuitem" class="host-item">Copy thread link</div>';
  document.body.append(popup);
  return popup;
}
describe("thread actions entry", () => {
  it("adds one matching styled action and cleans up on disposal", async () => {
    const dispose = mount();
    row("thread-a").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const popup = menu();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(popup.querySelectorAll('[data-voice-drive-menu-item]')).toHaveLength(1);
    expect(popup.querySelector<HTMLElement>('[data-voice-drive-menu-item]')?.className).toBe("host-item");
    dispose();
    expect(popup.querySelector('[data-voice-drive-menu-item]')).toBeNull();
  });
  it("does not inject without an unambiguous row", async () => {
    mount();
    const wrapper = document.createElement("div");
    wrapper.innerHTML = '<a data-sidebar-thread-id="one"></a><a data-sidebar-thread-id="two"></a><button aria-label="Thread actions">…</button>';
    document.body.append(wrapper);
    wrapper.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const popup = menu();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(popup.querySelector('[data-voice-drive-menu-item]')).toBeNull();
  });
});
