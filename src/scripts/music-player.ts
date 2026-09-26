interface Track { id: string; title: string; artist?: string; src: string }
const disposers: (() => void)[] = [];
for (const root of document.querySelectorAll<HTMLElement>('[data-music-player]')) {
  const tracks: Track[] = JSON.parse(root.dataset.tracks ?? '[]');
  if (!tracks.length) continue;
  const find = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const audio = find<HTMLAudioElement>('audio');
  const play = find<HTMLButtonElement>('[data-play]');
  const previous = find<HTMLButtonElement>('[data-previous]');
  const next = find<HTMLButtonElement>('[data-next]');
  const seek = find<HTMLInputElement>('[data-seek]');
  const volume = find<HTMLInputElement>('[data-volume]');
  const mute = find<HTMLButtonElement>('[data-mute]');
  const status = find('[data-status]');
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let index = 0, generation = 0, pending = false;
  const time = (value: number) => {
    const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const message = (text = '') => { status.textContent = text; status.hidden = !text; };
  const syncPlay = () => {
    const playing = !audio.paused && !audio.ended;
    play.setAttribute('aria-label', playing ? '暂停' : '播放');
    find('[data-play-icon]').hidden = playing;
    find('[data-pause-icon]').hidden = !playing;
  };
  const syncTime = () => {
    const ready = Number.isFinite(audio.duration) && audio.duration > 0 && !audio.error;
    seek.disabled = !ready;
    seek.max = String(ready ? audio.duration : 0);
    seek.value = String(ready ? audio.currentTime : 0);
    seek.setAttribute('aria-valuetext', `${time(audio.currentTime)} / ${time(audio.duration)}`);
    find('[data-elapsed]').textContent = time(audio.currentTime);
    find('[data-duration]').textContent = time(audio.duration);
  };
  async function start() {
    const attempt = generation;
    pending = true;
    message();
    try { await audio.play(); }
    catch (error) {
      if (attempt !== generation || controller.signal.aborted) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      message(error instanceof DOMException && error.name === 'NotAllowedError'
        ? '浏览器阻止了播放，请再点击播放。' : '无法播放这首音乐，请重试或切换下一首。');
    } finally { if (attempt === generation) { pending = false; syncPlay(); } }
  }
  function select(value: number, autoplay: boolean) {
    generation++; pending = false;
    audio.pause();
    index = (value + tracks.length) % tracks.length;
    const track = tracks[index]!;
    message();
    find('[data-track-title]').textContent = track.title;
    find('[data-track-artist]').textContent = track.artist ?? '';
    find('[data-track-artist]').hidden = !track.artist;
    audio.src = track.src;
    audio.load();
    root.querySelectorAll<HTMLElement>('[data-track-index]').forEach(button => {
      if (Number(button.dataset.trackIndex) === index) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    syncTime(); syncPlay();
    if (autoplay) void start();
  }
  play.disabled = volume.disabled = mute.disabled = false;
  previous.disabled = next.disabled = tracks.length < 2;
  audio.volume = Number(volume.value);
  select(0, false);
  play.addEventListener('click', () => {
    if (!audio.paused || pending) { generation++; pending = false; audio.pause(); message(); syncPlay(); }
    else { if (audio.error) audio.load(); void start(); }
  }, options);
  previous.addEventListener('click', () => select(index - 1, !audio.paused || pending), options);
  next.addEventListener('click', () => select(index + 1, !audio.paused || pending), options);
  root.querySelectorAll<HTMLButtonElement>('[data-track-index]').forEach(button => {
    button.disabled = false;
    button.addEventListener('click', () => select(Number(button.dataset.trackIndex), true), options);
  });
  seek.addEventListener('input', () => { if (!seek.disabled) { audio.currentTime = Number(seek.value); syncTime(); } }, options);
  volume.addEventListener('input', () => { audio.volume = Number(volume.value); audio.muted = false; }, options);
  mute.addEventListener('click', () => { audio.muted = !audio.muted; }, options);
  audio.addEventListener('volumechange', () => {
    const silent = audio.muted || audio.volume === 0;
    volume.value = String(audio.volume);
    mute.setAttribute('aria-pressed', String(silent));
    mute.setAttribute('aria-label', silent ? '取消静音' : '静音');
    find('[data-volume-icon]').hidden = silent;
    find('[data-muted-icon]').hidden = !silent;
  }, options);
  for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'emptied']) audio.addEventListener(event, syncTime, options);
  for (const event of ['play', 'pause', 'ended']) audio.addEventListener(event, syncPlay, options);
  audio.addEventListener('playing', () => message(), options);
  audio.addEventListener('waiting', () => { if (!audio.paused) message('正在缓冲…'); }, options);
  audio.addEventListener('error', () => { pending = false; syncPlay(); syncTime(); message('无法播放这首音乐，请重试或切换下一首。'); }, options);
  audio.addEventListener('ended', () => { if (index < tracks.length - 1) select(index + 1, true); }, options);
  disposers.push(() => { generation++; controller.abort(); audio.pause(); audio.removeAttribute('src'); audio.load(); });
}
window.addEventListener('astro:before-swap', () => disposers.forEach(dispose => dispose()), { once: true });
import.meta.hot?.dispose(() => disposers.forEach(dispose => dispose()));
