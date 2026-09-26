import { mountTopology, connectHashNavigation } from '@xan9x/topology';

const disposers: (() => void)[] = [];
for (const host of document.querySelectorAll<HTMLElement>('[data-topology-host]')) {
  const data: unknown = JSON.parse(host.dataset.topologyDocument!);
  const instance = mountTopology(host, data);
  const disconnect = connectHashNavigation(instance, window);
  disposers.push(() => { disconnect(); instance.destroy(); });
}
window.addEventListener('astro:before-swap', () => disposers.forEach(dispose => dispose()), { once: true });
import.meta.hot?.dispose(() => disposers.forEach(dispose => dispose()));
