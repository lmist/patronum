/** Runs in the post page. Keep this function self-contained for serialization. */
export function collectPostMedia(input: { shortcode: string; cover?: string | null }) {
  const sc = (value: string) => value.match(/\/(?:p|reels?|tv)\/([\w-]+)/)?.[1];
  const asset = (value: string) => { try { return new URL(value, location.href).pathname; } catch { return ""; } };
  const file = (value: string) => asset(value).split("/").pop() || "";
  const http = (value: unknown): value is string => typeof value === "string" && /^https?:\/\//i.test(value);
  const srcOf = (el: HTMLImageElement | HTMLVideoElement | HTMLSourceElement) => {
    const current = "currentSrc" in el ? el.currentSrc : "";
    const src = "src" in el ? el.src : "";
    const set = el.getAttribute("srcset")?.split(/[\s,]/).find((s) => /^https?:/i.test(s)) || "";
    const candidates = [current, src, el.getAttribute("src") || "", set];
    return candidates.find(http) || candidates.find(Boolean) || "";
  };
  const avatar = (value: string) => {
    try { return /profile_pic/i.test(atob(new URL(value).searchParams.get("efg") || "")) || /\/t\d+\.[\d]+-19\//.test(value); } catch { return false; }
  };
  const foreign = (el: Element) => {
    const link = el.closest('a[href]');
    const code = link && sc(link.getAttribute('href') || "");
    return !!code && code !== input.shortcode;
  };
  const visible = (el: Element) => {
    let box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    let left=box.left, right=box.right, top=box.top, bottom=box.bottom;
    for (let parent: Element | null=el; parent; parent=parent.parentElement) {
      const style=getComputedStyle(parent);
      if (style.display==='none' || style.visibility==='hidden') return false;
      box=parent.getBoundingClientRect();
      if (/hidden|clip|scroll|auto/.test(style.overflowX)) {left=Math.max(left,box.left);right=Math.min(right,box.right);}
      if (/hidden|clip|scroll|auto/.test(style.overflowY)) {top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);}
    }
    return right>left && bottom>top;
  };
  const px = (el: HTMLImageElement | HTMLVideoElement) => Math.max(Number(el.getAttribute("width")) || 0, "naturalWidth" in el ? el.naturalWidth || 0 : 0);
  const small = (el: HTMLImageElement | HTMLVideoElement) => {
    const shown = Math.max(el.getBoundingClientRect().width, el.getBoundingClientRect().height);
    return (shown || px(el)) < 200;
  };
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || document.querySelector('meta[property="og:url"]')?.getAttribute('content') || "";
  if (sc(location.pathname) !== input.shortcode && sc(canonical) !== input.shortcode) return null;
  const coverPath = asset(input.cover || "");
  const coverFile = file(input.cover || "");
  const images = [...document.querySelectorAll<HTMLImageElement>('img')];
  const ownedImg = (el: HTMLImageElement) => {
    const value = srcOf(el);
    return http(value) && !foreign(el) && !avatar(value) && !/profile picture/i.test(el.alt) && !/sprite|static.*rsrc|favicon|emoji/i.test(value);
  };
  const matchesCover = (el: HTMLImageElement) => {
    if (foreign(el)) return false;
    const value = srcOf(el);
    return (!!coverPath && asset(value) === coverPath) || (!!coverFile && file(value) === coverFile);
  };
  const primary = images.find((el) => matchesCover(el) && visible(el)) ||
    images.find((el) => ownedImg(el) && visible(el) && !small(el)) ||
    images.find(matchesCover);
  const postLink = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].find(el => sc(el.href) === input.shortcode);
  const nextControl = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>('button, [role="button"]')].find((el) => {
    const labels = [el, ...el.querySelectorAll<HTMLElement>('[aria-label]')]
      .map((node) => node.getAttribute('aria-label') || '')
      .join(' ');
    return /\bnext\b/i.test(labels) && visible(el);
  });
  const climb = (start: Element | null) => {
    if (!start) return null;
    const close = start.closest('article, [role="dialog"]');
    if (close) return close;
    let root: Element | null = start.parentElement;
    for (let el = start.parentElement; el && !el.matches('main, body'); el = el.parentElement) {
      if ([...el.querySelectorAll<HTMLAnchorElement>('a[href]')].some(a => !!sc(a.href) && sc(a.href) !== input.shortcode)) break;
      root = el;
      if (nextControl(el)) break;
    }
    return root;
  };
  const marked = document.querySelector(`[data-patronum-post="${input.shortcode}"]`);
  // An early post link can mark a caption-only subtree before the hero mounts.
  // Recompute when a later visible owned image appears outside that subtree.
  const markedStale = !!(marked && primary && visible(primary) && !marked.contains(primary));
  if (markedStale) marked?.removeAttribute('data-patronum-post');
  let root: Element | null = (markedStale ? null : marked) || climb(primary ?? null) || climb(postLink ?? null);
  if (!root) {
    const video = [...document.querySelectorAll<HTMLVideoElement>('main video, article video')]
      .find((el) => !foreign(el) && visible(el) && !small(el));
    root = video?.closest('article, [role="dialog"]') || climb(video ?? null);
  }
  if (!root) {
    root = [...document.querySelectorAll('div, ul, section')].find((el) =>
      !!nextControl(el) &&
      ![...el.querySelectorAll<HTMLAnchorElement>('a[href]')].some(a => !!sc(a.href) && sc(a.href) !== input.shortcode) &&
      [...el.querySelectorAll<HTMLImageElement>('img')].some((im) => ownedImg(im) && !small(im)),
    ) || null;
  }
  const imgUrls: string[] = [];
  const videoUrls: string[] = [];
  const push = (arr: string[], value: unknown) => { if (http(value) && !arr.includes(value)) arr.push(value); };
  const pushMeta = () => {
    if (sc(canonical) !== input.shortcode && sc(location.pathname) !== input.shortcode) return;
    for (const el of document.querySelectorAll('meta[property="og:video"], meta[property="og:video:secure_url"], meta[property="og:video:url"]')) push(videoUrls, el.getAttribute('content'));
    push(imgUrls, document.querySelector('meta[property="og:image"]')?.getAttribute('content'));
  };
  if (root) {
    root.setAttribute('data-patronum-post', input.shortcode);
    for (const el of root.querySelectorAll<HTMLImageElement>('img')) {
      const value = srcOf(el);
      if (!ownedImg(el) || !visible(el) || small(el)) continue;
      push(imgUrls, value);
    }
    for (const el of root.querySelectorAll<HTMLVideoElement>('video')) {
      if (foreign(el) || !visible(el)) continue;
      try { el.muted = true; el.play().catch(() => {}); } catch {}
      push(videoUrls, srcOf(el));
      for (const source of el.querySelectorAll('source')) push(videoUrls, srcOf(source));
      push(imgUrls, el.poster);
    }
  }
  const domBacked = imgUrls.length > 0 || videoUrls.length > 0 || !!root?.querySelector('video');
  // A blob-backed <video> can have only a poster in DOM; canonical OG video is
  // still a post-scoped HTTP media URL. Do not add OG image to the slide walk.
  if (root?.querySelector('video') && !videoUrls.length) {
    for (const el of document.querySelectorAll('meta[property="og:video"], meta[property="og:video:secure_url"], meta[property="og:video:url"]')) {
      push(videoUrls, el.getAttribute('content'));
    }
  }
  if (!imgUrls.length && !videoUrls.length) pushMeta();
  if (!imgUrls.length && !videoUrls.length) return null;
  const metaCaption = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || null;
  const normalizedText = (value: string) => value.replace(/\s+/g, ' ').trim();
  const renderedText = (el: Element) => (el as HTMLElement).innerText || el.textContent || '';
  const ogBody = (metaCaption?.match(/:\s*["“]([\s\S]*)/)?.[1] || '').replace(/["”]\.?(?:\s*)$/, '');
  const fingerprint = normalizedText(ogBody).slice(0, 80).trim();
  const matchesPostCaption = (el: Element) => {
    const value = normalizedText(renderedText(el));
    return fingerprint ? value.includes(fingerprint) : value.length >= 8;
  };
  const heading = root?.querySelector('h1') || (root ? document.querySelector('main h1') : null);
  const spans = root && fingerprint ? [...document.querySelectorAll('main span[dir="auto"], main span')]
    .filter((el) => visible(el) && !foreign(el) && matchesPostCaption(el))
    .sort((a, b) => renderedText(a).length - renderedText(b).length) : [];
  const captionEl = heading && matchesPostCaption(heading) ? heading : spans[0] || null;
  const domCaption = captionEl ? renderedText(captionEl).trim() || null : null;
  const caption = domCaption || metaCaption;
  const timestamp = root?.querySelector('time[datetime]')?.getAttribute('datetime') || document.querySelector('time[datetime]')?.getAttribute('datetime') || null;
  const next = root ? nextControl(root) : undefined;
  return { mediaUrls:[...videoUrls,...imgUrls], videoUrls, imgUrls, caption, timestamp, isVideo:videoUrls.length>0 || !!root?.querySelector('video') || /\/reel\//.test(location.pathname), hasCarouselNext:!!next, domBacked, captionFromDom:!!domCaption };
}
