import { mountTopology, connectHashNavigation } from '@xan9x/topology';

const disposers: (() => void)[] = [];
for (const host of document.querySelectorAll<HTMLElement>('[data-topology-host]')) {
  const data: unknown = JSON.parse(host.dataset.topologyDocument!);
  const instance = mountTopology(host, data, { width: 1320, height: 540 });
  const disconnect = connectHashNavigation(instance, window);
  const viewport = host.parentElement!;
  const section = host.closest('section')!;
  const controller = new AbortController();
  const back = section.querySelector<HTMLButtonElement>('[data-map-back]')!;
  back.addEventListener('click', () => instance.focus(instance.getState().focusPath.slice(1, -1)), { signal: controller.signal });
  section.querySelector('[data-map-home]')?.addEventListener('click', () => instance.focus([]), { signal: controller.signal });
  section.querySelectorAll<HTMLButtonElement>('[data-map-pan]').forEach(button => {
    button.addEventListener('click', () => { viewport.scrollLeft += Number(button.dataset.mapPan) * viewport.clientWidth * .75; }, { signal: controller.signal });
  });
  // Keep the focused node visible in the horizontally pannable narrow-screen map.
  const center = () => {
    const node = host.querySelector<SVGGElement>('.node.current');
    if (!node || viewport.scrollWidth <= viewport.clientWidth) return;
    const bounds = node.getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    viewport.scrollLeft += bounds.x + bounds.width / 2 - frame.x - frame.width / 2;
  };
  const unsubscribe = instance.subscribe(state => { back.disabled = state.focusPath.length <= 1; if (!state.animating) center(); });
  back.disabled = instance.getState().focusPath.length <= 1;
  const resize = new ResizeObserver(center);
  resize.observe(viewport);
  center();
  disposers.push(() => { controller.abort(); resize.disconnect(); unsubscribe(); disconnect(); instance.destroy(); });
}
window.addEventListener('astro:before-swap', () => disposers.forEach(dispose => dispose()), { once: true });
import.meta.hot?.dispose(() => disposers.forEach(dispose => dispose()));
