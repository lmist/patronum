import { test, expect } from 'bun:test';
import puppeteer from 'puppeteer-core';
import { harvestDetailMedia, clickCarouselNextDom, harvestCarouselAllSlides, waitForPostHydration, enrichOneItem } from './read-post.js';
import { harvestDom, itemsFromHarvest } from './scroll-grid.js';

test('post harvest excludes recommendations and avatars beneath main', async () => {
  const server = Bun.serve({port:0,hostname:'127.0.0.1',fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith('.svg')) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="red"/></svg>',{headers:{'content-type':'image/svg+xml'}});
    if (path === '/p/DELAYED/') {
      const origin = new URL(req.url).origin;
      return new Response(`<head><meta property="og:image" content="${origin}/cover.svg"><meta property="og:description" content="1,032 likes - preview"></head><body><script>
        setTimeout(() => {
          document.body.innerHTML = '<nav><a href="/direct/inbox/">Inbox</a></nav><main><div style="width:500px"><img id="slide" src="${origin}/first.svg" width="500"><button id="next" aria-label="Next">Next</button></div><section><h1>Hydrated full caption</h1></section></main>';
          document.querySelector('#next').onclick = () => {
            document.querySelector('#slide').src = '${origin}/second.svg';
            document.querySelector('#next').remove();
          };
        }, 5500);
      </script></body>`,{headers:{'content-type':'text/html'}});
    }
    return new Response(`<main><article><a href="/owner/"><img width="150" src="/avatar.svg"></a><a href="/p/POST_A/">Post</a><h1>Own caption</h1><img src="/a.svg" width="500"><time datetime="2026-09-08"></time></article><section><a href="/p/OTHER/"><img src="/recommendation.svg" width="800"></a><button aria-label="Next">Recommendations</button></section></main>`,{headers:{'content-type':'text/html'}});
  }});
  const browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try {
    const page=await browser.newPage();
    const origin=`http://127.0.0.1:${server.port}`;
    await page.goto(`${origin}/p/POST_A/`,{waitUntil:'networkidle0'});
    const result=await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0],{shortcode:'POST_A',cover:`${origin}/a.svg`});
    expect(result?.imgUrls).toEqual([`${origin}/a.svg`]);
    expect(result?.hasCarouselNext).toBe(false);
    expect(await clickCarouselNextDom(page as unknown as Parameters<typeof clickCarouselNextDom>[0])).toBe(false);

    // Carousel controls and media can exist without an article. Persist the
    // identified viewport as its first slide moves out of view.
    await page.setContent(`<main><div id="viewport" style="width:500px;overflow:hidden"><div id="slides" style="display:flex;width:1000px"><img src="${origin}/a.svg" width="500"><img src="${origin}/b.svg" width="500"></div><button aria-label="Next" onclick="document.querySelector('#slides').style.transform='translateX(-500px)';this.remove()">Next</button></div><a href="/p/OTHER/"><img src="${origin}/recommendation.svg" width="800"></a></main>`);
    await page.waitForFunction(() => [...document.images].every(im=>im.complete));
    const first=await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0],{shortcode:'POST_A',cover:`${origin}/a.svg`});
    expect(first?.imgUrls).toEqual([`${origin}/a.svg`]);
    expect(first?.hasCarouselNext).toBe(true);
    expect(await clickCarouselNextDom(page as unknown as Parameters<typeof clickCarouselNextDom>[0])).toBe(true);
    const second=await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0],{shortcode:'POST_A',cover:`${origin}/a.svg`});
    expect(second?.imgUrls).toEqual([`${origin}/b.svg`]);
    expect(second?.hasCarouselNext).toBe(false);

    // Instagram temporarily removes the control during a carousel transition.
    // The full walker must wait for the next owned slide instead of treating
    // the old image plus absent Next as the end of the carousel.
    await page.setContent(`<main><div id="post"><div id="viewport" style="width:500px;overflow:hidden"><img id="slide" src="${origin}/slide-1.svg" width="500"><button id="next" onclick="advance()"><svg aria-label="Next"></svg></button></div></div><a href="/p/OTHER/"><img src="${origin}/recommendation.svg" width="800"></a><script>
      const slides = ['slide-1.svg', 'slide-2.svg', 'slide-3.svg', 'slide-4.svg'];
      let index = 0;
      function renderNext() {
        if (index === slides.length - 1) return;
        const button = document.createElement('button');
        button.id = 'next';
        button.innerHTML = '<svg aria-label="Next"></svg>';
        button.onclick = advance;
        document.querySelector('#viewport').append(button);
      }
      function advance() {
        document.querySelector('#next')?.remove();
        setTimeout(() => {
          index++;
          document.querySelector('#slide').src = '${origin}/' + slides[index];
          setTimeout(renderNext, 650);
        }, 850);
      }
    </script>`);
    await page.waitForFunction(() => [...document.images].every(im=>im.complete));
    const allSlides = await harvestCarouselAllSlides(
      page as unknown as Parameters<typeof harvestCarouselAllSlides>[0],
      {shortcode:'POST_A',cover:`${origin}/slide-1.svg`},
      10,
    );
    expect(allSlides.mediaUrls).toEqual([
      `${origin}/slide-1.svg`,
      `${origin}/slide-2.svg`,
      `${origin}/slide-3.svg`,
      `${origin}/slide-4.svg`,
    ]);
    expect(allSlides.carouselMedia.map((item) => item.mediaUrl)).toEqual(allSlides.mediaUrls);
    expect(allSlides.mediaUrls).not.toContain(`${origin}/recommendation.svg`);
    expect(allSlides.traversalComplete).toBe(true);

    // Seeing two slides is not enough if Next remains and stops advancing.
    await page.setContent(`<main><div style="width:500px"><img id="slide" src="${origin}/slide-1.svg" width="500"><button aria-label="Next" onclick="if(!this.dataset.clicked){document.querySelector('#slide').src='${origin}/slide-2.svg';this.dataset.clicked='1'}">Next</button></div></main>`);
    await page.waitForFunction(() => [...document.images].every(im=>im.complete));
    const stalled = await harvestCarouselAllSlides(
      page as unknown as Parameters<typeof harvestCarouselAllSlides>[0],
      {shortcode:'POST_A',cover:`${origin}/slide-1.svg`},
      10,
      null,
      750,
    );
    expect(stalled.carouselMedia).toHaveLength(2);
    expect(stalled.traversalComplete).toBe(false);

    // OG metadata arrives first, but is only a preview. The post's media,
    // Next control and full caption mount later, outside the media viewport.
    await page.setContent(`<head><meta property="og:image" content="${origin}/cover.svg"><meta property="og:description" content="1,032 likes - partial caption"></head><main id="post"></main><script>
      setTimeout(() => {
        document.querySelector('#post').innerHTML = '<div id="viewport" style="width:500px"><img src="${origin}/slide-1.svg" width="500"><button aria-label="Next">Next</button></div><section><h1>Full post caption from the hydrated body</h1></section>';
      }, 3200);
    </script>`);
    const preview = await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0], {shortcode:'POST_A',cover:`${origin}/cover.svg`});
    expect(preview?.imgUrls).toEqual([`${origin}/cover.svg`]);
    expect(preview?.domBacked).toBe(false);
    expect(preview?.captionFromDom).toBe(false);
    const hydrated = await waitForPostHydration(page as unknown as Parameters<typeof waitForPostHydration>[0], {shortcode:'POST_A',cover:`${origin}/cover.svg`}, true, 8000);
    expect(hydrated?.domBacked).toBe(true);
    expect(hydrated?.hasCarouselNext).toBe(true);
    expect(hydrated?.captionFromDom).toBe(true);
    expect(hydrated?.caption).toBe('Full post caption from the hydrated body');

    // A post link can be marked before the hero mounts in a sibling subtree.
    await page.setContent(`<head><meta property="og:image" content="${origin}/cover.svg"></head><main><div id="caption"><a href="/p/POST_A/">Post</a><h1>Full sibling caption</h1></div><div id="hero"></div></main>`);
    const beforeHero = await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0], {shortcode:'POST_A',cover:`${origin}/cover.svg`});
    expect(beforeHero?.domBacked).toBe(false);
    await page.evaluate((base) => { document.querySelector('#hero')!.innerHTML = `<img src="${base}/hero.svg" width="500"><button aria-label="Next">Next</button>`; }, origin);
    await page.waitForFunction(() => [...document.images].every(im=>im.complete));
    const afterHero = await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0], {shortcode:'POST_A',cover:`${origin}/cover.svg`});
    expect(afterHero?.imgUrls).toEqual([`${origin}/hero.svg`]);
    expect(afterHero?.hasCarouselNext).toBe(true);
    expect(afterHero?.caption).toBe('Full sibling caption');

    const firstLine = 'MEMBER BOOK - STUDIO108 BY @helloslint 🧘🏻';
    const body = 'Congratulations on a thoughtful identity with calm typography, clear structure, and warm details across every page.';
    const fullSpanCaption = `${firstLine}\n\n${body}`;
    await page.setContent(`<head><meta property="og:description" content='1,032 likes, 9 comments - designerbriefs on September 14, 2026: "${firstLine} ${body.slice(0, 90)}"'></head><main><article><img src="${origin}/hero.svg" width="500"></article><section><span dir="auto">MEMBER BOOK - STUDIO108 BY <a href="/helloslint/">@helloslint</a> 🧘🏻<br><br>${body}</span></section></main>`);
    await page.waitForFunction(() => [...document.images].every(im=>im.complete));
    const spanCaption = await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0], {shortcode:'POST_A',cover:`${origin}/hero.svg`});
    expect(spanCaption?.caption).toBe(fullSpanCaption);
    expect(spanCaption?.captionFromDom).toBe(true);

    await page.setContent(`<head><meta property="og:description" content='1 like - designerbriefs on September 14, 2026: "Hi"'></head><main><article><img src="${origin}/hero.svg" width="500"></article><span dir="auto">2 hours ago</span><span dir="auto">Hi</span></main>`);
    const shortCaption = await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0], {shortcode:'POST_A',cover:`${origin}/hero.svg`});
    expect(shortCaption?.caption).toBe('Hi');
    expect(shortCaption?.captionFromDom).toBe(true);
    await page.setContent(`<main><article><img src="${origin}/hero.svg" width="500"></article><span dir="auto">2 hours ago</span></main>`);
    const noFingerprint = await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0], {shortcode:'POST_A',cover:`${origin}/hero.svg`});
    expect(noFingerprint?.caption).toBeNull();
    expect(noFingerprint?.captionFromDom).toBe(false);

    // Exercise the whole detail chain: the first auth probe sees an empty body,
    // then the same tab hydrates a logged-in shell, carousel and full caption.
    const detailStagehand = { context: { cookies: async () => [] } } as unknown as Parameters<typeof enrichOneItem>[0];
    const detail = await enrichOneItem(detailStagehand, page as unknown as Parameters<typeof enrichOneItem>[1], {
      shortcode: 'DELAYED', type: 'carousel', permalink: `${origin}/p/DELAYED/`,
      mediaUrls: [`${origin}/cover.svg`], thumbnailUrl: `${origin}/cover.svg`,
    }, 0, 1, []);
    expect(detail.item.mediaOwnershipVersion).toBe(1);
    expect(detail.item.carouselComplete).toBe(true);
    expect(detail.item.carouselMedia).toHaveLength(2);
    expect(detail.item.caption).toBe('Hydrated full caption');

    await page.goto(`${origin}/p/POST_A/`, {waitUntil:'domcontentloaded'});
    await page.setContent(`<main><article><a href="/p/POST_A/">Post</a><video width="500" height="500" poster="${origin}/a.svg"><source src="${origin}/own.mp4"></video></article><video src="${origin}/other.mp4"></video><script type="application/json">{"video_url":"${origin}/other.mp4"}</script></main>`);
    const video=await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0],{shortcode:'POST_A'});
    expect(video?.videoUrls).toEqual([`${origin}/own.mp4`]);

    await page.setContent(`<head><meta property="og:video" content="${origin}/owned-og.mp4"></head><main><article><video width="500" height="500" src="blob:fixture" poster="${origin}/a.svg"></video></article></main>`);
    const blobVideo=await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0],{shortcode:'POST_A'});
    expect(blobVideo?.videoUrls).toEqual([`${origin}/owned-og.mp4`]);
    expect(blobVideo?.imgUrls).toEqual([`${origin}/a.svg`]);
    expect(blobVideo?.domBacked).toBe(true);

    await page.setContent(`<main><a href="/p/OTHER/"><img src="${origin}/recommendation.svg" width="800"></a></main>`);
    expect(await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0],{shortcode:'POST_A',cover:`${origin}/missing.svg`})).toBeNull();

    // Username/p/pages often have no article or dialog. Cover CDN path can
    // differ from the in-page file; still identify the unlinked post image and
    // the carousel Next that sits with it, not the recommendation Next.
    await page.setContent(`<main><div id="viewport" style="width:500px;overflow:hidden"><img src="${origin}/t51/a.svg" width="500"><button aria-label="Next">Next</button></div><a href="/p/OTHER/"><img src="${origin}/recommendation.svg" width="800"></a><button aria-label="Next">More</button></main>`);
    await page.waitForFunction(() => [...document.images].every(im=>im.complete));
    const noArticle=await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0],{shortcode:'POST_A',cover:`${origin}/t39/a.svg`});
    expect(noArticle?.imgUrls).toEqual([`${origin}/t51/a.svg`]);
    expect(noArticle?.hasCarouselNext).toBe(true);

    await page.setContent(`<main><div id="viewport" style="width:500px"><img src="${origin}/a.svg" width="500"></div><a href="/p/OTHER/"><img src="${origin}/recommendation.svg" width="800"></a></main>`);
    await page.waitForFunction(() => [...document.images].every(im=>im.complete));
    const noCover=await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0],{shortcode:'POST_A',cover:`${origin}/missing.svg`});
    expect(noCover?.imgUrls).toEqual([`${origin}/a.svg`]);

    await page.setContent(`<head><link rel="canonical" href="${origin}/p/POST_A/"><meta property="og:image" content="${origin}/a.svg"><meta property="og:description" content="Lobby caption"></head><main><a href="/p/OTHER/"><img src="${origin}/recommendation.svg" width="800"></a></main>`);
    const meta=await harvestDetailMedia(page as unknown as Parameters<typeof harvestDetailMedia>[0],{shortcode:'POST_A'});
    expect(meta?.imgUrls).toEqual([`${origin}/a.svg`]);
    expect(meta?.caption).toBe('Lobby caption');
    expect(meta?.hasCarouselNext).toBe(false);

    // A collaborator-authored post shown in the target's main profile grid is
    // retained; an unrelated recommendation outside that grid is not.
    await page.goto(`${origin}/designerbriefs/`, {waitUntil:'domcontentloaded'});
    await page.setContent(`<main><a href="/collaborator/p/COLLAB/"><img src="${origin}/collab.svg" width="500"></a></main><aside><a href="/stranger/p/OTHER/"><img src="${origin}/recommendation.svg" width="500"></a></aside>`);
    await page.waitForFunction(() => [...document.images].every(im=>im.complete));
    const grid = await harvestDom(page as unknown as Parameters<typeof harvestDom>[0]);
    expect(itemsFromHarvest(grid, 'all', 'designerbriefs').map(item => item.shortcode)).toEqual(['COLLAB']);
    expect(itemsFromHarvest(grid, 'all', 'designerbriefs')[0]?.fromProfileGrid).toBe(true);
  } finally {await browser.close();server.stop(true);}
}, 75000);
